/**
 * Connecting to the history database.
 *
 * One environment variable, one pool, and a redactor so no code path in this
 * repo ever prints a password.
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema.ts";
import { MissingDatabaseUrlError } from "./errors.ts";

export const DATABASE_URL_VARIABLE = "HISTORY_DATABASE_URL";

export type HistoryDatabase = NodePgDatabase<typeof schema>;

/** The configured history database URL, or a refusal that says what is missing. */
export function historyDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim().length === 0) {
    throw new MissingDatabaseUrlError(DATABASE_URL_VARIABLE);
  }
  return url;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export function createDatabase(pool: pg.Pool): HistoryDatabase {
  return drizzle(pool, { schema });
}

/** Hide the password in a libpq URL before it reaches a log or an error. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");
}
