/**
 * The fail-closed start check over the source configuration.
 *
 * `@deal-sentinel/db` refuses to start against a history that was never
 * initialized, and `@deal-sentinel/governor` refuses to start on a
 * configuration short of a ceiling. This is the same refusal one layer up, and
 * it exists because THE CHECKS IT RUNS ARE NOT ASSERTIONS ABOUT CODE: they are
 * assertions about two committed JSON files, and a check that only ever runs
 * inside a test suite would pass in CI on the file CI has and say nothing about
 * the file the homelab is running.
 *
 * Three refusals, in the order an operator would want to hear them:
 *
 *   1. the source registry itself - a missing currency, a missing time zone, a
 *      missing or over-long retention ceiling, an unrecognised key;
 *   2. the governor's numbers against each vendor's PUBLISHED ones, so a
 *      ceiling above what the vendor allows never becomes a ceiling this
 *      process runs under;
 *   3. the credentials, reported per source rather than refused, because one
 *      source with no key must not stop the others.
 *
 * The third is a WARNING and not an exit code on purpose: a household running
 * one source of two should still collect from the one it has credentials for,
 * and that is criterion 15's rule applied one layer earlier.
 */

import { loadGovernorConfig } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { credentialPresent } from "./credential.ts";
import {
  DEFAULT_SOURCES_CONFIG_PATH,
  assertGovernorWithinDocumentedLimits,
  loadSourceRegistry,
} from "./registry.ts";
import type { DocumentedLimitCheck, SourceRegistry } from "./registry.ts";

export type SourceStartCheckReport = {
  configPath: string;
  registry: SourceRegistry;
  /** Every configured source, with what it declared and whether it can run. */
  sources: {
    sourceId: string;
    host: string;
    currency: string;
    timeZone: string;
    retentionHours: number | null;
    ceilingHours: number | null;
    attributionRequired: boolean;
    credentialVariable: string;
    credentialPresent: boolean;
  }[];
  /** The rate and allowance margins against each vendor's published limits. */
  limits: DocumentedLimitCheck[];
};

/**
 * Read both committed configurations, check them against every source's own
 * published terms, and describe what they permit. Throws `SourceConfigError`
 * on anything it refuses. Nothing here fetches anything.
 */
export function sourcesStartCheck(
  options: {
    sourcesPath?: string;
    governorPath?: string;
    governorConfig?: GovernorConfig;
    env?: NodeJS.ProcessEnv;
  } = {},
): SourceStartCheckReport {
  const configPath = options.sourcesPath ?? DEFAULT_SOURCES_CONFIG_PATH;
  const registry = loadSourceRegistry(configPath);
  const governor =
    options.governorConfig ??
    (options.governorPath === undefined
      ? loadGovernorConfig(defaultGovernorPath())
      : loadGovernorConfig(options.governorPath));

  const limits = assertGovernorWithinDocumentedLimits(registry, governor);
  const env = options.env ?? process.env;

  return {
    configPath,
    registry,
    limits,
    sources: registry.ids().map((sourceId) => {
      const entry = registry.sources[sourceId];
      return {
        sourceId,
        host: entry.host,
        currency: entry.currency,
        timeZone: entry.timeZone,
        retentionHours: entry.rawContextRetentionHours,
        ceilingHours: entry.terms?.rawContentCeilingHours ?? null,
        attributionRequired: entry.attribution.required,
        credentialVariable: entry.credentialVariable,
        credentialPresent: credentialPresent(entry.credentialVariable, env),
      };
    }),
  };
}

function defaultGovernorPath(): string {
  return new URL("../../../config/governor.json", import.meta.url).pathname;
}
