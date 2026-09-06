/**
 * Acceptance criteria 1, 26 and 28 of spec S0042-deal-sentinel-ops-5, against
 * real PostgreSQL:
 *
 *    1. WHEN a fetch's outcome becomes known THE SYSTEM SHALL durably record
 *       that fetch's source id, its outcome class, its latency in whole
 *       milliseconds, and the instant the outcome was known, and that record
 *       SHALL survive the process that wrote it exiting.
 *   26. IF the dashboard or any read path in this spec is pointed at a history
 *       database that does not carry this spec's own tables THEN THE SYSTEM
 *       SHALL refuse and SHALL say the schema is behind, and SHALL NOT report
 *       empty telemetry, zero rates or a healthy source.
 *   28. WHEN the schema is migrated for this spec THE SYSTEM SHALL add tables
 *       and SHALL NOT alter, rename or drop any column of `price_observations`,
 *       and a database initialized before this spec SHALL retain every
 *       observation row it held, unchanged, after the migration.
 *
 * CRITERION 1 IS GRADED ACROSS A REAL PROCESS BOUNDARY. A second connection from
 * the same process proves nothing about survival: the writer is still in memory.
 * So the row is written by a CHILD PROCESS that then exits, and read by this one,
 * which never held the writer.
 *
 * CRITERION 28 IS GRADED AGAINST A DATABASE THAT PREDATES THIS SPEC. A second
 * database inside the same container is migrated to the state this repository
 * shipped BEFORE this spec, filled with observations, and then migrated forward -
 * and every observation row is compared column for column across the migration.
 * That is the only shape of this test that could ever fail: asserting an additive
 * migration is additive by reading the SQL is asserting somebody's intention.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  MIGRATIONS_FOLDER,
  OPS_TABLES,
  OpsSchemaBehindError,
  SCHEMA_VERSION,
  applyMigrations,
  assertOpsSchema,
  createDatabase,
  initializeHistory,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { answer } from "@deal-sentinel/dashboard";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import { testDashboardConfig } from "../support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../support/source-3-harness.ts";

const execFile = promisify(execFileCallback);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = path.join(REPO_ROOT, "test/support/record-outcome-child.ts");

/** The migration this spec adds, and the set that shipped before it. */
const OPS_MIGRATION_TAG = "0004_ops_5_telemetry";

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;

