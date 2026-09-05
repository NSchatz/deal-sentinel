/**
 * The governor's configuration, and the fail-closed check over it.
 *
 * CLAUDE.md rule 8: "Rate ceilings, thresholds and cooldowns must exist, be
 * conservative, and be configurable. The brief deliberately fixes no numbers;
 * do not invent one and then treat it as decided." So there is no default
 * anywhere in this file. Every number the governor uses is read from
 * configuration, and a configuration that is absent, unparseable or short of a
 * required value makes the process REFUSE TO START, naming the key. Starting on
 * a built-in default is how a ceiling nobody chose becomes a ceiling nobody
 * knows about.
 *
 * Two bounds are not configurable in one direction, because a standard fixes
 * them:
 *
 *   - `robots.cacheBoundMs` may not exceed 24 hours (RFC 9309 2.4: "Crawlers
 *     SHOULD NOT use the cached version for more than 24 hours").
 *   - `robots.parsingLimitBytes` may not fall below 500 KiB, which is 512000
 *     bytes (RFC 9309 2.5: "The parsing limit MUST be at least 500 kibibytes").
 */

import { readFileSync } from "node:fs";

import { GovernorConfigError } from "./errors.ts";

/** RFC 9309 section 2.4: the cache of a robots.txt decision is bounded. */
export const ROBOTS_CACHE_BOUND_CEILING_MS = 24 * 60 * 60 * 1000;

/** RFC 9309 section 2.5: 500 kibibytes, in bytes. */
export const ROBOTS_PARSING_LIMIT_FLOOR_BYTES = 500 * 1024;

export type HostCeiling = {
  /** How many requests this host may be offered inside `intervalMs`. */
  maxRequests: number;
  intervalMs: number;
  /** The floor on the gap between two consecutive releases to this host. */
  minDelayMs: number;
  /** The width of the randomised part of that gap. At least 1: see below. */
  jitterMs: number;
};

export type BreakerSettings = {
  windowMs: number;
  /** Outcomes needed inside the window before a rate is meaningful at all. */
  minimumOutcomes: number;
  /** Error-or-block rate, in [0, 1], at which the source is paused. */
  failureRateThreshold: number;
  pauseMs: number;
};

export type AllowanceSettings = {
  /** Requests this source may issue in one period. */
  limit: number;
  periodMs: number;
  /** Fraction of `limit` at which the single warning is emitted. */
  warnFraction: number;
};

export type SourceSettings = {
  /** Absent means the source is not metered; nothing is counted for it. */
  allowance?: AllowanceSettings;
  /** Absent means the source uses the top-level breaker settings. */
  breaker?: BreakerSettings;
};

export type GovernorConfig = {
  /** The full User-Agent header this system sends. */
  userAgent: string;
  http: {
    requestTimeoutMs: number;
    maxResponseBytes: number;
  };
  /** Keyed by lower-case hostname, with no port: see `hostKey`. */
  hosts: Record<string, HostCeiling>;
  robots: {
    /** The product token matched against robots.txt user-agent lines. */
    productToken: string;
    cacheBoundMs: number;
    parsingLimitBytes: number;
  };
  backPressure: {
    /** Held for a 429 with no Retry-After, and for one that will not parse. */
    defaultBackoffMs: number;
  };
  breaker: BreakerSettings;
  sources: Record<string, SourceSettings>;
};

/**
 * The host a ceiling is keyed by: the lower-case hostname, WITHOUT the port.
 * Two ports on one host therefore share one ceiling, which is the conservative
 * direction (fewer requests to a machine, not more).
 */
export function hostKey(url: URL): string {
  return url.hostname.toLowerCase();
}

/** Parse and validate configuration text. Throws `GovernorConfigError`. */
export function parseGovernorConfig(
  text: string,
  origin: string,
): GovernorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new GovernorConfigError(
      `${origin} is not parseable as JSON, so there is no ceiling to enforce ` +
        `and no default to fall back on: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
  return validateGovernorConfig(raw, origin);
}

/** Read and validate a configuration file. Throws `GovernorConfigError`. */
export function loadGovernorConfig(path: string): GovernorConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new GovernorConfigError(
      `the governor configuration at ${path} could not be read, so the ` +
        "process refuses to start rather than fetch anything on a built-in " +
        `default: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseGovernorConfig(text, path);
}

