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
    assert.equal(result.schemaVersion, "0000_history_1_price_observations");

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
    assert.equal(marker.schemaVersion, "0000_history_1_price_observations");
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
      assert.equal(marker.schemaVersion, "0000_history_1_price_observations");
    });
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
