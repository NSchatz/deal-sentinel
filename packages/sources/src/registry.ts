/**
 * The source registry: what the owner configured, checked against what each
 * source's own terms require.
 *
 * Same fail-closed rule as `packages/governor/src/config.ts`, and for the same
 * reason: there is NO DEFAULT anywhere in this file. A source that is missing a
 * required setting does not run, and the refusal names the source and the
 * setting. Three of those settings are worth saying why out loud, because each
 * one looks at first like something that could be inferred:
 *
 *   - THE CURRENCY. The vendor's documentation publishes no currency attribute
 *     anywhere. `salePrice: 7.99` is a number and nothing else, and "obviously
 *     USD" is a guess about a retailer that also operates in Canada and Mexico.
 *     An ISO 4217 code decides the minor-unit exponent, so guessing it wrong
 *     does not produce a wrong currency label on a right number - it produces a
 *     wrong NUMBER, silently, in a column no later reader can audit.
 *   - THE TIME ZONE. `timestamptz` does not retain the zone it was given, and a
 *     90-day low is anchored to the retailer's local day. The vendor publishes
 *     no zone either, and its own price-update timestamps carry no offset, so
 *     this one declaration is what turns them into instants at all.
 *   - THE RETENTION CEILING. A source whose terms cap how long its content may
 *     be cached, configured with no ceiling, would hold that content forever.
 *     "Absent" and "the terms said nothing" must not be the same document,
 *     which is why the terms live in `terms.ts` and not in the config file.
 *
 * The registry is also where the governor's numbers are checked against the
 * vendor's published ones, because a ceiling that exceeds what a vendor allows
 * is not a ceiling.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normaliseCurrency } from "@deal-sentinel/extractor";
import { hostKey } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { SourceConfigError } from "./errors.ts";
import { isValidTimeZone } from "./time-zone.ts";
import { termsFor } from "./terms.ts";
import type { SourceTerms } from "./terms.ts";

/** The committed source configuration, beside the governor's. */
export const DEFAULT_SOURCES_CONFIG_PATH = fileURLToPath(
  new URL("../../../config/sources.json", import.meta.url),
);

/** What must be attached to this source's content wherever it is emitted. */
export type AttributionRequirement = {
  required: boolean;
  /** The party the content is received from, e.g. "Best Buy". */
  attributeTo: string;
  /** The notice a display or export path carries. Names `attributeTo`. */
  notice: string;
};

/** One configured, terms-checked source. */
export type SourceEntry = {
  sourceId: string;
  /** The API root every request for this source is built under. */
  baseUrl: string;
  /** The host the governor keys this source's ceiling by. */
  host: string;
  /** ISO 4217 alphabetic code, upper case. */
  currency: string;
  /** IANA name, e.g. "America/New_York". */
  timeZone: string;
  /**
   * How long this source's raw content may be held, in hours, or null where its
   * terms declare no ceiling. Stamped onto every row this source writes.
   */
  rawContextRetentionHours: number | null;
  /** The environment variable the credential is read from. Never the value. */
  credentialVariable: string;
  attribution: AttributionRequirement;
  /** The terms this entry was checked against, or null where none are held. */
  terms: SourceTerms | null;
};

export type SourceRegistry = {
  readonly sources: Readonly<Record<string, SourceEntry>>;
  /** The entry for a source, or a refusal naming it. */
  require(sourceId: string): SourceEntry;
  /** Every configured source id, in the order the file declares them. */
  ids(): string[];
};

