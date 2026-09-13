#!/usr/bin/env node
/**
 * Produce the dashboard, as a command.
 *
 *   HISTORY_DATABASE_URL=postgres://... node packages/ops/src/cli/dashboard.ts
 *
 * IT PRODUCES A FILE AND NOTHING LISTENS. There is no server here, no port and
 * no socket to bind: the page is written to the configured path and the owner
 * opens it. That is the whole delivery, and it is the reason this repository's
 * HTTP-client allowlist needed no new entry for the operator surface - nothing
 * in `@deal-sentinel/ops` names a client or a server module at all.
 *
 * THE ORDER OF THE STEPS IS THE POINT. The output location is checked first,
 * before a connection is opened or a row is read, so a run that cannot deliver
 * costs the database nothing and fails naming the path. Exit 2 is a
 * configuration refusal, exit 3 is an output location this command will not
 * write to, and exit 1 is everything else.
 */

import { createDatabase, createPool, historyDatabaseUrl } from "@deal-sentinel/db";
import {
  drizzleObservationSeries,
  drizzleRequestOutcomes,
  drizzleSourceStops,
  drizzleWatchlist,
} from "@deal-sentinel/db";
import {
  createPostgresAllowanceStore,
  loadGovernorConfig,
  systemClock,
} from "@deal-sentinel/governor";

import { loadOpsConfig } from "../config.ts";
import { buildDashboardModel, renderDashboard } from "../dashboard.ts";
import { OpsConfigError } from "../errors.ts";
import { combinePauseReaders, periodStopPauses, stopPeriodsFrom } from "../health.ts";
import { DashboardOutputError, assertOutputWritable, writeDashboard } from "../write.ts";

const OPS_CONFIG_PATH = new URL("../../../../config/ops.json", import.meta.url);
const GOVERNOR_CONFIG_PATH = new URL("../../../../config/governor.json", import.meta.url);

async function main(): Promise<number> {
  const config = loadOpsConfig(OPS_CONFIG_PATH.pathname);
  const governorConfig = loadGovernorConfig(GOVERNOR_CONFIG_PATH.pathname);

  // Before anything is read: a page that cannot be delivered is not worth a
  // query, and this is the failure an owner is most likely to meet.
  assertOutputWritable(config.dashboard.outputPath);

  const pool = createPool(historyDatabaseUrl());
  try {
    const database = createDatabase(pool);
    const model = await buildDashboardModel({
      config,
      governorConfig,
      outcomes: drizzleRequestOutcomes(database),
      allowance: createPostgresAllowanceStore(database),
      // A breaker pause lives in the collecting process's memory and this is
      // not that process, so the durable half is what this page can see. The
      // page says so beside the section rather than implying it saw both.
      pauses: combinePauseReaders([
        periodStopPauses(
          drizzleSourceStops(database),
          systemClock,
          stopPeriodsFrom(governorConfig),
        ),
      ]),
      clock: systemClock,
      watchlist: drizzleWatchlist(database),
      series: drizzleObservationSeries(database),
    });

    const written = writeDashboard(renderDashboard(model), config.dashboard.outputPath);
    process.stdout.write(
      `dashboard written to ${written} for the window ending ` +
        `${model.producedAt.toISOString()}\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof DashboardOutputError) process.exitCode = error.exitCode;
  else if (error instanceof OpsConfigError) process.exitCode = 2;
  else process.exitCode = 1;
}
