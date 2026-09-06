/**
 * Turning a validated registry into the adapters a run can use.
 *
 * ONE SOURCE'S REFUSAL IS NOT EVERY SOURCE'S. A missing credential, or a
 * configured source this build has no adapter for, refuses THAT source and
 * leaves the rest ready to run. The refusal is returned rather than thrown for
 * exactly that reason: a caller that wants to abort the whole run can look at
 * `refused` and do so, and a caller that wants the other sources to keep
 * working does not have to catch anything.
 *
 * The configuration-wide refusals are not here and belong earlier: a missing
 * currency, a missing time zone, a missing or over-long retention ceiling and
 * an unrecognised key are all refused when the registry is LOADED, before any
 * adapter exists. A file that cannot be validated does not produce a partly
 * working system.
 */

import type { Governor } from "@deal-sentinel/governor";

import type { SourceAdapter } from "./adapter.ts";
import { createBestBuyAdapter } from "./bestbuy/adapter.ts";
import { SourceConfigError } from "./errors.ts";
import type { SourceRegistry } from "./registry.ts";
import { BESTBUY_API_SOURCE_ID } from "./terms.ts";

export type RefusedSource = { sourceId: string; error: Error };

export type ResolvedSources = {
  /** Adapters that can run: configured, credentialed, and known to this build. */
  ready: SourceAdapter[];
  /** Sources that will not run this time, each with the reason it will not. */
  refused: RefusedSource[];
};

/** The adapters this build knows how to construct, by source id. */
const FACTORIES: Readonly<
  Record<
    string,
    (
      governor: Governor,
      registry: SourceRegistry,
      env: NodeJS.ProcessEnv,
    ) => SourceAdapter
  >
> = {
  [BESTBUY_API_SOURCE_ID]: (governor, registry, env) =>
    createBestBuyAdapter(governor, registry.require(BESTBUY_API_SOURCE_ID), env),
};

export function resolveAdapters(
  registry: SourceRegistry,
  governor: Governor,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSources {
  const ready: SourceAdapter[] = [];
  const refused: RefusedSource[] = [];

  for (const sourceId of registry.ids()) {
    const factory = FACTORIES[sourceId];
    if (factory === undefined) {
      refused.push({
        sourceId,
        error: new SourceConfigError(
          `${sourceId} is configured but this build carries no adapter for ` +
            "it, so nothing can read it. Every other configured source still " +
            "runs.",
          { sourceId, setting: `sources["${sourceId}"]` },
        ),
      });
      continue;
    }

    try {
      ready.push(factory(governor, registry, env));
    } catch (error) {
      // `MissingCredentialError` lands here, and it names the variable and
      // never a value. So does any configuration refusal a factory raises.
      refused.push({
        sourceId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return { ready, refused };
}
