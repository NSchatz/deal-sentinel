#!/usr/bin/env node
/**
 * The one-time initialization action, as a command.
 *
 *   HISTORY_DATABASE_URL=postgres://... pnpm db:init
 *
 * Creates the schema on a fresh history volume and writes the
 * completed-initialization marker. Refuses, with the date it found, if this
 * history was already initialized. Exit code 0 means initialized here and now;
 * exit code 1 means it refused and said why.
 */

import { createPool, historyDatabaseUrl, redactUrl } from "../connection.ts";
import { HistoryAlreadyInitializedError } from "../errors.ts";
import { initializeHistory } from "../initialize.ts";

async function main(): Promise<number> {
  const url = historyDatabaseUrl();
  const pool = createPool(url);
  try {
    const result = await initializeHistory(pool, {
      note: `initialized by db:init against ${redactUrl(url)}`,
    });
    process.stdout.write(
      `history initialized at ${result.initializedAt.toISOString()} ` +
        `(schema version ${result.schemaVersion})\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof HistoryAlreadyInitializedError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      `history initialization failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