before(async () => {
  container = await startPostgres("ops-5-telemetry-record");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 telemetry record suite" });
  database = createDatabase(pool);
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

describe("criterion 1: a fetch outcome outlives the process that wrote it", () => {
  it("was written by a process that has since exited", async () => {
    const before = await query(
      container.url,
      "select count(*)::text as n from fetch_outcomes",
    );
    assert.equal(before[0].n, "0", "the table was not empty before the child ran");

    const { stderr } = await execFile(
      process.execPath,
      [CHILD, container.url, "ok"],
      { cwd: REPO_ROOT, timeout: 120_000 },
    );
    assert.equal(stderr.trim(), "", stderr);

    // The child is gone. Everything below is read by a process that never held
    // the writer, over a connection the child never used.
    const rows = await query(
      container.url,
      "select source_id, outcome_class, latency_ms::text as latency_ms, " +
        "occurred_at::text as occurred_at, condition from fetch_outcomes " +
        "order by id",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_id, "bestbuy-api");
    assert.equal(rows[0].outcome_class, "success");
    assert.ok(rows[0].occurred_at !== null);

    // Whole milliseconds. Not a float, not a duration object, not a string.
    assert.match(rows[0].latency_ms ?? "", /^\d+$/);
  });

  it("records the class the outcome actually was, and not a default", async () => {
    // A second process, a different outcome. Two rows that were both "success"
    // would mean the class is decorative.
    await execFile(process.execPath, [CHILD, container.url, "error"], {
      cwd: REPO_ROOT,
      timeout: 120_000,
    });
    await execFile(process.execPath, [CHILD, container.url, "429"], {
      cwd: REPO_ROOT,
      timeout: 120_000,
    });

    const rows = await query(
      container.url,
      "select outcome_class from fetch_outcomes order by id",
    );
    assert.deepEqual(
      rows.map((row) => row.outcome_class),
      ["success", "error", "blocked"],
    );
  });

  it("refuses a class that is not one of the four, at the database", async () => {
    // The four are a partition and the schema is what keeps them one. A view
    // that had to cope with a fifth value would be a view with an "other"
    // bucket, which is where the interesting one goes.
    await assert.rejects(
      query(
        container.url,
        "insert into fetch_outcomes (source_id, outcome_class, latency_ms, occurred_at) " +
          "values ('bestbuy-api', 'probably-fine', 10, now())",
      ),
      /fetch_outcomes_class_is_one_of_four/,
    );
  });

  it("refuses a negative latency", async () => {
    await assert.rejects(
      query(
        container.url,
        "insert into fetch_outcomes (source_id, outcome_class, latency_ms, occurred_at) " +
          "values ('bestbuy-api', 'success', -1, now())",
      ),
      /fetch_outcomes_latency_non_negative/,
    );
  });
});

describe("criterion 26: a schema behind this build is refused, not reported as empty", () => {
  it("names the tables it does not carry", async () => {
    const behind = await createBareDatabase("schema_behind_probe");
    try {
      await assert.rejects(
        assertOpsSchema(behind.database),
        (error: unknown) => {
          assert.ok(error instanceof OpsSchemaBehindError);
          assert.deepEqual([...error.missingTables].sort(), [...OPS_TABLES].sort());
          assert.match(error.message, /schema is BEHIND/);
          return true;
        },
      );
    } finally {
      await behind.close();
    }
  });

  it("answers the page with the refusal and NOT with zero rates or a healthy source", async () => {
    const behind = await createBareDatabase("schema_behind_page");
    try {
      const given = await answer(
        {
          config: testDashboardConfig(),
          governor: bestBuyGovernorConfig(),
          registry: testRegistry(),
          database: behind.database,
        },
        "GET",
        "/",
      );

      assert.equal(given.status, 503);
      assert.match(given.body, /data-schema-behind/);
      // The three things it must not say. A missing table and a quiet system are
      // indistinguishable from a row count, and only one of them is good news.
      assert.doesNotMatch(given.body, /data-rate=/);
      assert.doesNotMatch(given.body, /data-allowance=/);
      assert.doesNotMatch(given.body, /data-verdict="healthy"/);
    } finally {
      await behind.close();
    }
  });
});

describe("criterion 28: the migration adds tables and keeps every observation row", () => {
  it("leaves an observation row untouched across the migration, column for column", async () => {
    const url = await createDatabaseNamed("pre_ops_5");
    const earlier = new pg.Pool({ connectionString: url });

    try {
      // 1. The schema this repository shipped BEFORE this spec, and nothing else.
      const folder = migrationsWithout(OPS_MIGRATION_TAG);
      await applyMigrations(earlier, folder);
      for (const table of OPS_TABLES) {
        const present = await query(
          url,
          `select to_regclass('public.${table}') as t`,
        );
        assert.equal(present[0].t, null, `${table} existed before its migration`);
      }

      // 2. Observations in it, the way a real history would have them.
      await query(
        url,
        "insert into price_observations " +
          "(source_id, listing_id, amount_minor_units, currency, observed_at, " +
          " source_time_zone, vendor_price_updated_at, raw_context_retention_hours, " +
          " raw_context, availability) values " +
          "('bestbuy-api', '8880044', 799, 'USD', '2026-09-01T12:00:00Z', " +
          " 'America/New_York', '2026-08-31T21:14:00Z', 24, '{\"a\":1}', 'InStock'), " +
          "('bestbuy-api', '6428337', 129900, 'JPY', '2026-09-02T12:00:00Z', " +
          " 'Asia/Tokyo', null, null, null, null)",
      );
      const columns = await observationColumnNames(url);
      const rowsBefore = await allObservations(url, columns);
      assert.equal(rowsBefore.length, 2);

      // 3. Forward, over a live history.
      await applyMigrations(earlier);

      // 4. Every row, every column, unchanged.
      const columnsAfter = await observationColumnNames(url);
      assert.deepEqual(
        columnsAfter,
        columns,
        "the migration altered, renamed or dropped a price_observations column",
      );
      assert.deepEqual(
        await allObservations(url, columns),
        rowsBefore,
        "an observation row changed across the migration",
      );

      // 5. And the tables this spec needs are there now.
      for (const table of OPS_TABLES) {
        const present = await query(
          url,
          `select to_regclass('public.${table}') as t`,
        );
        assert.equal(present[0].t, table, `${table} was not created`);
      }
      await assertOpsSchema(createDatabase(earlier));
    } finally {
      await earlier.end();
    }
  });

  it("is additive in its own text: no alter, rename or drop of any column", () => {
    const sql = readFileSync(
      path.join(MIGRATIONS_FOLDER, `${OPS_MIGRATION_TAG}.sql`),
      "utf8",
    );
    // Weaker than the round-trip above and kept anyway, because it names the
    // thing a future edit would do: the round-trip proves this migration is
    // additive, and this catches the next one being written that way.
    assert.doesNotMatch(sql, /\balter\s+table\b/i, sql);
    assert.doesNotMatch(sql, /\bdrop\b/i, sql);
    assert.doesNotMatch(sql, /\brename\b/i, sql);
    assert.match(sql, /create table "fetch_outcomes"/i);
    assert.match(sql, /create table "breaker_pauses"/i);
  });

  it("moves the schema version the marker reports along with the migration set", async () => {
    const marker = await query(
      container.url,
      "select schema_version from history_initialization where id = 1",
    );
    assert.equal(marker[0].schema_version, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, OPS_MIGRATION_TAG);
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A second database in the same container, so no second container is needed. */
async function createDatabaseNamed(name: string): Promise<string> {
  const client = new pg.Client({ connectionString: container.url });
  await client.connect();
  try {
    await client.query(`drop database if exists ${name}`);
    await client.query(`create database ${name}`);
  } finally {
    await client.end();
  }
  return container.url.replace(/\/[^/]+$/, `/${name}`);
}

/** A database carrying the history schema but not this spec's tables. */
async function createBareDatabase(name: string): Promise<{
  database: HistoryDatabase;
  close(): Promise<void>;
}> {
  const url = await createDatabaseNamed(name);
  const bare = new pg.Pool({ connectionString: url });
  await applyMigrations(bare, migrationsWithout(OPS_MIGRATION_TAG));
  return {
    database: createDatabase(bare),
    async close() {
      await bare.end();
    },
  };
}

/**
 * The committed migration set with one tag removed, in a temporary folder.
 *
 * The SQL files are the repository's own, unedited: what is trimmed is the
 * journal, which is what the migrator reads to decide the set.
 */
function migrationsWithout(tag: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), "ds-migrations-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  rmSync(path.join(folder, `${tag}.sql`), { force: true });

  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.tag !== tag);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

async function observationColumnNames(url: string): Promise<string[]> {
  const rows = await query(
    url,
    "select column_name from information_schema.columns " +
      "where table_name = 'price_observations' order by ordinal_position",
  );
  return rows.map((row) => String(row.column_name));
}

/** Every observation, every column, as text, so nothing is a driver's opinion. */
async function allObservations(
  url: string,
  columns: readonly string[],
): Promise<Record<string, string | null>[]> {
  const selected = columns.map((column) => `${column}::text as ${column}`).join(", ");
  return await query(url, `select ${selected} from price_observations order by id`);
}