export function validateGovernorConfig(
  raw: unknown,
  origin = "the governor configuration",
): GovernorConfig {
  const root = requireObject(raw, "", origin);

  const config: GovernorConfig = {
    userAgent: requireNonEmptyString(root, "userAgent", origin),
    http: readHttp(requireObject(requireKey(root, "http", origin), "http", origin), origin),
    hosts: readHosts(requireObject(requireKey(root, "hosts", origin), "hosts", origin), origin),
    robots: readRobots(
      requireObject(requireKey(root, "robots", origin), "robots", origin),
      origin,
    ),
    backPressure: readBackPressure(
      requireObject(requireKey(root, "backPressure", origin), "backPressure", origin),
      origin,
    ),
    breaker: readBreaker(
      requireObject(requireKey(root, "breaker", origin), "breaker", origin),
      "breaker",
      origin,
    ),
    sources: readSources(
      requireObject(requireKey(root, "sources", origin), "sources", origin),
      origin,
    ),
  };

  rejectUnknownKeys(root, "", origin, [
    "userAgent",
    "http",
    "hosts",
    "robots",
    "backPressure",
    "breaker",
    "sources",
  ]);

  assertRobotsDecisionsCanOutliveTheDelay(config, origin);

  return config;
}

/**
 * A CROSS-FIELD rule: two values that are each legal alone can still describe a
 * governor that can never fetch anything under a robots decision it still
 * believes.
 *
 * `robots.cacheBoundMs` is this system's own statement of how long a decision
 * about a host stays true. `hosts[...].minDelayMs` is the floor on the gap
 * between two consecutive requests to that host - and the governor's own
 * `/robots.txt` retrieval is one of those requests, because the file that says
 * how polite to be is fetched politely. So the fetch behind a retrieval is
 * spaced from it by at least `minDelayMs`, and where that spacing is already as
 * long as the bound, EVERY fetch to that host leaves under a decision this
 * system has already declared expired. There is no ordering of the gates that
 * rescues it; the numbers are simply the wrong way round.
 *
 * Refused at load, naming both keys, rather than discovered as a governor that
 * quietly fetches under expired rules.
 */
function assertRobotsDecisionsCanOutliveTheDelay(
  config: GovernorConfig,
  origin: string,
): void {
  for (const [name, ceiling] of Object.entries(config.hosts)) {
    if (ceiling.minDelayMs < config.robots.cacheBoundMs) continue;
    throw new GovernorConfigError(
      `${origin}: hosts["${name}"].minDelayMs is ${ceiling.minDelayMs}, which is ` +
        `not less than robots.cacheBoundMs (${config.robots.cacheBoundMs}). The ` +
        "governor fetches a host's robots.txt through that same minimum delay, " +
        "so every request to this host would leave at least " +
        `${ceiling.minDelayMs}ms after the decision permitting it, and that ` +
        "decision expires after " +
        `${config.robots.cacheBoundMs}ms. Raise robots.cacheBoundMs (up to ` +
        `${ROBOTS_CACHE_BOUND_CEILING_MS}) or lower this host's minDelayMs.`,
    );
  }
}

function readHttp(
  node: Record<string, unknown>,
  origin: string,
): GovernorConfig["http"] {
  const http = {
    requestTimeoutMs: requireInteger(node, "http.requestTimeoutMs", origin, { min: 1 }),
    maxResponseBytes: requireInteger(node, "http.maxResponseBytes", origin, { min: 1 }),
  };
  rejectUnknownKeys(node, "http", origin, ["requestTimeoutMs", "maxResponseBytes"]);
  return http;
}

