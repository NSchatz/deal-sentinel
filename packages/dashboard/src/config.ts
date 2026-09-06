/**
 * The dashboard configuration, and the fail-closed check over it.
 *
 * NO DEFAULT EXISTS ANYWHERE IN THIS FILE, for the reason
 * `packages/governor/src/config.ts` gives at length and CLAUDE.md rule 8 states
 * directly: "Rate ceilings, thresholds and cooldowns must exist, be
 * conservative, and be configurable. The brief deliberately fixes no numbers; do
 * not invent one and then treat it as decided." Three numbers here decide what
 * an owner is shown and would each be a decision hidden in code:
 *
 *   - THE STALENESS HORIZON. How old a source's last successful fetch may be
 *     before the page says BROKEN. Set it too long and a dead source reads as
 *     quiet, which is the failure the roadmap phase's own fail-safe names; set
 *     it too short and every source reads broken and nobody looks again. Nobody
 *     has lived with this system long enough to know the number, so nobody in
 *     this repository gets to write one down as decided.
 *   - THE RATE PERIOD. What "the success, error and block rates" are computed
 *     over on the overview.
 *   - THE DEFAULT CHART RANGE. How much of a listing's history a chart shows
 *     before anybody has asked for a different range.
 *
 * And one address:
 *
 *   - THE BIND ADDRESS. This is the FIRST listening socket this system has ever
 *     had, on a machine whose residential IP the whole household depends on, and
 *     the display path behind it can show a vendor's refusal detail - which is
 *     derived from a URL that carries a credential in its query string. The
 *     committed file names a LOOPBACK address. What the loader ENFORCES is that
 *     the value names ONE address and that the one it names is not the
 *     unspecified address, which is every address the machine has, including the
 *     one the rest of the world can reach. That question is decided from the
 *     address's BYTES by `address.ts` and never from its text, because the
 *     unspecified address has a dozen spellings this runtime binds identically
 *     and a list of them closes only the ones somebody thought of. A specific
 *     non-loopback address is permitted, because the owner is entitled to put
 *     this on their own LAN deliberately, and the start check says out loud when
 *     the configured address is not loopback.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isLoopback, parseIpAddress, stripBrackets, unspecifiedFamily } from "./address.ts";
import { DashboardConfigError } from "./errors.ts";

/** The committed configuration, beside the governor's, the sources' and the alerts'. */
export const DEFAULT_DASHBOARD_CONFIG_PATH = fileURLToPath(
  new URL("../../../config/dashboard.json", import.meta.url),
);

export type DashboardConfig = {
  /**
   * The single address the server binds, as a literal IP address with any
   * surrounding brackets removed. Never the unspecified address, in either
   * family and in any spelling of it.
   */
  bindAddress: string;
  /** The port it binds. */
  port: number;
  /**
   * How old a source's most recent successful fetch may be before that source
   * reads as BROKEN. No default: see the header.
   */
  stalenessHorizonMs: number;
  /** The period the per-source rates on the overview are computed over. */
  ratePeriodMs: number;
  /** How much of a listing's history a chart shows when nobody asked for a range. */
  defaultChartRangeMs: number;
  /** How many recent conditions, pauses and stops a source's detail shows. */
  conditionHistoryLimit: number;
};

/** Read and validate the configuration file. Throws `DashboardConfigError`. */
export function loadDashboardConfig(
  path: string = DEFAULT_DASHBOARD_CONFIG_PATH,
): DashboardConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new DashboardConfigError(
      `the dashboard configuration at ${path} could not be read, so there is ` +
        "no address to bind, no staleness horizon and no chart range, and " +
        "nothing here has a built-in default to fall back on. The dashboard " +
        "does not start: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDashboardConfig(text, path);
}

/** Parse and validate configuration text. Throws `DashboardConfigError`. */
export function parseDashboardConfig(
  text: string,
  origin: string,
): DashboardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new DashboardConfigError(
      `${origin} is not parseable as JSON, so nothing in it names an address, ` +
        "a port or a horizon. The dashboard does not start: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateDashboardConfig(raw, origin);
}

export function validateDashboardConfig(
  raw: unknown,
  origin = "the dashboard configuration",
): DashboardConfig {
  const root = requireObject(raw, "", origin);

  const config: DashboardConfig = {
    bindAddress: readBindAddress(root, origin),
    port: requireInteger(root, "port", origin, { min: 1, max: 65_535 }),
    stalenessHorizonMs: requireInteger(root, "stalenessHorizonMs", origin, {
      min: 1,
    }),
    ratePeriodMs: requireInteger(root, "ratePeriodMs", origin, { min: 1 }),
    defaultChartRangeMs: requireInteger(root, "defaultChartRangeMs", origin, {
      min: 1,
    }),
    conditionHistoryLimit: requireInteger(root, "conditionHistoryLimit", origin, {
      min: 1,
      max: 1000,
    }),
  };

  rejectUnknownKeys(root, "", origin, [
    "bindAddress",
    "port",
    "stalenessHorizonMs",
    "ratePeriodMs",
    "defaultChartRangeMs",
    "conditionHistoryLimit",
  ]);

  return config;
}

