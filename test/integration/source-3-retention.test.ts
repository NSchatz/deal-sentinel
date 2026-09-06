/**
 * Acceptance criteria 2, 10 and 11 of spec S0033-deal-sentinel-source-3,
 * against real PostgreSQL:
 *
 *   2. WHEN a source declares a retention ceiling on its content THE SYSTEM
 *      SHALL enforce a per-source retention policy over stored raw content and
 *      SHALL delete content past that ceiling with no operator action.
 *  10. WHEN stored raw content is deleted under its source's retention ceiling
 *      THE SYSTEM SHALL leave that row's price, currency, observation instant,
 *      vendor price-update instant, source and listing unchanged and readable.
 *  11. WHEN a source declares no retention ceiling THE SYSTEM SHALL retain that
 *      source's stored raw content and SHALL NOT delete it.
 *
 * Graded the way the roadmap phase says to grade it: by AGEING A ROW past a
 * configured ceiling and finding its content gone WITHOUT A HUMAN. "Without a
 * human" is the load-bearing half, so the sweep here is the one a collection
 * run performs at its end - the same call, in the same place - and not a
 * maintenance command a test invoked on the job's behalf.
 *
 * The phase is explicit that the second assertion is a POLICY and not a period:
 * whether a DERIVED OBSERVATION falls under the vendor's 72-hour clause is the
 * owner's open question, and this suite grades the same either way. What is
 * aged here is STORED RAW CONTENT, which is cached vendor Content on any
 * reading of that clause.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  createDatabase,
  drizzleWriter,
  initializeHistory,
  memorySourceStops,
  memoryWatchlist,
  recordObservation,
  sweepExpiredRawContent,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import {
  bestBuyAdapter,
  runCollection,
  stopPeriodsFromGovernorConfig,
  sweepRetention,
} from "@deal-sentinel/sources";

import { FakeClock } from "../support/fake-clock.ts";
import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import {
  TEST_CREDENTIAL,
  fixtureAnswer,
  sourceHarness,
} from "../support/source-3-harness.ts";

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;

const STORED_AT = new Date("2026-09-01T12:00:00.000Z");
const VENDOR_UPDATED_AT = new Date("2026-08-31T09:30:00.000Z");

/** Hours after `STORED_AT` at which each row's ceiling has passed. */
const CEILING_HOURS = 24;

before(async () => {
  container = await startPostgres("source-3-retention");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "source-3 retention suite" });
  database = createDatabase(pool);

  const writer = drizzleWriter(database);

  // A source that declares a ceiling, and one that declares none. Both rows
  // are written through the real write path, carrying real raw content.
  await recordObservation(
    writer,
    { ok: true, amountMinorUnits: 799n, currency: "USD", availability: "InStock" },
    {
      sourceId: "bestbuy-api",
      listingId: "8880044",
      observedAt: STORED_AT,
      sourceTimeZone: "America/New_York",
      vendorPriceUpdatedAt: VENDOR_UPDATED_AT,
      rawContextRetentionHours: CEILING_HOURS,
      rawContext: '{"sku":8880044,"salePrice":7.99,"regularPrice":9.99}',
    },
  );

  await recordObservation(
    writer,
    { ok: true, amountMinorUnits: 4999n, currency: "USD", availability: "" },
    {
      sourceId: "no-terms-source",
      listingId: "https://example.invalid/tools/hand-plane",
      observedAt: STORED_AT,
      sourceTimeZone: "America/Chicago",
      vendorPriceUpdatedAt: null,
      // No ceiling declared. This content is retained indefinitely.
      rawContextRetentionHours: null,
      rawContext: '<div itemprop="offers">a listing this system may keep</div>',
    },
  );
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

async function rowFor(listingId: string): Promise<Record<string, string | null>> {
  const rows = await query(
    container.url,
    "select source_id, listing_id, amount_minor_units::text as amount, currency, " +
      "observed_at::text as observed_at, source_time_zone, " +
      "vendor_price_updated_at::text as vendor_updated_at, " +
      "raw_context_retention_hours::text as retention_hours, raw_context, " +
      "availability from price_observations where listing_id = $1",
    [listingId],
  );
  assert.equal(rows.length, 1, `expected exactly one row for ${listingId}`);
  return rows[0];
}

/** A clock reading a fixed number of hours after the rows were stored. */
function clockAt(hoursAfterStorage: number): FakeClock {
  return new FakeClock(STORED_AT.getTime() + hoursAfterStorage * 3_600_000);
}