function readHosts(
  node: Record<string, unknown>,
  origin: string,
): Record<string, HostCeiling> {
  const hosts: Record<string, HostCeiling> = {};
  for (const [name, value] of visibleEntries(node)) {
    const path = `hosts["${name}"]`;
    const entry = requireObject(value, path, origin);
    const ceiling: HostCeiling = {
      maxRequests: requireInteger(entry, `${path}.maxRequests`, origin, { min: 1 }),
      intervalMs: requireInteger(entry, `${path}.intervalMs`, origin, { min: 1 }),
      // A delay of zero is not a "randomised delay", and a jitter of zero is a
      // constant. Both floors are 1 so that no configuration can switch off the
      // property the first acceptance criterion names.
      minDelayMs: requireInteger(entry, `${path}.minDelayMs`, origin, { min: 1 }),
      jitterMs: requireInteger(entry, `${path}.jitterMs`, origin, { min: 1 }),
    };
    rejectUnknownKeys(entry, path, origin, [
      "maxRequests",
      "intervalMs",
      "minDelayMs",
      "jitterMs",
    ]);
    hosts[name.toLowerCase()] = ceiling;
  }
  if (Object.keys(hosts).length === 0) {
    throw new GovernorConfigError(
      `${origin} declares no entries under "hosts". Every request is refused ` +
        "until a host carries a ceiling, so an empty map is far more likely to " +
        "be a truncated file than a deliberate choice.",
    );
  }
  return hosts;
}

function readRobots(
  node: Record<string, unknown>,
  origin: string,
): GovernorConfig["robots"] {
  const robots = {
    productToken: requireNonEmptyString(node, "robots.productToken", origin),
    cacheBoundMs: requireInteger(node, "robots.cacheBoundMs", origin, {
      min: 1,
      max: ROBOTS_CACHE_BOUND_CEILING_MS,
      maxReason:
        "RFC 9309 section 2.4 says a crawler SHOULD NOT use a cached " +
        "robots.txt for more than 24 hours, so this value is not " +
        "configurable above 86400000",
    }),
    parsingLimitBytes: requireInteger(node, "robots.parsingLimitBytes", origin, {
      min: ROBOTS_PARSING_LIMIT_FLOOR_BYTES,
      minReason:
        "RFC 9309 section 2.5 says the parsing limit MUST be at least 500 " +
        "kibibytes, so this value is not configurable below 512000",
    }),
  };
  rejectUnknownKeys(node, "robots", origin, [
    "productToken",
    "cacheBoundMs",
    "parsingLimitBytes",
  ]);
  return robots;
}

function readBackPressure(
  node: Record<string, unknown>,
  origin: string,
): GovernorConfig["backPressure"] {
  const backPressure = {
    defaultBackoffMs: requireInteger(node, "backPressure.defaultBackoffMs", origin, {
      min: 1,
    }),
  };
  rejectUnknownKeys(node, "backPressure", origin, ["defaultBackoffMs"]);
  return backPressure;
}

function readBreaker(
  node: Record<string, unknown>,
  path: string,
  origin: string,
): BreakerSettings {
  const breaker: BreakerSettings = {
    windowMs: requireInteger(node, `${path}.windowMs`, origin, { min: 1 }),
    minimumOutcomes: requireInteger(node, `${path}.minimumOutcomes`, origin, { min: 1 }),
    failureRateThreshold: requireFraction(
      node,
      `${path}.failureRateThreshold`,
      origin,
    ),
    pauseMs: requireInteger(node, `${path}.pauseMs`, origin, { min: 1 }),
  };
  rejectUnknownKeys(node, path, origin, [
    "windowMs",
    "minimumOutcomes",
    "failureRateThreshold",
    "pauseMs",
  ]);
  return breaker;
}

