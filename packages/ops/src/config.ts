/**
 * The operator surface's configuration, and the fail-closed check over it.
 *
 * Built the way `packages/governor/src/config.ts` is built, for the same
 * reason: CLAUDE.md rule 8 says ceilings and thresholds must exist, be
 * conservative and be configurable, and that no number may be invented here and
 * then treated as decided. So there is no default in this file. A document that
 * is absent, unparseable or short of a required value makes the caller refuse,
 * naming the key.
 *
 * ONE VALUE IS DELIBERATELY OPTIONAL. A source's staleness ceiling may be
 * missing, and that is not a load failure: it is a refusal at the moment that
 * source's health is asked for, naming the source and the setting. A whole
 * document that would not load because one source was added without a ceiling
 * would take the other sources' health down with it.
 */

import { readFileSync } from "node:fs";

import { OpsConfigError } from "./errors.ts";

export type DashboardSettings = {
  /** How far back the counts and the price series on the page reach. */
  windowMs: number;
  /** The IANA zone every instant on the page is shown in, named beside it. */
  timeZone: string;
  /** Where the page is written, relative to the repository root. */
  outputPath: string;
};

export type OpsSourceSettings = {
  /**
   * How old this source's newest successful request may be before the source
   * is broken. Absent is legal here and refused at the point of use.
   */
  stalenessCeilingMs?: number;
};

export type OpsConfig = {
  dashboard: DashboardSettings;
  sources: Record<string, OpsSourceSettings>;
};

/** The key a refusal names when a source carries no ceiling. */
export function stalenessCeilingSetting(sourceId: string): string {
  return `sources["${sourceId}"].stalenessCeilingMs`;
}

export function parseOpsConfig(text: string, origin: string): OpsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpsConfigError(
      `${origin} is not parseable as JSON, so nothing here knows what to draw ` +
        `or how stale is too stale: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
  return validateOpsConfig(raw, origin);
}

export function loadOpsConfig(path: string): OpsConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new OpsConfigError(
      `the operator configuration at ${path} could not be read, so the ` +
        "dashboard refuses to draw rather than draw on a built-in default: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseOpsConfig(text, path);
}

export function validateOpsConfig(
  raw: unknown,
  origin = "the operator configuration",
): OpsConfig {
  const root = requireObject(raw, "", origin);
  const dashboardNode = requireObject(
    requireKey(root, "dashboard", origin),
    "dashboard",
    origin,
  );

  const dashboard: DashboardSettings = {
    windowMs: requireInteger(dashboardNode, "dashboard.windowMs", origin, 1),
    timeZone: requireNonEmptyString(dashboardNode, "dashboard.timeZone", origin),
    outputPath: requireNonEmptyString(dashboardNode, "dashboard.outputPath", origin),
  };
  rejectUnknownKeys(dashboardNode, "dashboard", origin, [
    "windowMs",
    "timeZone",
    "outputPath",
  ]);
  requireKnownTimeZone(dashboard.timeZone, origin);

  const sourcesNode = requireObject(
    requireKey(root, "sources", origin),
    "sources",
    origin,
  );
  const sources: Record<string, OpsSourceSettings> = {};
  for (const [name, value] of visibleEntries(sourcesNode)) {
    const path = `sources["${name}"]`;
    const entry = requireObject(value, path, origin);
    const settings: OpsSourceSettings = {};
    if (entry.stalenessCeilingMs !== undefined) {
      settings.stalenessCeilingMs = requireInteger(
        entry,
        `${path}.stalenessCeilingMs`,
        origin,
        1,
      );
    }
    rejectUnknownKeys(entry, path, origin, ["stalenessCeilingMs"]);
    sources[name] = settings;
  }

  rejectUnknownKeys(root, "", origin, ["dashboard", "sources"]);
  return { dashboard, sources };
}

/**
 * An IANA name the runtime actually knows. A zone nobody recognises would put
 * every instant on the page in whatever the host machine happens to be set to,
 * which is the one thing a stamped instant may never be.
 */
function requireKnownTimeZone(timeZone: string, origin: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new OpsConfigError(
      `${origin}: dashboard.timeZone is ${JSON.stringify(timeZone)}, which this ` +
        "runtime does not recognise as an IANA time zone.",
    );
  }
}

/** Keys beginning with `_` are comments, as in every other config file here. */
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
    throw new OpsConfigError(
      `${origin} carries an unrecognised key ${path === "" ? key : `${path}.${key}`}. ` +
        "Nothing here has a default, so an unrecognised key is a value that was " +
        "meant to change what is drawn and silently did not.",
    );
  }
}

function requireKey(
  node: Record<string, unknown>,
  key: string,
  origin: string,
): unknown {
  if (!(key in node) || node[key] === undefined || node[key] === null) {
    throw new OpsConfigError(
      `${origin} is missing the required key "${key}". There is no built-in ` +
        "default for it, so this refuses rather than drawing one.",
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
    throw new OpsConfigError(
      `${origin}: ${path === "" ? "the document" : path} must be a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  node: Record<string, unknown>,
  path: string,
  origin: string,
): string {
  const value = requireKey(node, leaf(path), origin);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OpsConfigError(`${origin}: ${path} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(
  node: Record<string, unknown>,
  path: string,
  origin: string,
  min: number,
): number {
  const value = requireKey(node, leaf(path), origin);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new OpsConfigError(`${origin}: ${path} must be a whole number.`);
  }
  if (value < min) {
    throw new OpsConfigError(`${origin}: ${path} must be at least ${min} (got ${value}).`);
  }
  return value;
}

function leaf(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? path : path.slice(lastDot + 1);
}