describe("criterion 2: content past its source's ceiling is deleted, with no operator action", () => {
  it("keeps content that is still inside the ceiling", async () => {
    const sweep = await sweepRetention(database, clockAt(CEILING_HOURS - 1));
    assert.equal(sweep.deleted, 0);
    const row = await rowFor("8880044");
    assert.ok(row.raw_context !== null, "content was deleted before its ceiling");
  });

  it("deletes it once the ceiling has passed", async () => {
    const sweep = await sweepRetention(database, clockAt(CEILING_HOURS + 1));
    assert.equal(sweep.deleted, 1);
    assert.deepEqual(sweep.listings, [
      { sourceId: "bestbuy-api", listingId: "8880044" },
    ]);

    const row = await rowFor("8880044");
    assert.equal(row.raw_context, null);
  });

  it("is idempotent: a second sweep reports nothing to do", async () => {
    const sweep = await sweepRetention(database, clockAt(CEILING_HOURS + 2));
    assert.equal(sweep.deleted, 0);
  });

  it("runs as part of an ordinary collection run, with nobody asking it to", async () => {
    // "No operator action" is the criterion, so the sweep that matters is the
    // one a run does on its own. A fresh row is written by the real adapter,
    // then a later run - doing nothing but its ordinary work - ages it out.
    const writing = sourceHarness({
      answers: { "6428337": fixtureAnswer("product-not-on-sale.json") },
      clock: clockAt(0),
    });
    const dependencies = {
      registry: writing.registry,
      watchlist: memoryWatchlist([
        { sourceId: "bestbuy-api", listingId: "6428337", enabled: true },
      ]),
      writer: drizzleWriter(database),
      stops: memorySourceStops(),
      notifier: writing.notifier,
      stopPeriodMsFor: stopPeriodsFromGovernorConfig(writing.config),
      database,
    };

    await runCollection({
      ...dependencies,
      adapters: [
        bestBuyAdapter({
          governor: writing.governor,
          entry: writing.registry.require("bestbuy-api"),
          credential: TEST_CREDENTIAL,
        }),
      ],
      clock: writing.clock,
    });

    const fresh = await rowFor("6428337");
    assert.ok(fresh.raw_context !== null, "the run stored no raw content at all");
    assert.equal(fresh.retention_hours, String(CEILING_HOURS));

    // A later run. Its watchlist is empty, so it fetches nothing and asks for
    // nothing; the only thing it does is the sweep it always does.
    const later = sourceHarness({ clock: clockAt(CEILING_HOURS + 3) });
    const report = await runCollection({
      ...dependencies,
      adapters: [],
      watchlist: memoryWatchlist([]),
      clock: later.clock,
    });

    assert.ok(report.retention !== null);
    assert.ok(
      report.retention.listings.some((entry) => entry.listingId === "6428337"),
      "an ordinary run left content standing past its ceiling",
    );
    assert.equal((await rowFor("6428337")).raw_context, null);
  });
});

describe("criterion 10: the observation itself survives the deletion", () => {
  it("leaves price, currency, both instants, source and listing unchanged", async () => {
    const row = await rowFor("8880044");

    assert.equal(row.raw_context, null, "the content should already be gone");

    assert.equal(row.amount, "799");
    assert.equal(row.currency, "USD");
    assert.equal(new Date(row.observed_at ?? "").toISOString(), STORED_AT.toISOString());
    assert.equal(
      new Date(row.vendor_updated_at ?? "").toISOString(),
      VENDOR_UPDATED_AT.toISOString(),
    );
    assert.equal(row.source_id, "bestbuy-api");
    assert.equal(row.listing_id, "8880044");

    // And the rest of the row, which the criterion does not name but which a
    // sweep that used a DELETE would have taken with it.
    assert.equal(row.source_time_zone, "America/New_York");
    assert.equal(row.availability, "InStock");
    assert.equal(row.retention_hours, String(CEILING_HOURS));
  });

  it("keeps the row readable, so history still accrues on that listing", async () => {
    const rows = await query(
      container.url,
      "select count(*)::text as n from price_observations where listing_id = '8880044'",
    );
    assert.equal(rows[0].n, "1", "the sweep removed the observation, not the content");
  });
});

describe("criterion 11: a source with no declared ceiling keeps its content", () => {
  it("is untouched by a sweep long past every other source's ceiling", async () => {
    await sweepRetention(database, clockAt(24 * 365));
    const row = await rowFor("https://example.invalid/tools/hand-plane");
    assert.ok(
      row.raw_context !== null,
      "content from a source that declares no ceiling was deleted anyway",
    );
    assert.equal(row.retention_hours, null);
  });

  it("is not counted by the sweep either", async () => {
    const sweep = await sweepExpiredRawContent(database, new Date("2099-01-01T00:00:00.000Z"));
    assert.equal(sweep.deleted, 0);
    const row = await rowFor("https://example.invalid/tools/hand-plane");
    assert.ok(row.raw_context !== null);
  });
});