function readSources(
  node: Record<string, unknown>,
  origin: string,
): Record<string, SourceSettings> {
  const sources: Record<string, SourceSettings> = {};
  for (const [name, value] of visibleEntries(node)) {
    const path = `sources["${name}"]`;
    const entry = requireObject(value, path, origin);
    const settings: SourceSettings = {};

    if (entry.allowance !== undefined) {
      const allowancePath = `${path}.allowance`;
      const allowance = requireObject(entry.allowance, allowancePath, origin);
      settings.allowance = {
        limit: requireInteger(allowance, `${allowancePath}.limit`, origin, { min: 1 }),
        periodMs: requireInteger(allowance, `${allowancePath}.periodMs`, origin, {
          min: 1,
        }),
        warnFraction: requireFraction(
          allowance,
          `${allowancePath}.warnFraction`,
          origin,
        ),
      };
      rejectUnknownKeys(allowance, allowancePath, origin, [
        "limit",
        "periodMs",
        "warnFraction",
      ]);
    }

    if (entry.breaker !== undefined) {
      settings.breaker = readBreaker(
        requireObject(entry.breaker, `${path}.breaker`, origin),
        `${path}.breaker`,
        origin,
      );
    }

    rejectUnknownKeys(entry, path, origin, ["allowance", "breaker"]);
    sources[name] = settings;
  }
  if (Object.keys(sources).length === 0) {
    throw new GovernorConfigError(
      `${origin} declares no entries under "sources". A source the governor ` +
        "has never heard of is refused, so an empty map fetches nothing at all.",
    );
  }
  return sources;
}

/**
 * Keys beginning with `_` are comments. JSON has none, and a committed defaults
 * file that cannot say "these numbers are unvalidated" beside the numbers is a
 * file whose provenance is lost the first time somebody copies it.
 */
function visibleEntries(node: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(node).filter(([key]) => !key.startsWith("_"));
}

function rejectUnknownKeys(
  node: Record<string, unknown>,
  path: string,
  origin: string,
  known: string[],
): void {
  for (const [key] of visibleEntries(node)) {
    if (!known.includes(key)) {
      throw new GovernorConfigError(
        `${origin} carries an unrecognised key ${qualify(path, key)}. ` +
          "Nothing in the governor has a default, so an unrecognised key is a " +
          "value that was meant to change behaviour and silently did not.",
      );
    }
  }
}

function qualify(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

function requireKey(
  node: Record<string, unknown>,
  key: string,
  origin: string,
): unknown {
  if (!(key in node) || node[key] === undefined || node[key] === null) {
    throw new GovernorConfigError(
      `${origin} is missing the required key "${key}". The governor has no ` +
        "built-in default for it, so the process refuses to start.",
    );
  }
  return node[key];
}

function requireObject(
  value: unknown,
  path: string,
  origin: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new GovernorConfigError(
      `${origin}: ${path.length === 0 ? "the document" : path} must be a JSON ` +
        `object (got ${describe(value)}).`,
    );
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  node: Record<string, unknown>,
  path: string,
  origin: string,
): string {
  const key = leaf(path);
  const value = requireKey(node, key, origin);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GovernorConfigError(
      `${origin}: ${path} must be a non-empty string (got ${describe(value)}).`,
    );
  }
  return value;
}

function requireInteger(
  node: Record<string, unknown>,
  path: string,
  origin: string,
  bounds: { min?: number; max?: number; minReason?: string; maxReason?: string },
): number {
  const key = leaf(path);
  const value = requireKey(node, key, origin);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GovernorConfigError(
      `${origin}: ${path} must be a whole number (got ${describe(value)}).`,
    );
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new GovernorConfigError(
      `${origin}: ${path} must be at least ${bounds.min} (got ${value})` +
        (bounds.minReason === undefined ? "." : ` - ${bounds.minReason}.`),
    );
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new GovernorConfigError(
      `${origin}: ${path} must be at most ${bounds.max} (got ${value})` +
        (bounds.maxReason === undefined ? "." : ` - ${bounds.maxReason}.`),
    );
  }
  return value;
}

function requireFraction(
  node: Record<string, unknown>,
  path: string,
  origin: string,
): number {
  const key = leaf(path);
  const value = requireKey(node, key, origin);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GovernorConfigError(
      `${origin}: ${path} must be a number (got ${describe(value)}).`,
    );
  }
  if (value <= 0 || value > 1) {
    throw new GovernorConfigError(
      `${origin}: ${path} must be a fraction greater than 0 and at most 1 ` +
        `(got ${value}).`,
    );
  }
  return value;
}

function leaf(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? path : path.slice(lastDot + 1);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
