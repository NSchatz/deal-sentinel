/**
 * Acceptance criteria 1 and 9 of spec S0033-deal-sentinel-source-3, against
 * real PostgreSQL:
 *
 *   1. WHEN the sanctioned API adapter records an observation THE SYSTEM SHALL
 *      derive it from the documented sale and regular price fields and SHALL
 *      record the vendor's own price-update timestamp beside the fetch instant.
 *   9. WHEN the adapter records an observation THE SYSTEM SHALL leave the
 *      store-scoped dimension unpopulated and SHALL attribute the row by its
 *      per-listing key.
 *
 * The rows here are produced by the real adapter, over saved vendor payloads,
 * through the real governor and the real write path, into a real database.
 * Nothing is inserted by hand. The transport is the recording stub, so not one
 * byte reaches the vendor: this repository makes no live request from a test,
 * from CI, or from a development session.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  addWatchlistEntry,
  createDatabase,
  drizzleWatchlist,
  drizzleWriter,
  initializeHistory,
  memorySourceStops,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import {
  bestBuyAdapter,
  runCollection,
  stopPeriodsFromGovernorConfig,
} from "@deal-sentinel/sources";
import type { CollectionRunReport } from "@deal-sentinel/sources";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import {
  TEST_CREDENTIAL,
  fixtureAnswer,
  sourceHarness,
} from "../support/source-3-harness.ts";
import type { SourceHarness } from "../support/source-3-harness.ts";

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let harness: SourceHarness;
let report: CollectionRunReport;

/** The listings the watchlist carries, and the payload each one answers with. */
const WATCHED: [string, string][] = [
  ["8880044", "product-on-sale.json"],
  ["6428337", "product-not-on-sale.json"],
  ["5901234", "product-no-price-update-date.json"],
];

before(async () => {
  container = await startPostgres("source-3-observation");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "source-3 observation suite" });
  database = createDatabase(pool);

  for (const [listingId] of WATCHED) {
    await addWatchlistEntry(database, { sourceId: "bestbuy-api", listingId });
  }

  harness = sourceHarness({
    answers: Object.fromEntries(
      WATCHED.map(([listingId, fixture]) => [listingId, fixtureAnswer(fixture)]),
    ),
  });

  report = await runCollection({
    adapters: [
      bestBuyAdapter({
        governor: harness.governor,
        entry: harness.registry.require("bestbuy-api"),
        credential: TEST_CREDENTIAL,
      }),
    ],
    registry: harness.registry,
    watchlist: drizzleWatchlist(database),
    writer: drizzleWriter(database),
    stops: memorySourceStops(),
    notifier: harness.notifier,
    clock: harness.clock,
    stopPeriodMsFor: stopPeriodsFromGovernorConfig(harness.config),
    database,
  });
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

async function rowFor(listingId: string): Promise<Record<string, string | null>> {
  const rows = await query(
    container.url,
    "select source_id, listing_id, store_id, amount_minor_units::text as amount, " +
      "currency, observed_at::text as observed_at, source_time_zone, " +
      "vendor_price_updated_at::text as vendor_updated_at, " +
      "raw_context_retention_hours::text as retention_hours, " +
      "raw_context, availability from price_observations where listing_id = $1",
    [listingId],
  );
  assert.equal(rows.length, 1, `expected exactly one row for ${listingId}`);
  return rows[0];
}

