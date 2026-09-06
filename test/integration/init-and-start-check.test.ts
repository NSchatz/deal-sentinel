/**
 * Acceptance criterion 4, against real PostgreSQL on a real named volume:
 *
 *   IF the history volume is absent or empty at start THEN THE SYSTEM SHALL
 *   refuse to start and say so, rather than begin a new empty history.
 *
 * Both halves of "absent or empty" get their own container: one volume nothing
 * ever initialized, and one volume that WAS initialized and was then removed
 * the way `docker compose down -v` removes it.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  HistoryAlreadyInitializedError,
  HistoryNotInitializedError,
  SCHEMA_VERSION,
  assertHistoryInitialized,
  createDatabase,
  initializeHistory,
  readMarker,
} from "@deal-sentinel/db";

import {
  createNetwork,
  destroyPostgres,
  removeNetwork,
  startPostgres,
} from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";

let network: string;
let first: PostgresContainer;
let second: PostgresContainer | undefined;

before(async () => {
  network = await createNetwork(`ds-net-init-${process.pid}-${Date.now().toString(36)}`);
  first = await startPostgres("init", { network });
}, { timeout: 300_000 });

after(async () => {
  if (first) await destroyPostgres(first, { keepNetwork: true });
  if (second) await destroyPostgres(second, { keepNetwork: true });
  if (network) await removeNetwork(network);
}, { timeout: 120_000 });

async function withPool<T>(
  url: string,
  run: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

describe("a volume nothing has ever initialized", () => {
  it("refuses to start, and says the schema is not there", async () => {
    const error = await withPool(first.url, async (pool) =>
      assertHistoryInitialized(pool).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );

    assert.ok(
      error instanceof HistoryNotInitializedError,
      `expected a HistoryNotInitializedError, got ${String(error)}`,
    );
    assert.equal(error.kind, "no-schema");
    assert.match(error.message, /Refusing to start/);
    assert.match(error.message, /down -v/);
    assert.match(error.message, /db:init/);
  });

  it("created nothing by asking: the start path never migrates", async () => {
    const rows = await query(
      first.url,
      "select to_regclass('public.price_observations')::text as observations, " +
        "to_regclass('public.history_initialization')::text as marker",
    );
    assert.deepEqual(rows[0], { observations: null, marker: null });
  });
});

describe("the one-time initialization action", () => {
  it("creates the schema and writes a completed-initialization marker", async () => {
    const result = await withPool(first.url, (pool) =>
      initializeHistory(pool, { note: "initialized by the integration suite" }),
    );

    assert.ok(result.initializedAt instanceof Date);
    // Against the CONSTANT and not against a literal: the marker's whole job is
    // to say which migration set produced a dump, so the version moves when the
    // set does. That it moves is asserted where it belongs, in
    // `telemetry-record.test.ts`; here what matters is that the marker carries
    // whatever this build applied.
    assert.equal(result.schemaVersion, SCHEMA_VERSION);

    const tables = await query(
      first.url,
      "select to_regclass('public.price_observations')::text as observations, " +
        "to_regclass('public.history_initialization')::text as marker",
    );
    assert.deepEqual(tables[0], {
      observations: "price_observations",
      marker: "history_initialization",
    });
  });

  it("lets the ordinary start path through afterwards", async () => {
    const marker = await withPool(first.url, (pool) =>
      assertHistoryInitialized(pool),
    );
    assert.equal(marker.schemaVersion, SCHEMA_VERSION);
    assert.equal(marker.note, "initialized by the integration suite");
  });

  it("refuses a second run, and says when the history was initialized", async () => {
    const error = await withPool(first.url, async (pool) =>
      initializeHistory(pool).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );

    assert.ok(
      error instanceof HistoryAlreadyInitializedError,
      `expected a HistoryAlreadyInitializedError, got ${String(error)}`,
    );
    assert.match(error.message, /Refusing to initialize/);
    assert.match(error.message, /already initialized at \d{4}-\d{2}-\d{2}T/);
    assert.match(error.message, /restore\.sh/);
  });

  it("left the first initialization's marker exactly as it was", async () => {
    const markers = await query(
      first.url,
      "select count(*)::text as count, min(note) as note from history_initialization",
    );
    assert.equal(markers[0].count, "1");
    assert.equal(markers[0].note, "initialized by the integration suite");
  });

  it("writes a marker readable without a schema assumption", async () => {
    await withPool(first.url, async (pool) => {
      const marker = await readMarker(createDatabase(pool));
      assert.ok(marker !== null);
      assert.equal(marker.schemaVersion, SCHEMA_VERSION);
    });
  });

  /**
   * Acceptance criterion 21 of spec S0033-deal-sentinel-source-3:
   *
   *   WHEN the watchlist and the retention policy have been added THE SYSTEM
   *   SHALL still start against a database provisioned by the documented
   *   initialization path, and SHALL still refuse to start on an uninitialized
   *   volume.
   *
   * The refusal half is graded by the two blocks either side of this one, which
   * are unchanged. This half is the provisioning: the SAME documented action,
   * with no extra step and no operator SQL, now creates the tables SOURCE-3
   * needs as well - because they are in the committed migration set that action
   * applies, and there is no second path that could apply them instead.
   */
  it("provisions the watchlist and the source-stop tables by the same action", async () => {
    const tables = await query(
      first.url,
      "select to_regclass('public.watchlist_entries')::text as watchlist, " +
        "to_regclass('public.source_period_stops')::text as stops",
    );
    assert.deepEqual(tables[0], {
      watchlist: "watchlist_entries",
      stops: "source_period_stops",
    });
  });

  it("makes raw content deletable, which the retention policy needs", async () => {
    // The retention job empties this column and leaves the observation behind,
    // so the column has to be nullable. Asked of the catalogue rather than of
    // the schema file, because the question is what the MIGRATION did.
    const columns = await query(
      first.url,
      "select is_nullable from information_schema.columns " +
        "where table_name = 'price_observations' and column_name = 'raw_context'",
    );
    assert.equal(columns.length, 1);
    assert.equal(columns[0].is_nullable, "YES");
  });
});

describe("a volume that was initialized and has since been wiped", () => {
  it("refuses to start rather than begin a new empty history", async () => {
    // `docker compose down -v` removes the named volume it declares. Removing
    // the container AND its volume is exactly that, and what comes back up is a
    // fresh, empty PostgreSQL on a fresh volume.
    await destroyPostgres(first, { keepNetwork: true });
    second = await startPostgres("wiped", { network });

    const error = await withPool(second.url, async (pool) =>
      assertHistoryInitialized(pool).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );

    assert.ok(
      error instanceof HistoryNotInitializedError,
      `expected a HistoryNotInitializedError, got ${String(error)}`,
    );
    assert.match(error.message, /Refusing to start/);

    const tables = await query(
      second.url,
      "select to_regclass('public.price_observations')::text as observations",
    );
    assert.equal(tables[0].observations, null);
  });
});
