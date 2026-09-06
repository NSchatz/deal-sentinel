/**
 * The fail-closed start check, in the shape `governor`, `sources`, `alerts` and
 * `db` already use.
 *
 * Contacts NOTHING - no database, no credential, no network - so it answers on a
 * box that has not started yet. What it reports is what the committed
 * configuration PERMITS, and the one thing it goes out of its way to say out
 * loud is whether the address about to be bound is a loopback address, because
 * that is the difference between an operator view and a price history published
 * to the LAN with no authentication in front of it.
 */

import { loadDashboardConfig, isLoopbackAddress } from "./config.ts";
import type { DashboardConfig } from "./config.ts";
import { DEFAULT_DASHBOARD_CONFIG_PATH } from "./config.ts";

export type DashboardStartCheckReport = {
  configPath: string;
  config: DashboardConfig;
  /** True when the configured address is in 127.0.0.0/8 or is ::1. */
  loopback: boolean;
  /** What an operator should be told about that address, in one line. */
  exposure: string;
};

export function dashboardStartCheck(
  configPath: string = DEFAULT_DASHBOARD_CONFIG_PATH,
): DashboardStartCheckReport {
  const config = loadDashboardConfig(configPath);
  const loopback = isLoopbackAddress(config.bindAddress);

  return {
    configPath,
    config,
    loopback,
    exposure: loopback
      ? `${config.bindAddress} is a loopback address, so this view is reachable ` +
        "only from this machine."
      : `${config.bindAddress} is NOT a loopback address. Anything that can ` +
        "reach it sees this system's whole price history and every recorded " +
        "condition, with no authentication, no accounts and no TLS in front of " +
        "it. That is a deliberate choice to make, not a default to drift into.",
  };
}
