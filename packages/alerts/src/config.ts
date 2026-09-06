/**
 * The alert configuration, and the fail-closed check over it.
 *
 * NO DEFAULT EXISTS ANYWHERE IN THIS FILE, for the reason
 * `packages/governor/src/config.ts` gives at length and CLAUDE.md rule 8 states
 * directly: "Rate ceilings, thresholds and cooldowns must exist, be
 * conservative, and be configurable. The brief deliberately fixes no numbers;
 * do not invent one and then treat it as decided." A window nobody chose, a
 * minimum nobody chose or a cooldown nobody chose would each be a number
 * deciding when the owner is interrupted, hidden in code. So a configuration
 * that is absent, unparseable or short of a required value makes the process
 * REFUSE TO START, naming the file and the setting, and nothing is evaluated
 * and nothing is delivered.
 *
 * TWO THINGS THIS SYSTEM DELIBERATELY DOES NOT DECIDE, and they are the whole
 * reason the file has the shape it has:
 *
 *   - WHICH CHANNEL. BRIEF.md section 9 leaves the notification channel open,
 *     and the roadmap phase's own fail-safe says no assertion depends on which
 *     one the owner picks. So the channel is an endpoint, a method, whatever
 *     static headers that endpoint wants, and a credential read from a named
 *     environment variable - the pattern `config/sources.json` already uses.
 *     The committed file carries NO endpoint, which means this system delivers
 *     nothing until the owner configures one. That is the fail-closed default.
 *   - WHICH PRICE ENDINGS MEAN CLEARANCE. The lore is unreliable by the brief's
 *     own account, so the endings are the operator's list and this system
 *     asserts none for any retailer. The committed file ships them empty.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AlertConfigError } from "./errors.ts";
import type { WindowLowRule } from "./rules.ts";

/** The committed configuration, beside the governor's and the sources'. */
export const DEFAULT_ALERTS_CONFIG_PATH = fileURLToPath(
  new URL("../../../config/alerts.json", import.meta.url),
);

/** Where the channel's credential is read from, and where it is put. */
export type AlertChannelCredential = {
  /** The environment variable holding it. Never the value. */
  variable: string;
  /** The header it travels in, e.g. "Authorization". */
  header: string;
  /** What precedes it in that header, e.g. "Bearer ". May be empty. */
  prefix: string;
};

export type AlertChannelConfig = {
  /** The absolute http(s) endpoint, or null for "no channel is configured". */
  endpoint: string | null;
  /** The lower-case hostname the governor keys this channel's ceiling by. */
  host: string | null;
  /** POST or PUT: a notification is a publish, not a question. */
  method: string;
  /** Static headers the endpoint wants, exactly as the operator wrote them. */
  headers: Record<string, string>;
  /** A header carrying the alert's one-line title, or null. */
  titleHeader: string | null;
  /** A header carrying the listing link, or null. */
  linkHeader: string | null;
  credential: AlertChannelCredential | null;
};

export type AlertConfig = {
  /**
   * The source id the channel spends against in `config/governor.json`. The
   * governor's second gate refuses a source it has never heard of, so this is
   * the name that must appear under `sources` there.
   */
  sourceId: string;
  /** Every configured rule, by the id a notification names. */
  rules: Record<string, WindowLowRule>;
  /** Operator-supplied clearance price endings, per source. Empty as shipped. */
  clearanceEndings: Record<string, string[]>;
  channel: AlertChannelConfig;
};

/** Read and validate the configuration file. Throws `AlertConfigError`. */
export function loadAlertConfig(path: string = DEFAULT_ALERTS_CONFIG_PATH): AlertConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new AlertConfigError(
      `the alert configuration at ${path} could not be read, so no rule has a ` +
        "window, a minimum or a cooldown and there is no built-in default to " +
        "fall back on. Nothing is evaluated and nothing is delivered: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseAlertConfig(text, path);
}

