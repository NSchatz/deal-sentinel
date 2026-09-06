/**
 * The fail-closed start check over the alert configuration.
 *
 * Same refusal `@deal-sentinel/db`, `@deal-sentinel/governor` and
 * `@deal-sentinel/sources` each make one layer down, and it exists for the same
 * reason theirs do: THE CHECKS IT RUNS ARE NOT ASSERTIONS ABOUT CODE. They are
 * assertions about a committed JSON file, and a check that only ever ran inside
 * a test suite would pass in CI on the file CI has and say nothing about the
 * file the homelab is running.
 *
 * It CONTACTS NOTHING. No database, no credential, no network: it reads two
 * committed files and describes what they permit. That is the whole point of
 * being able to run it on a box that is about to start, before anything has
 * been sent to anybody.
 *
 * Three things it reports, and three it refuses on:
 *
 *   - every configured rule with its window, its minimum observation count and
 *     its cooldown, which is what the operator asked;
 *   - whether a channel is configured at all, and whether its credential is
 *     present in the environment - REPORTED and not refused, because a
 *     household that has not chosen a channel yet should still be able to see
 *     what its rules would do;
 *   - REFUSES when the alert configuration is absent, unparseable or short of a
 *     required setting; REFUSES when a configured channel's host carries no
 *     ceiling in `config/governor.json` or its source id is unknown there, which
 *     is the governor's own first two gates surfaced before a run rather than
 *     discovered as a delivery that never arrives; and REFUSES a channel
 *     endpoint carrying a credential in its userinfo, which the channel itself
 *     will not send to, for the same reason - EVERY delivery would be refused,
 *     and a check that called it "configured" would be describing a system that
 *     silently sends nothing.
 */

import { fileURLToPath } from "node:url";

import { loadGovernorConfig } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { DEFAULT_ALERTS_CONFIG_PATH, loadAlertConfig } from "./config.ts";
import type { AlertConfig } from "./config.ts";
import { AlertConfigError } from "./errors.ts";
import { carriesUserinfo } from "./redaction.ts";

export type RuleReport = {
  ruleId: string;
  kind: string;
  windowMs: number;
  minimumObservations: number;
  improvementMinorUnits: bigint;
  cooldownMs: number;
};

export type AlertStartCheckReport = {
  configPath: string;
  config: AlertConfig;
  rules: RuleReport[];
  /** Sources with at least one operator-supplied clearance ending. */
  clearanceSources: { sourceId: string; endings: string[] }[];
  channel: {
    /** True once the owner has configured an endpoint. */
    configured: boolean;
    /** Scheme, host and port. Never the path and never the query. */
    origin: string | null;
    method: string;
    /** The variable the credential is read from, or null. Never the value. */
    credentialVariable: string | null;
    credentialPresent: boolean;
  };
};

export function alertsStartCheck(
  options: {
    alertsPath?: string;
    governorPath?: string;
    governorConfig?: GovernorConfig;
    env?: NodeJS.ProcessEnv;
  } = {},
): AlertStartCheckReport {
  const configPath = options.alertsPath ?? DEFAULT_ALERTS_CONFIG_PATH;
  const config = loadAlertConfig(configPath);
  const env = options.env ?? process.env;

  const governor =
    options.governorConfig ??
    loadGovernorConfig(options.governorPath ?? defaultGovernorPath());

  assertChannelIsReachable(config, governor, configPath);

  const credential = config.channel.credential;

  return {
    configPath,
    config,
    rules: Object.values(config.rules).map((rule) => ({
      ruleId: rule.ruleId,
      kind: rule.kind,
      windowMs: rule.windowMs,
      minimumObservations: rule.minimumObservations,
      improvementMinorUnits: rule.improvementMinorUnits,
      cooldownMs: rule.cooldownMs,
    })),
    clearanceSources: Object.entries(config.clearanceEndings)
      .filter(([, endings]) => endings.length > 0)
      .map(([sourceId, endings]) => ({ sourceId, endings })),
    channel: {
      configured: config.channel.endpoint !== null,
      origin: config.channel.endpoint === null ? null : originOf(config.channel.endpoint),
      method: config.channel.method,
      credentialVariable: credential === null ? null : credential.variable,
      credentialPresent:
        credential !== null &&
        (env[credential.variable] ?? "").trim().length > 0,
    },
  };
}

/**
 * Every gate that would refuse EVERY delivery, asked before a run instead of
 * after one.
 *
 * A channel whose host carries no ceiling is refused by the governor on every
 * attempt; a source id it has never heard of is refused on every attempt too;
 * and an endpoint with a credential in its userinfo is refused by the channel
 * itself, before the governor is even asked. All three are configuration
 * mistakes that look exactly like "the alerts stopped working" - the box starts,
 * the rules fire, and every notification turns into a `failures[]` entry nobody
 * is watching - so they are named here, at start, with the fix to make.
 */
function assertChannelIsReachable(
  config: AlertConfig,
  governor: GovernorConfig,
  origin: string,
): void {
  if (config.channel.endpoint !== null && carriesUserinfo(config.channel.endpoint)) {
    // The endpoint is NOT quoted: it carries a credential, which is the whole
    // finding. The setting names itself and that is enough to act on.
    throw new AlertConfigError(
      `${origin} configures a channel.endpoint carrying a credential in its ` +
        "userinfo, the user:password@ before the host. The channel refuses to " +
        "send to one, because a credential inside a URL is handed to the " +
        "transport and quoted back by every error raised along the way, so no " +
        "alert would ever be delivered. Move it to channel.credential, which " +
        "puts it in a header and keeps it out of every reported string.",
      { setting: "channel.endpoint" },
    );
  }

  if (config.channel.host === null) return;

  if (governor.hosts[config.channel.host] === undefined) {
    throw new AlertConfigError(
      `${origin} configures a channel on ${config.channel.host}, and ` +
        "config/governor.json carries no request ceiling for that host. The " +
        "governor's first gate refuses every request to it, so no alert would " +
        `ever be delivered. Add hosts["${config.channel.host}"] deliberately; ` +
        "there is no default rate to fall back to.",
      { setting: `hosts["${config.channel.host}"]` },
    );
  }

  if (governor.sources[config.sourceId] === undefined) {
    throw new AlertConfigError(
      `${origin} names the source id ${JSON.stringify(config.sourceId)} for its ` +
        "channel, and config/governor.json carries no entry under sources for " +
        "it. The governor's second gate refuses a source whose breaker " +
        "settings and allowance are unknown, so no alert would ever be " +
        "delivered.",
      { setting: `sources["${config.sourceId}"]` },
    );
  }
}

function originOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

function defaultGovernorPath(): string {
  return fileURLToPath(new URL("../../../config/governor.json", import.meta.url));
}