describe("criterion 1: the observation is derived from both price fields", () => {
  it("wrote one row per watchlist entry and nothing else", async () => {
    const rows = await query(container.url, "select count(*)::text as n from price_observations");
    assert.equal(rows[0].n, String(WATCHED.length));
    assert.equal(report.sources[0].observed.length, WATCHED.length);
  });

  it("records the SALE price, as exact minor units", async () => {
    const row = await rowFor("8880044");
    // The fixture's salePrice is 7.99 and its regularPrice is 9.99. The amount
    // stored is the sale price, in USD's own minor unit.
    assert.equal(row.amount, "799");
    assert.equal(row.currency, "USD");
  });

  it("used the regular price to derive the sale flag, and refuses without it", async () => {
    // The derivation is graded on the mapping, where both amounts are visible;
    // what the database can show is that a payload carrying only one of the
    // two writes no row at all.
    const harnessWithoutRegular = sourceHarness({
      answers: { "3320012": fixtureAnswer("product-no-regular-price.json") },
    });
    const adapter = bestBuyAdapter({
      governor: harnessWithoutRegular.governor,
      entry: harnessWithoutRegular.registry.require("bestbuy-api"),
      credential: TEST_CREDENTIAL,
    });
    const outcome = await adapter.observe("3320012");
    assert.ok(outcome.kind === "extraction-failed");
    assert.equal(outcome.reason, "no-price");
    assert.match(outcome.detail, /regularPrice/);

    const rows = await query(
      container.url,
      "select count(*)::text as n from price_observations where listing_id = '3320012'",
    );
    assert.equal(rows[0].n, "0");
  });

  it("records the vendor's own price-update instant BESIDE the fetch instant", async () => {
    const row = await rowFor("8880044");
    assert.ok(row.observed_at !== null);
    assert.ok(row.vendor_updated_at !== null);

    // Two distinct instants on one row. The vendor's string was
    // "2026-09-05T14:32:00" with no offset, read in the source's declared
    // zone (America/New_York, UTC-4 in September) as 18:32Z.
    assert.equal(
      new Date(row.vendor_updated_at).toISOString(),
      "2026-09-05T18:32:00.000Z",
    );
    assert.notEqual(
      new Date(row.observed_at).toISOString(),
      new Date(row.vendor_updated_at).toISOString(),
      "the vendor's instant and the fetch instant are the same value, so one " +
        "of them was filled in from the other",
    );
    // The fetch instant is this run's, on the injected clock: at or after the
    // instant the run began and no later than now. It is NOT the vendor's, and
    // it is not a wall-clock reading either.
    const observed = new Date(row.observed_at).getTime();
    assert.ok(
      observed >= report.startedAt.getTime() && observed <= harness.clock.now(),
      `${row.observed_at} is outside the run's own window`,
    );
  });

  it("leaves the vendor instant NULL where the vendor published none", async () => {
    const row = await rowFor("5901234");
    assert.equal(row.vendor_updated_at, null);
    // And the observation is still there, with its own instant.
    assert.equal(row.amount, "34950");
    assert.ok(row.observed_at !== null);
  });

  it("stores the source's local zone beside the instant", async () => {
    const row = await rowFor("8880044");
    assert.equal(row.source_time_zone, "America/New_York");
  });

  it("stores the retention ceiling the source declared", async () => {
    const row = await rowFor("8880044");
    assert.equal(row.retention_hours, "24");
  });

  it("stores raw context carrying no credential", async () => {
    const row = await rowFor("8880044");
    assert.ok(row.raw_context !== null);
    assert.ok(!row.raw_context.includes(TEST_CREDENTIAL));
    assert.ok(row.raw_context.includes("Batman Begins"));
  });

  it("stores NULL availability, because the vendor documents no token", async () => {
    const row = await rowFor("8880044");
    assert.equal(row.availability, null);
  });

  it("reached the vendor only through the governor's own transport", () => {
    // Every request the stub saw. If the adapter had a client of its own,
    // there would be a product request this list does not contain.
    const products = harness.transport.sent.filter(
      (request) => new URL(request.url).pathname !== "/robots.txt",
    );
    assert.equal(products.length, WATCHED.length);
    for (const request of products) {
      assert.match(request.url, /^https:\/\/api\.bestbuy\.com\/v1\/products\//);
      assert.equal(request.headers["user-agent"], harness.config.userAgent);
    }
  });
});

describe("criterion 9: the store dimension stays empty and the listing key attributes the row", () => {
  it("leaves store_id NULL on every row", async () => {
    const rows = await query(
      container.url,
      "select count(*)::text as n from price_observations where store_id is not null",
    );
    assert.equal(rows[0].n, "0");
  });

  it("attributes each row by the watchlist's own per-listing key", async () => {
    for (const [listingId] of WATCHED) {
      const row = await rowFor(listingId);
      assert.equal(row.listing_id, listingId);
      assert.equal(row.source_id, "bestbuy-api");
    }
  });

  it("refuses a store id outright, so the dimension cannot be filled by accident", async () => {
    const { recordObservation } = await import("@deal-sentinel/db");
    await assert.rejects(
      recordObservation(
        drizzleWriter(database),
        { ok: true, amountMinorUnits: 1n, currency: "USD", availability: "" },
        {
          sourceId: "bestbuy-api",
          listingId: "8880044",
          storeId: "1234",
          observedAt: new Date(),
          sourceTimeZone: "America/New_York",
          rawContext: "{}",
        },
      ),
      /storeId is reserved/,
    );
  });
});