/** Parse and validate configuration text. Throws `AlertConfigError`. */
export function parseAlertConfig(text: string, origin: string): AlertConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new AlertConfigError(
      `${origin} is not parseable as JSON, so nothing in it configures a rule, ` +
        "a cooldown or a channel. Nothing is evaluated and nothing is " +
        `delivered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateAlertConfig(raw, origin);
}

export function validateAlertConfig(
  raw: unknown,
  origin = "the alert configuration",
): AlertConfig {
  const root = requireObject(raw, "", origin);

  const config: AlertConfig = {
    sourceId: requireNonEmptyString(root, "sourceId", origin),
    rules: readRules(
      requireObject(requireKey(root, "rules", origin), "rules", origin),
      origin,
    ),
    clearanceEndings: readClearanceEndings(
      requireObject(
        requireKey(root, "clearanceEndings", origin),
        "clearanceEndings",
        origin,
      ),
      origin,
    ),
    channel: readChannel(
      requireObject(requireKey(root, "channel", origin), "channel", origin),
      origin,
    ),
  };

  rejectUnknownKeys(root, "", origin, [
    "sourceId",
    "rules",
    "clearanceEndings",
    "channel",
  ]);

  return config;
}

function readRules(
  node: Record<string, unknown>,
  origin: string,
): Record<string, WindowLowRule> {
  const rules: Record<string, WindowLowRule> = {};

  for (const [ruleId, value] of visibleEntries(node)) {
    const path = `rules["${ruleId}"]`;
    const entry = requireObject(value, path, origin);

    const kind = requireNonEmptyString(entry, `${path}.kind`, origin);
    if (kind !== "window-low") {
      throw new AlertConfigError(
        `${origin}: ${path}.kind is ${JSON.stringify(kind)}, and the only rule ` +
          'kind this build implements is "window-low". A rule kind nothing ' +
          "evaluates is a rule the owner believes is running and is not.",
        { setting: `${path}.kind` },
      );
    }

    rules[ruleId] = {
      ruleId,
      kind: "window-low",
      windowMs: requireInteger(entry, `${path}.windowMs`, origin, { min: 1 }),
      minimumObservations: requireInteger(
        entry,
        `${path}.minimumObservations`,
        origin,
        // At least two: one observation inside a window is the observation's own
        // predecessor and nothing else, and "the lowest of one" is not a claim
        // about history. The assertion this floor serves is the one that stops
        // a listing added yesterday declaring an all-time low today.
        { min: 2 },
      ),
      improvementMinorUnits: BigInt(
        requireInteger(entry, `${path}.improvementMinorUnits`, origin, { min: 0 }),
      ),
      cooldownMs: requireInteger(entry, `${path}.cooldownMs`, origin, { min: 1 }),
    };

    rejectUnknownKeys(entry, path, origin, [
      "kind",
      "windowMs",
      "minimumObservations",
      "improvementMinorUnits",
      "cooldownMs",
    ]);
  }

  if (Object.keys(rules).length === 0) {
    throw new AlertConfigError(
      `${origin} declares no entries under "rules". Nothing would ever fire, so ` +
        "an empty map is far more likely to be a truncated file than a " +
        "deliberate choice; switch a rule off by removing the listing from the " +
        "watchlist or by widening its own numbers.",
      { setting: "rules" },
    );
  }

  return rules;
}

/**
 * The operator's clearance price endings, per source.
 *
 * An empty map is legal and is what this repository ships: no ending is
 * asserted for any retailer, and an unconfigured source simply has no endings.
 * Each ending is digits only, because it is matched against the decimal digits
 * of an integer minor-unit amount and anything else can never match - a setting
 * that silently cannot match is exactly what the unknown-key rule exists for.
 */
function readClearanceEndings(
  node: Record<string, unknown>,
  origin: string,
): Record<string, string[]> {
  const endings: Record<string, string[]> = {};

  for (const [sourceId, value] of visibleEntries(node)) {
    const path = `clearanceEndings["${sourceId}"]`;
    if (!Array.isArray(value)) {
      throw new AlertConfigError(
        `${origin}: ${path} must be an array of price endings (got ` +
          `${describe(value)}).`,
        { setting: path },
      );
    }

    const list: string[] = [];
    value.forEach((ending, index) => {
      if (typeof ending !== "string" || !/^[0-9]{1,6}$/.test(ending)) {
        throw new AlertConfigError(
          `${origin}: ${path}[${index}] must be one to six decimal digits, ` +
            `matched against the digits of an exact minor-unit amount (got ` +
            `${describe(ending)}).`,
          { setting: `${path}[${index}]` },
        );
      }
      list.push(ending);
    });

    endings[sourceId] = list;
  }

  return endings;
}

/** POST or PUT. A publish is not a question, and only these two carry a body. */
const PUBLISH_METHODS = ["POST", "PUT"];

/** RFC 9110 field name: a token. Checked so a header cannot smuggle a line. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function readChannel(
  node: Record<string, unknown>,
  origin: string,
): AlertChannelConfig {
  const endpoint = readEndpoint(node, origin);
  const method = requireNonEmptyString(node, "channel.method", origin).toUpperCase();
  if (!PUBLISH_METHODS.includes(method)) {
    throw new AlertConfigError(
      `${origin}: channel.method is ${JSON.stringify(method)}, and a ` +
        `notification is published with one of ${PUBLISH_METHODS.join(" or ")}. ` +
        "A method that carries no body would deliver an alert with no alert in " +
        "it.",
      { setting: "channel.method" },
    );
  }

  const channel: AlertChannelConfig = {
    endpoint,
    host: endpoint === null ? null : new URL(endpoint).hostname.toLowerCase(),
    method,
    headers: readHeaders(
      requireObject(
        requireKey(node, "headers", origin, "channel.headers"),
        "channel.headers",
        origin,
      ),
      origin,
    ),
    titleHeader: readOptionalHeaderName(node, "channel.titleHeader", origin),
    linkHeader: readOptionalHeaderName(node, "channel.linkHeader", origin),
    credential: readCredentialSettings(node, origin),
  };

  rejectUnknownKeys(node, "channel", origin, [
    "endpoint",
    "method",
    "headers",
    "titleHeader",
    "linkHeader",
    "credential",
  ]);

  return channel;
}

/**
 * The endpoint, or an explicit null.
 *
 * The KEY is required and its value may be null: "absent" and "the owner has
 * not chosen a channel yet" must not be the same document, or a truncated file
 * reads as a deliberate decision to stay quiet.
 */
function readEndpoint(node: Record<string, unknown>, origin: string): string | null {
  if (!("endpoint" in node)) {
    throw new AlertConfigError(
      `${origin} is missing the required key "channel.endpoint". Write null ` +
        "there to say deliberately that no channel is configured yet; leaving " +
        "the key out is indistinguishable from a truncated file.",
      { setting: "channel.endpoint" },
    );
  }

  const value = node.endpoint;
  if (value === null) return null;

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AlertConfigError(
      `${origin}: channel.endpoint must be an absolute http or https URL, or ` +
        `null (got ${describe(value)}).`,
      { setting: "channel.endpoint" },
    );
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    // The value is NOT echoed: an endpoint can be a secret in itself, and a
    // refusal is printed.
    throw new AlertConfigError(
      `${origin}: channel.endpoint is not an absolute URL. It is not quoted ` +
        "here because a notification endpoint can be a credential in itself.",
      { setting: "channel.endpoint" },
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AlertConfigError(
      `${origin}: channel.endpoint uses the ${url.protocol} scheme, and the ` +
        "governor sends over http and https only.",
      { setting: "channel.endpoint" },
    );
  }

  return url.href;
}

function readHeaders(
  node: Record<string, unknown>,
  origin: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of visibleEntries(node)) {
    const setting = `channel.headers["${name}"]`;
    if (!HEADER_NAME.test(name)) {
      throw new AlertConfigError(
        `${origin}: ${setting} is not a valid header name.`,
        { setting },
      );
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new AlertConfigError(
        `${origin}: ${setting} must be a string carrying no carriage return or ` +
          `line feed (got ${describe(value)}). A header value with a line ` +
          "break in it is a second header nobody wrote.",
        { setting },
      );
    }
    headers[name] = value;
  }
  return headers;
}

function readOptionalHeaderName(
  node: Record<string, unknown>,
  path: string,
  origin: string,
): string | null {
  const key = leaf(path);
  if (!(key in node)) {
    throw new AlertConfigError(
      `${origin} is missing the required key "${path}". Write null there to ` +
        "say this channel takes no such header.",
      { setting: path },
    );
  }
  const value = node[key];
  if (value === null) return null;
  if (typeof value !== "string" || !HEADER_NAME.test(value)) {
    throw new AlertConfigError(
      `${origin}: ${path} must be a valid header name, or null (got ` +
        `${describe(value)}).`,
      { setting: path },
    );
  }
  return value;
}

function readCredentialSettings(
  node: Record<string, unknown>,
  origin: string,
): AlertChannelCredential | null {
  if (!("credential" in node)) {
    throw new AlertConfigError(
      `${origin} is missing the required key "channel.credential". Write null ` +
        "there to say deliberately that this channel needs none.",
      { setting: "channel.credential" },
    );
  }

  const value = node.credential;
  if (value === null) return null;

  const entry = requireObject(value, "channel.credential", origin);
  const credential: AlertChannelCredential = {
    variable: requireNonEmptyString(entry, "channel.credential.variable", origin),
    header: requireNonEmptyString(entry, "channel.credential.header", origin),
    prefix: readPrefix(entry, origin),
  };

  if (!HEADER_NAME.test(credential.header)) {
    throw new AlertConfigError(
      `${origin}: channel.credential.header must be a valid header name (got ` +
        `${JSON.stringify(credential.header)}).`,
      { setting: "channel.credential.header" },
    );
  }

  rejectUnknownKeys(entry, "channel.credential", origin, [
    "variable",
    "header",
    "prefix",
  ]);

  return credential;
}

function readPrefix(node: Record<string, unknown>, origin: string): string {
  if (!("prefix" in node)) {
    throw new AlertConfigError(
      `${origin} is missing the required key "channel.credential.prefix". ` +
        'Write "" there for a header that carries the credential alone, or ' +
        '"Bearer " for one that does not.',
      { setting: "channel.credential.prefix" },
    );
  }
  const value = node.prefix;
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new AlertConfigError(
      `${origin}: channel.credential.prefix must be a string carrying no line ` +
        `break (got ${describe(value)}).`,
      { setting: "channel.credential.prefix" },
    );
  }
  return value;
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
    throw new AlertConfigError(
      `${origin} carries an unrecognised key ${setting}. Nothing here has a ` +
        "default, so an unrecognised key is a value that was meant to change " +
        "when the owner is interrupted and silently did not.",
      { setting },
    );
  }
}

function requireKey(
  node: Record<string, unknown>,
  key: string,
  origin: string,
  /** How the key is spelled in a message, where that differs from the key. */
  display: string = key,
): unknown {
  if (!(key in node) || node[key] === undefined || node[key] === null) {
    throw new AlertConfigError(
      `${origin} is missing the required key "${display}". Nothing here has a ` +
        "built-in default, so no rule is evaluated and nothing is delivered.",
      { setting: display },
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
    throw new AlertConfigError(
      `${origin}: ${path.length === 0 ? "the document" : path} must be a JSON ` +
        `object (got ${describe(value)}).`,
      { setting: path.length === 0 ? null : path },
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
  const value = requireKey(node, key, origin, path);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AlertConfigError(
      `${origin}: ${path} must be a non-empty string (got ${describe(value)}).`,
      { setting: path },
    );
  }
  return value.trim();
}

function requireInteger(
  node: Record<string, unknown>,
  path: string,
  origin: string,
  bounds: { min?: number; max?: number },
): number {
  const key = leaf(path);
  const value = requireKey(node, key, origin, path);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AlertConfigError(
      `${origin}: ${path} must be a whole number (got ${describe(value)}).`,
      { setting: path },
    );
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new AlertConfigError(
      `${origin}: ${path} must be at least ${bounds.min} (got ${value}).`,
      { setting: path },
    );
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new AlertConfigError(
      `${origin}: ${path} must be at most ${bounds.max} (got ${value}).`,
      { setting: path },
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
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