/**
 * Is this a loopback address? Every address in 127.0.0.0/8 is, so is `::1`, and
 * so is the IPv4-mapped form of either - decided from the bytes, like every
 * other question this file asks about an address.
 *
 * Reported rather than enforced: see the header. What IS enforced is that the
 * address names one address and that it is not the unspecified one.
 */
export function isLoopbackAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  return parsed !== null && isLoopback(parsed);
}

/**
 * The one address this process will bind, or a refusal.
 *
 * Two refusals, in this order, because they are two different mistakes and each
 * deserves its own sentence: the value names EVERY address, or it names no
 * address this loader can pin to an interface.
 */
function readBindAddress(node: Record<string, unknown>, origin: string): string {
  const given = requireNonEmptyString(node, "bindAddress", origin);
  const address = stripBrackets(given);

  const wildcard = unspecifiedFamily(address);
  if (wildcard !== null) {
    throw new DashboardConfigError(
      `${origin}: bindAddress is ${JSON.stringify(given)}, which is the ` +
        `unspecified ${wildcard === "ipv4" ? "IPv4" : "IPv6"} address however ` +
        "it is spelled, so it is not an address - it is every address this " +
        "machine has. This process serves a display path that can show a " +
        "vendor's refusal detail, and a refusal detail is derived from a URL " +
        "carrying a credential in its query string. Name one address. The " +
        "committed file names a loopback one.",
      { setting: "bindAddress" },
    );
  }

  if (parseIpAddress(address) === null) {
    throw new DashboardConfigError(
      `${origin}: bindAddress is ${JSON.stringify(given)}, which is not a ` +
        "literal IP address. This process binds what the configuration names " +
        "and nothing else, so a name is refused rather than resolved: what a " +
        "resolver answers at listen time is not what the file said, and it can " +
        "be every address this machine has. Write the address itself, in " +
        "dotted-quad or ordinary IPv6 form. The committed file names a " +
        "loopback one.",
      { setting: "bindAddress" },
    );
  }

  return address;
}

/* -------------------------------------------------------------------------- */
/* Readers, in the shape `packages/governor/src/config.ts` already uses         */
/* -------------------------------------------------------------------------- */

/** Keys beginning with `_` are comments. JSON has none; this file needs them. */
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
    if (known.includes(key)) continue;
    const setting = path.length === 0 ? key : `${path}.${key}`;
    throw new DashboardConfigError(
      `${origin} carries an unrecognised key ${setting}. Nothing here has a ` +
        "default, so an unrecognised key is a value that was meant to change " +
        "what the owner is shown and silently did not.",
      { setting },
    );
  }
}

function requireObject(
  value: unknown,
  path: string,
  origin: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DashboardConfigError(
      `${origin}: ${path.length === 0 ? "the document" : path} must be a JSON ` +
        `object (got ${describe(value)}).`,
      { setting: path.length === 0 ? null : path },
    );
  }
  return value as Record<string, unknown>;
}

function requireKey(
  node: Record<string, unknown>,
  key: string,
  origin: string,
): unknown {
  if (!(key in node) || node[key] === undefined || node[key] === null) {
    throw new DashboardConfigError(
      `${origin} is missing the required key "${key}". Nothing here has a ` +
        "built-in default, so the dashboard does not start.",
      { setting: key },
    );
  }
  return node[key];
}

function requireNonEmptyString(
  node: Record<string, unknown>,
  key: string,
  origin: string,
): string {
  const value = requireKey(node, key, origin);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DashboardConfigError(
      `${origin}: ${key} must be a non-empty string (got ${describe(value)}).`,
      { setting: key },
    );
  }
  return value.trim();
}

function requireInteger(
  node: Record<string, unknown>,
  key: string,
  origin: string,
  bounds: { min?: number; max?: number },
): number {
  const value = requireKey(node, key, origin);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DashboardConfigError(
      `${origin}: ${key} must be a whole number (got ${describe(value)}).`,
      { setting: key },
    );
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new DashboardConfigError(
      `${origin}: ${key} must be at least ${bounds.min} (got ${value}).`,
      { setting: key },
    );
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new DashboardConfigError(
      `${origin}: ${key} must be at most ${bounds.max} (got ${value}).`,
      { setting: key },
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
