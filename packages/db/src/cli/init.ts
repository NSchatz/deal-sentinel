#!/usr/bin/env node
/**
 * The one-time initialization action, as a command.
 *
 * Creates the schema on a fresh history volume and writes the
 * completed-initialization marker. It refuses, with the date it found, if this
 * history was already initialized: 3 says "it ran and a constraint said no",
 * which is the answer a scheduler must obey rather than retry.
 */

import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  HELP_FLAG,
  readInvocation,
  renderHelp,
  renderUsageError,
} from "@deal-sentinel/shared";
import type { ExitCode, HelpSpec } from "@deal-sentinel/shared";

import {
  DATABASE_URL_VARIABLE,
  createPool,
  historyDatabaseUrl,
  redactUrl,
} from "../connection.ts";
import { HistoryAlreadyInitializedError, MissingDatabaseUrlError } from "../errors.ts";
import { initializeHistory } from "../initialize.ts";
import { describeDependencyFailure } from "./common.ts";

export const HELP: HelpSpec = {
  command: "pnpm db:init",
  summary:
    "create the history schema on a fresh volume and write its " +
    "completed-initialization marker",
  usage: "HISTORY_DATABASE_URL=postgres://... pnpm db:init",
  args: [],
  flags: [HELP_FLAG],
  environment: [
    {
      flag: DATABASE_URL_VARIABLE,
      means: "required. libpq URL of the history database to initialize",
    },
  ],
  exitCodes: [EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_REFUSED],
  example:
    "HISTORY_DATABASE_URL=postgres://sentinel@127.0.0.1:5432/deal_sentinel_history pnpm db:init",
};

async function main(): Promise<ExitCode> {
  const invocation = readInvocation(process.argv.slice(2), HELP);
  if (invocation.kind === "help") {
    process.stdout.write(renderHelp(HELP));
    return EXIT_OK;
  }
  if (invocation.kind === "usage-error") {
    process.stderr.write(renderUsageError(HELP, invocation.problem));
    return EXIT_USAGE;
  }

  let url: string;
  try {
    url = historyDatabaseUrl();
  } catch (error) {
    if (error instanceof MissingDatabaseUrlError) {
      process.stderr.write(`${HELP.command}: ${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const pool = createPool(url);
  try {
    const result = await initializeHistory(pool, {
      note: `initialized by db:init against ${redactUrl(url)}`,
    });
    process.stdout.write(
      `history initialized at ${result.initializedAt.toISOString()} ` +
        `(schema version ${result.schemaVersion})\n`,
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof HistoryAlreadyInitializedError) {
      process.stderr.write(
        `${HELP.command}: refusing to initialize. This history was already ` +
          `initialized at ${error.initializedAt.toISOString()}, and nothing ` +
          `was written. ${error.message}\n`,
      );
      return EXIT_REFUSED;
    }
    process.stderr.write(
      describeDependencyFailure({
        command: HELP.command,
        url,
        tried: "opening a pool and running the one-time initialization",
        next: "stopping. Nothing was created; re-run once the database answers.",
        error,
      }),
    );
    return EXIT_ERROR;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main();
