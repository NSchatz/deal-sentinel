#!/usr/bin/env node
/**
 * `pnpm run dashboard:serve`
 *
 * The operator view, on the address the committed configuration names.
 *
 * FOUR REFUSALS BEFORE A SOCKET IS OPENED, in this order, because each one is
 * cheaper than the next and each one is a thing an owner would otherwise
 * discover from a blank page:
 *
 *   1. the dashboard configuration is complete;
 *   2. the governor and source configurations are complete, because the page
 *      reports per-source allowances and attributions and cannot invent either;
 *   3. the history database was deliberately initialized - the same refusal
 *      `db` has always made, and for the same reason: a view of a history that
 *      silently started empty is a view of nothing, showing zeros;
 *   4. this database carries the tables this build records fetch outcomes and
 *      breaker pauses in. A schema one migration behind answers every question
 *      with "no rows", and no rows renders as a healthy source.
 *
 * This process READS. It never writes to the history database and it makes no
 * outbound request of any kind: it holds no governor, no adapter and no
 * transport, and there is nothing in this package that can send.
 */

import process from "node:process";

import {
  DATABASE_URL_VARIABLE,
  assertHistoryInitialized,
  assertOpsSchema,
  createDatabase,
  createPool,
  historyDatabaseUrl,
  redactUrl,
} from "@deal-sentinel/db";
import { loadGovernorConfig } from "@deal-sentinel/governor";
import { loadSourceRegistry } from "@deal-sentinel/sources";

import { loadDashboardConfig } from "../config.ts";
import { startDashboard } from "../server.ts";
import { dashboardStartCheck } from "../start-check.ts";

const report = dashboardStartCheck(process.argv[2]);
const config = loadDashboardConfig(process.argv[2]);
const governor = loadGovernorConfig(process.argv[3]);
const registry = loadSourceRegistry(process.argv[4]);

const url = historyDatabaseUrl();
const pool = createPool(url);

/**
 * An idle client whose connection dies emits on the POOL, and a pool with no
 * listener for that takes the process down with it. This view's whole answer to
 * an unreachable database is a page that says so, and a page cannot be served by
 * a process that has already exited - so the error is swallowed here and the
 * next request renders the refusal instead. Every read goes through `answer`,
 * which turns a failed query into that page.
 */
pool.on("error", () => undefined);

const database = createDatabase(pool);

try {
  await assertHistoryInitialized(pool);
  await assertOpsSchema(database);
} catch (error) {
  process.stderr.write(
    `refusing to serve against ${redactUrl(url)} ` +
      `(${DATABASE_URL_VARIABLE}): ` +
      `${error instanceof Error ? error.message : String(error)}\n`,
  );
  await pool.end();
  process.exit(1);
}

const server = await startDashboard({ config, governor, registry, database });

process.stdout.write(
  `deal-sentinel operator view on ${server.origin}\n` +
    `  ${report.exposure}\n` +
    `  read-only: GET and HEAD are answered and nothing else, and nothing here ` +
    "writes to the history database or contacts a third party.\n",
);

const shutdown = async (): Promise<void> => {
  await server.close();
  await pool.end();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