export function loadSourceRegistry(
  path: string = DEFAULT_SOURCES_CONFIG_PATH,
): SourceRegistry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SourceConfigError(
      `the source configuration at ${path} could not be read, so no source ` +
        "has a currency, a time zone or a retention ceiling and none of them " +
        `runs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseSourceRegistry(text, path);
}

export function parseSourceRegistry(text: string, origin: string): SourceRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SourceConfigError(
      `${origin} is not parseable as JSON, so nothing in it declares a ` +
        "retention ceiling, a currency or a time zone: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateSourceRegistry(raw, origin);
}

export function validateSourceRegistry(
  raw: unknown,
  origin = "the source configuration",
): SourceRegistry {
  const root = requireObject(raw, "", origin);
  const declared = requireObject(
    requireKey(root, "sources", origin, null),
    "sources",
    origin,
  );
  rejectUnknownKeys(root, "", origin, ["sources"], null);

  const sources: Record<string, SourceEntry> = {};
  for (const [sourceId, value] of visibleEntries(declared)) {
    sources[sourceId] = readSource(sourceId, value, origin);
  }

  if (Object.keys(sources).length === 0) {
    throw new SourceConfigError(
      `${origin} declares no entries under "sources". A run over no sources ` +
        "fetches nothing at all, so an empty map is far more likely to be a " +
        "truncated file than a deliberate choice.",
    );
  }

  return {
    sources,
    require(sourceId) {
      const entry = sources[sourceId];
      if (entry === undefined) {
        throw new SourceConfigError(
          `${sourceId} is not a configured source in ${origin}, so its ` +
            "currency, its local time zone, its retention ceiling and the " +
            "variable holding its credential are all unknown and it will not " +
            "run.",
          { sourceId, setting: `sources["${sourceId}"]` },
        );
      }
      return entry;
    },
    ids() {
      return Object.keys(sources);
    },
  };
}

function readSource(sourceId: string, value: unknown, origin: string): SourceEntry {
  const path = `sources["${sourceId}"]`;
  const node = requireObject(value, path, origin);
  const terms = termsFor(sourceId);

  const baseUrl = requireNonEmptyString(node, path, "baseUrl", origin, sourceId);
  const host = hostOf(baseUrl, sourceId, `${path}.baseUrl`, origin);

  const currencyText = requireNonEmptyString(node, path, "currency", origin, sourceId);
  const currency = normaliseCurrency(currencyText);
  if (currency === null) {
    throw new SourceConfigError(
      `${origin}: ${path}.currency is ${JSON.stringify(currencyText)}, which ` +
        "is not an ISO 4217 code this system resolves to a minor-unit " +
        `exponent. ${sourceId} will not run. The exponent decides whether ` +
        "12.99 is 1299 or 1299 is 12990, so an unresolved code is a wrong " +
        "number rather than a missing label, and it is never inferred.",
      { sourceId, setting: `${path}.currency` },
    );
  }

  const timeZone = requireNonEmptyString(node, path, "timeZone", origin, sourceId);
  if (!isValidTimeZone(timeZone)) {
    throw new SourceConfigError(
      `${origin}: ${path}.timeZone is ${JSON.stringify(timeZone)}, which is ` +
        `not an IANA time zone this runtime resolves. ${sourceId} will not ` +
        "run. The zone is stored beside every instant because a 90-day low is " +
        "anchored to the retailer's local day, and it is never inferred from " +
        "the host's own zone.",
      { sourceId, setting: `${path}.timeZone` },
    );
  }

  const credentialVariable = requireNonEmptyString(
    node,
    path,
    "credentialVariable",
    origin,
    sourceId,
  );

  const rawContextRetentionHours = readRetention(node, path, origin, sourceId, terms);
  const attribution = readAttribution(node, path, origin, sourceId, terms);

  rejectUnknownKeys(
    node,
    path,
    origin,
    [
      "baseUrl",
      "currency",
      "timeZone",
      "credentialVariable",
      "rawContextRetentionHours",
      "attributionNotice",
    ],
    sourceId,
  );

  return {
    sourceId,
    baseUrl,
    host,
    currency,
    timeZone,
    rawContextRetentionHours,
    credentialVariable,
    attribution,
    terms,
  };
}

/**
 * The retention ceiling, and the two refusals around it.
 *
 * A source whose terms declare a ceiling MUST carry one, because the
 * alternative is content stored under no ceiling at all - the exact outcome the
 * clause exists to prevent. A configured ceiling may be shorter than the terms
 * allow (holding less is always permitted) and may never be longer.
 */
function readRetention(
  node: Record<string, unknown>,
  path: string,
  origin: string,
  sourceId: string,
  terms: SourceTerms | null,
): number | null {
  const setting = `${path}.rawContextRetentionHours`;
  const value = node.rawContextRetentionHours;
  const ceiling = terms?.rawContentCeilingHours ?? null;

  if (value === undefined || value === null) {
    if (ceiling === null) return null;
    throw new SourceConfigError(
      `${origin}: ${sourceId} declares terms capping how long its content may ` +
        `be stored at ${ceiling} hours, and ${setting} is absent. ` +
        `${sourceId} will not run. Set ${setting} to a whole number of hours ` +
        `no greater than ${ceiling}; recording this source's content under no ` +
        "ceiling at all is the one outcome that clause forbids.",
      { sourceId, setting },
    );
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new SourceConfigError(
      `${origin}: ${setting} must be a whole number of hours of at least 1 ` +
        `(got ${describe(value)}). ${sourceId} will not run.`,
      { sourceId, setting },
    );
  }

  if (ceiling !== null && value > ceiling) {
    throw new SourceConfigError(
      `${origin}: ${setting} is ${value}, which is greater than the ${ceiling} ` +
        `hours ${sourceId}'s own published terms permit its content to be ` +
        `stored for. ${sourceId} will not run. A ceiling above the one the ` +
        "vendor published is not a ceiling.",
      { sourceId, setting },
    );
  }

  return value;
}

