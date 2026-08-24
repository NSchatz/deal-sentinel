#!/usr/bin/env node
/**
 * The ordinary start path's check, as a command.
 *
 *   HISTORY_DATABASE_URL=postgres://... pnpm db:start-check
 *
 * Exit code 0 means this history carries a completed-initialization marker and
 * the service may start. Exit code 1 means it refused, and the reason is on
 * stderr. This command never creates a schema.
 */

import { createPool, historyDatabaseUrl } from "../connection.ts";
import { HistoryNotInitializedError } from "../errors.ts";
import { assertHistoryInitialized } from "../start-check.ts";

async function main(): Promise<number> {
  const pool = createPool(historyDatabaseUrl());
  try {
    const marker = await assertHistoryInitialized(pool);
    process.stdout.write(
      `history initialized at ${marker.initializedAt.toISOString()} ` +
        `(schema version ${marker.schemaVersion}); starting\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof HistoryNotInitializedError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      `history start check failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
