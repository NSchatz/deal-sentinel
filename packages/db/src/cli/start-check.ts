#!/usr/bin/env node
/**
 * The ordinary start path's check, as a command.
 *
 * 0 means this history carries a completed-initialization marker and the
 * service may start. 3 means it ran, the database answered, and the marker is
 * not there - a refusal a start gate obeys. 1 means the database could not be
 * reached at all, which is the only one of the two a caller should retry. This
 * command never creates a schema.
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

import { DATABASE_URL_VARIABLE, createPool, historyDatabaseUrl } from "../connection.ts";
import { HistoryNotInitializedError, MissingDatabaseUrlError } from "../errors.ts";
import { assertHistoryInitialized } from "../start-check.ts";
import { INITIALIZATION_MARKER, describeDependencyFailure } from "./common.ts";

export const HELP: HelpSpec = {
  command: "pnpm db:start-check",
  summary:
    "answer whether this history carries a completed-initialization marker, " +
    "without creating one",
  usage: "HISTORY_DATABASE_URL=postgres://... pnpm db:start-check",
  args: [],
  flags: [HELP_FLAG],
  environment: [
    {
      flag: DATABASE_URL_VARIABLE,
      means: "required. libpq URL of the history database to check",
    },
  ],
  exitCodes: [EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_REFUSED],
  example:
    "HISTORY_DATABASE_URL=postgres://sentinel@127.0.0.1:5432/deal_sentinel_history pnpm db:start-check",
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
    const marker = await assertHistoryInitialized(pool);
    process.stdout.write(
      `history initialized at ${marker.initializedAt.toISOString()} ` +
        `(schema version ${marker.schemaVersion}); starting\n`,
    );
    return EXIT_OK;
  } catch (error) {
    if (error instanceof HistoryNotInitializedError) {
      process.stderr.write(
        `${HELP.command}: refusing to start. The completed-initialization ` +
          `marker ${INITIALIZATION_MARKER} is missing (${error.kind}), and no ` +
          `schema was created. ${error.message}\n`,
      );
      return EXIT_REFUSED;
    }
    process.stderr.write(
      describeDependencyFailure({
        command: HELP.command,
        url,
        tried: `reading the completed-initialization marker ${INITIALIZATION_MARKER}`,
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