function readAttribution(
  node: Record<string, unknown>,
  path: string,
  origin: string,
  sourceId: string,
  terms: SourceTerms | null,
): AttributionRequirement {
  const setting = `${path}.attributionNotice`;
  const required = terms?.attributionRequired ?? false;
  const attributeTo = terms?.attributeTo ?? sourceId;
  const value = node.attributionNotice;

  if (value === undefined || value === null) {
    return { required, attributeTo, notice: `Content provided by ${attributeTo}` };
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SourceConfigError(
      `${origin}: ${setting} must be a non-empty string when it is present ` +
        `(got ${describe(value)}). ${sourceId} will not run.`,
      { sourceId, setting },
    );
  }

  if (required && !value.includes(attributeTo)) {
    throw new SourceConfigError(
      `${origin}: ${setting} is ${JSON.stringify(value)}, which does not name ` +
        `${JSON.stringify(attributeTo)}. ${sourceId}'s terms require its ` +
        "content to be clearly and conspicuously attributed to that party, " +
        "and a notice that does not name it attributes nothing. " +
        `${sourceId} will not run.`,
      { sourceId, setting },
    );
  }

  return { required, attributeTo, notice: value.trim() };
}

/* -------------------------------------------------------------------------- */
/* The governor's numbers, against the vendor's published ones                  */
/* -------------------------------------------------------------------------- */

export type DocumentedLimitCheck = {
  sourceId: string;
  host: string;
  /** The configured ceiling, expressed the way the vendor publishes it. */
  configuredCallsPerSecond: number;
  documentedCallsPerSecond: number;
  configuredCallsPerDay: number;
  documentedCallsPerDay: number;
};

/**
 * Assert that the governor is configured no faster and no larger than each
 * source's published limits, and that a metered source is actually metered.
 *
 * Two numbers bound the rate and BOTH are checked. `maxRequests / intervalMs`
 * is the window; `minDelayMs` is the floor on the gap between two consecutive
 * releases. A configuration can be inside one and outside the other - twenty
 * requests a minute with no delay between them is a burst of twenty in a second
 * - and the vendor's "calls per second" is violated by the burst.
 *
 * Refused rather than clamped. A clamp would mean the committed file says one
 * thing and the process does another, and the next person to read the file
 * would be reading a number that has not been true since it was written.
 */
