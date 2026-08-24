/**
 * The ordinary start path's refusal.
 *
 * This function creates NOTHING. It reads the completed-initialization marker
 * and throws when it is not there, which is the difference between "the history
 * volume is missing and you should know" and "here is a brand new empty
 * history, good luck noticing".
 *
 * `docker compose down -v` removes the named volume it declares, so the wiped
 * case and the never-initialized case look identical from here. Both refuse.
 */

import type pg from "pg";
import { sql } from "drizzle-orm";

import { createDatabase } from "./connection.ts";
import { HistoryNotInitializedError } from "./errors.ts";
import { historyInitialization } from "./schema.ts";

export type InitializationMarker = {
  initializedAt: Date;
  schemaVersion: string;
  note: string;
};

const HOW_TO_FIX =
  "Initialize it deliberately with `pnpm db:init` (which refuses if a history " +
  "already exists), or restore a backup with " +
  "`packages/db/scripts/restore.sh <dump>`. This path will not create a " +
  "schema for you: a history that silently starts empty is indistinguishable " +
  "from one that was never collected.";

/**
 * Assert that this database carries a completed-initialization marker, and
 * return it. Throws `HistoryNotInitializedError` with a stated reason
 * otherwise.
 */
export async function assertHistoryInitialized(
  pool: pg.Pool,
): Promise<InitializationMarker> {
  const database = createDatabase(pool);

  const present = await database.execute(
    sql`select to_regclass('public.history_initialization') as table_name`,
  );
  if ((present.rows[0]?.table_name ?? null) === null) {
    throw new HistoryNotInitializedError(
      "no-schema",
      "Refusing to start: this history database carries no schema at all, so " +
        "there is no record that it was ever initialized. Either the volume " +
        "is new, or it was removed (`docker compose down -v` removes the " +
        "named volume it declares). " +
        HOW_TO_FIX,
    );
  }

  const markers = await database.select().from(historyInitialization).limit(1);
  const marker = markers[0];
  if (marker === undefined) {
    throw new HistoryNotInitializedError(
      "no-marker",
      "Refusing to start: this history database has the schema but no " +
        "completed-initialization marker, so nothing here finished the " +
        "one-time initialization. " +
        HOW_TO_FIX,
    );
  }

  return {
    initializedAt: marker.initializedAt,
    schemaVersion: marker.schemaVersion,
    note: marker.note,
  };
}
