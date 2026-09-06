/**
 * The one-time initialization action, and only it, creates the schema.
 *
 * The two halves of acceptance criterion 4 are deliberately separate code
 * paths:
 *
 *   - `initializeHistory` (here) creates the schema on a fresh volume and
 *     writes the completed-initialization marker. Run twice, it REFUSES, with
 *     the date of the initialization it found, because the second run of a
 *     "set up the database" action against a live history is how a history gets
 *     wiped by someone who meant well.
 *   - `assertHistoryInitialized` (start-check.ts) is what the ordinary start
 *     path calls. It creates nothing, ever. It refuses to start when the marker
 *     is absent, which covers both a volume nothing ever initialized and a
 *     volume that was initialized and has since been wiped by
 *     `docker compose down -v`.
 */

import { fileURLToPath } from "node:url";
import type pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";

import { createDatabase } from "./connection.ts";
import type { HistoryDatabase } from "./connection.ts";
import { HistoryAlreadyInitializedError } from "./errors.ts";
import { historyInitialization } from "./schema.ts";

/** The committed migration set this package applies. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

/**
 * The schema version recorded in the marker row, so a dump restored years later
 * says which migration set produced it.
 *
 * MOVES WITH THE LAST MIGRATION IN THE COMMITTED SET. A marker frozen at the
 * first one says the same thing about every database this system has ever
 * produced, which is worth nothing to somebody holding a dump and asking what
 * is in it.
 */
export const SCHEMA_VERSION = "0004_ops_5_telemetry";

export type InitializationResult = {
  initializedAt: Date;
  schemaVersion: string;
  note: string;
};

export async function initializeHistory(
  pool: pg.Pool,
  options: { note?: string } = {},
): Promise<InitializationResult> {
  const database = createDatabase(pool);

  const existing = await readMarker(database);
  if (existing !== null) {
    throw new HistoryAlreadyInitializedError(
      existing.initializedAt,
      "Refusing to initialize: this history was already initialized at " +
        `${existing.initializedAt.toISOString()} (schema version ` +
        `${existing.schemaVersion}). Running initialization again against a ` +
        "live history is how a price history gets wiped by accident. If this " +
        "volume really is meant to be replaced, remove the volume " +
        "deliberately first, and restore from a backup if you wanted to keep " +
        "the history: packages/db/scripts/restore.sh.",
    );
  }

  await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });

  const note =
    options.note ??
    `initialized by @deal-sentinel/db on ${new Date().toISOString()}`;

  const [marker] = await database
    .insert(historyInitialization)
    .values({ id: 1, schemaVersion: SCHEMA_VERSION, note })
    .returning();

  return {
    initializedAt: marker.initializedAt,
    schemaVersion: marker.schemaVersion,
    note: marker.note,
  };
}

/**
 * Apply the committed migration set to a database that already has a history.
 *
 * SEPARATE FROM `initializeHistory`, which refuses to run twice because the
 * second run of a "set up the database" action against a live history is how a
 * price history gets wiped by somebody who meant well. This one is the other
 * half of that pair and it is not the same action: the migration set is
 * forward-only DDL, Drizzle records what it has applied, and running it against
 * a live volume is exactly what an operator must do when a phase adds a table to
 * a database that already holds observations.
 *
 * It writes NO marker. A migration is not an initialization, and a database with
 * no marker still refuses to start after one.
 */
export async function applyMigrations(
  pool: pg.Pool,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(createDatabase(pool), { migrationsFolder });
}

/**
 * Read the completed-initialization marker, tolerating a volume that carries no
 * schema at all. Returns null when there is no marker to read.
 */
export async function readMarker(
  database: HistoryDatabase,
): Promise<{ initializedAt: Date; schemaVersion: string; note: string } | null> {
  const present = await database.execute(
    sql`select to_regclass('public.history_initialization') as table_name`,
  );
  const tableName = present.rows[0]?.table_name ?? null;
  if (tableName === null) return null;

  const markers = await database.select().from(historyInitialization).limit(1);
  const marker = markers[0];
  if (marker === undefined) return null;

  return {
    initializedAt: marker.initializedAt,
    schemaVersion: marker.schemaVersion,
    note: marker.note,
  };
}
