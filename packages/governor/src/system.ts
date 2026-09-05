/**
 * Production wiring, and the fail-closed start check over the configuration.
 *
 * `@deal-sentinel/db` refuses to start against a history that was never
 * initialized. This is the same refusal one layer up: a process that cannot
 * read a complete governor configuration does not start, and it says which key
 * is missing. There is no built-in ceiling to start on, which is the point -
 * CLAUDE.md rule 8 forbids inventing a number and treating it as decided, and
 * a default buried in code is exactly that with the decision hidden.
 */

import { fileURLToPath } from "node:url";

import { loadGovernorConfig } from "./config.ts";
import type { GovernorConfig } from "./config.ts";
import { Governor } from "./governor.ts";
import type { AllowanceStore } from "./allowance.ts";
import { LIVE_TRANSPORT, nullNotifier, systemClock, systemRandom } from "./ports.ts";
import type { Clock, Notifier, RandomSource } from "./ports.ts";

/**
 * The committed configuration file. Its numbers are conservative and
 * UNVALIDATED: this phase proves the ceilings are enforced, not that they are
 * right (the roadmap phase's own Known limitations).
 */
export const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("../../../config/governor.json", import.meta.url),
);

export type StartCheckReport = {
  configPath: string;
  hosts: string[];
  sources: string[];
  meteredSources: string[];
};

/**
 * Read the configuration and describe what it permits, or throw
 * `GovernorConfigError`. Nothing here fetches anything.
 */
export function governorStartCheck(configPath = DEFAULT_CONFIG_PATH): StartCheckReport {
  const config = loadGovernorConfig(configPath);
  return {
    configPath,
    hosts: Object.keys(config.hosts).sort(),
    sources: Object.keys(config.sources).sort(),
    meteredSources: Object.entries(config.sources)
      .filter(([, settings]) => settings.allowance !== undefined)
      .map(([sourceId]) => sourceId)
      .sort(),
  };
}

/**
 * A governor wired to the wall clock, `Math.random` and the one HTTP transport.
 * The allowance store is a parameter because the durable one needs a database
 * handle and this package does not open connections.
 */
export function createSystemGovernor(options: {
  allowanceStore: AllowanceStore;
  config?: GovernorConfig;
  configPath?: string;
  notifier?: Notifier;
  clock?: Clock;
  random?: RandomSource;
}): Governor {
  const config =
    options.config ?? loadGovernorConfig(options.configPath ?? DEFAULT_CONFIG_PATH);

  return new Governor({
    config,
    clock: options.clock ?? systemClock,
    random: options.random ?? systemRandom,
    // The marker, not a client: production wiring asks for the real transport
    // the same way anything else does, and the governor is the only thing that
    // can turn the ask into a socket.
    transport: LIVE_TRANSPORT,
    notifier: options.notifier ?? nullNotifier,
    allowanceStore: options.allowanceStore,
  });
}