export function assertGovernorWithinDocumentedLimits(
  registry: SourceRegistry,
  governor: GovernorConfig,
  origin = "the governor configuration",
): DocumentedLimitCheck[] {
  const checks: DocumentedLimitCheck[] = [];

  for (const sourceId of registry.ids()) {
    const entry = registry.sources[sourceId];
    const terms = entry.terms;
    if (terms === null) continue;
    if (terms.documentedCallsPerSecond === null && terms.documentedCallsPerDay === null) {
      continue;
    }

    const ceiling = governor.hosts[entry.host];
    if (ceiling === undefined) {
      throw new SourceConfigError(
        `${origin} carries no request ceiling for ${entry.host}, which is the ` +
          `host ${sourceId} fetches from. Every request to it would be ` +
          "refused by the governor's first gate, so the source cannot run. " +
          `Add hosts["${entry.host}"] deliberately, at or below the ` +
          `${terms.documentedCallsPerSecond ?? "documented"} calls per second ` +
          "the vendor publishes.",
        { sourceId, setting: `hosts["${entry.host}"]` },
      );
    }

    const settings = governor.sources[sourceId];
    if (settings === undefined) {
      throw new SourceConfigError(
        `${origin} carries no entry under sources["${sourceId}"], so the ` +
          "governor's second gate refuses every request it makes.",
        { sourceId, setting: `sources["${sourceId}"]` },
      );
    }

    const windowRate = (ceiling.maxRequests * 1000) / ceiling.intervalMs;
    const delayRate = 1000 / ceiling.minDelayMs;
    const configuredCallsPerSecond = Math.max(windowRate, delayRate);

    if (
      terms.documentedCallsPerSecond !== null &&
      configuredCallsPerSecond > terms.documentedCallsPerSecond
    ) {
      throw new SourceConfigError(
        `${origin}: hosts["${entry.host}"] permits up to ` +
          `${configuredCallsPerSecond} calls per second (${ceiling.maxRequests} ` +
          `per ${ceiling.intervalMs}ms, with a minimum delay of ` +
          `${ceiling.minDelayMs}ms between them), and ${sourceId}'s vendor ` +
          `publishes a limit of ${terms.documentedCallsPerSecond}. A ceiling ` +
          "above the published one is not a ceiling.",
        { sourceId, setting: `hosts["${entry.host}"]` },
      );
    }

    const allowance = settings.allowance;
    if (allowance === undefined) {
      throw new SourceConfigError(
        `${origin}: sources["${sourceId}"] carries no allowance, and its ` +
          `vendor publishes a limit of ${terms.documentedCallsPerDay} calls ` +
          "per day. An unmetered source counts nothing, so nothing stops a " +
          "crash loop inside one period from spending the whole free " +
          "allowance. Add an allowance at or below the published limit.",
        { sourceId, setting: `sources["${sourceId}"].allowance` },
      );
    }

    const configuredCallsPerDay = (allowance.limit * 86_400_000) / allowance.periodMs;
    if (
      terms.documentedCallsPerDay !== null &&
      configuredCallsPerDay > terms.documentedCallsPerDay
    ) {
      throw new SourceConfigError(
        `${origin}: sources["${sourceId}"].allowance permits ` +
          `${allowance.limit} calls per ${allowance.periodMs}ms, which is ` +
          `${configuredCallsPerDay} per day, and the vendor publishes a limit ` +
          `of ${terms.documentedCallsPerDay}.`,
        { sourceId, setting: `sources["${sourceId}"].allowance.limit` },
      );
    }

    checks.push({
      sourceId,
      host: entry.host,
      configuredCallsPerSecond,
      documentedCallsPerSecond: terms.documentedCallsPerSecond ?? Number.POSITIVE_INFINITY,
      configuredCallsPerDay,
      documentedCallsPerDay: terms.documentedCallsPerDay ?? Number.POSITIVE_INFINITY,
    });
  }

  return checks;
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
  sourceId: string | null,
): void {
  for (const [key] of visibleEntries(node)) {
    if (known.includes(key)) continue;
    const setting = path.length === 0 ? key : `${path}.${key}`;
    throw new SourceConfigError(
      `${origin} carries an unrecognised key ${setting}. Nothing here has a ` +
        "default, so an unrecognised key is a value that was meant to change " +
        "behaviour and silently did not.",
      { sourceId, setting },
    );
  }
}

function requireKey(
  node: Record<string, unknown>,
  key: string,
  origin: string,
  sourceId: string | null,
): unknown {
  if (!(key in node) || node[key] === undefined || node[key] === null) {
    throw new SourceConfigError(
      `${origin} is missing the required key "${key}". Nothing here has a ` +
        "built-in default, so the source it belongs to will not run.",
      { sourceId, setting: key },
    );
  }
  return node[key];
}

function requireObject(
  value: unknown,
  path: string,
  origin: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceConfigError(
      `${origin}: ${path.length === 0 ? "the document" : path} must be a JSON ` +
        `object (got ${describe(value)}).`,
    );
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  node: Record<string, unknown>,
  path: string,
  key: string,
  origin: string,
  sourceId: string,
): string {
  const setting = `${path}.${key}`;
  const value = node[key];
  if (value === undefined || value === null) {
    throw new SourceConfigError(
      `${origin}: ${setting} is absent, and ${sourceId} will not run without ` +
        "it. Nothing here has a built-in default.",
      { sourceId, setting },
    );
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SourceConfigError(
      `${origin}: ${setting} must be a non-empty string (got ` +
        `${describe(value)}). ${sourceId} will not run.`,
      { sourceId, setting },
    );
  }
  return value.trim();
}

function hostOf(
  baseUrl: string,
  sourceId: string,
  setting: string,
  origin: string,
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SourceConfigError(
      `${origin}: ${setting} is ${JSON.stringify(baseUrl)}, which is not an ` +
        `absolute URL. ${sourceId} will not run.`,
      { sourceId, setting },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceConfigError(
      `${origin}: ${setting} uses the ${url.protocol} scheme, and only http ` +
        `and https are fetched. ${sourceId} will not run.`,
      { sourceId, setting },
    );
  }
  return hostKey(url);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
