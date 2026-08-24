/**
 * Acceptance criteria 1, 2 and 3, against real PostgreSQL:
 *
 *   1. a fixture the extractor cannot resolve records a typed failure and
 *      writes NO price observation;
 *   2. a stored observation carries the amount as an exact integer minor unit
 *      and the source's local time zone beside the timezone-aware instant;
 *   3. an availability token is stored as received, including one the system
 *      does not recognise.
 *
 * The rows here are produced by the real extractor over the real committed
 * fixtures, through the real write path. Nothing is inserted by hand.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, drizzleWriter, initializeHistory } from "@deal-sentinel/db";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query, readObservations, seedObservations } from "../support/seed.ts";
import type { SeedResult } from "../support/seed.ts";

let container: PostgresContainer;
let pool: pg.Pool;
let seeded: SeedResult[];

before(async () => {
  container = await startPostgres("write-path");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "write-path integration suite" });
  seeded = await seedObservations(drizzleWriter(createDatabase(pool)));
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

function outcomeFor(fixture: string): SeedResult {
  const found = seeded.find((entry) => entry.fixture === fixture);
  assert.ok(found, `no seed entry for ${fixture}`);
  return found;
}

describe("criterion 1: a typed failure writes nothing", () => {
  const refusing = [
    ["no-offer-markup.html", "no-offer"],
    ["two-variant-offers.html", "ambiguous-offer"],
    ["aggregate-offer-range.html", "ambiguous-offer"],
    // The same refusals in the other markup dialect. A page that refuses as
    // JSON-LD and resolves as microdata is a wrong price with a clean suite.
    ["microdata-two-offers.html", "ambiguous-offer"],
    ["microdata-aggregate-offer-range.html", "ambiguous-offer"],
    ["microdata-two-prices-one-offer.html", "ambiguous-offer"],
    ["offer-without-price.html", "no-price"],
    ["price-not-a-number.html", "no-price"],
    ["negative-price.html", "no-price"],
    ["price-without-currency.html", "no-currency"],
    ["currency-not-iso-4217.html", "no-currency"],
  ] as const;

  for (const [fixture, reason] of refusing) {
    it(`${fixture} records ${reason} and no row`, async () => {
      const entry = outcomeFor(fixture);
      assert.equal(entry.result.ok, false);
      assert.equal(entry.outcome.written, false);
      assert.equal(entry.outcome.written === false && entry.outcome.reason, reason);

      const rows = await query(
        container.url,
        "select count(*)::text as count from price_observations where listing_id = $1",
        [listingIdFor(fixture)],
      );
      assert.equal(rows[0].count, "0");
    });
  }

  it("stored exactly as many rows as there were resolvable fixtures", async () => {
    const written = seeded.filter((entry) => entry.outcome.written).length;
    const refused = seeded.filter((entry) => !entry.outcome.written).length;
    assert.equal(refused, refusing.length);

    const rows = await query(
      container.url,
      "select count(*)::text as count from price_observations",
    );
    assert.equal(rows[0].count, String(written));
  });
});

describe("criterion 2: exact integer minor units, and the source's zone", () => {
  it("stores USD 129.99 as 12999, in a bigint column", async () => {
    const rows = await query(
      container.url,
      "select amount_minor_units::text as amount, currency, " +
        "pg_typeof(amount_minor_units)::text as type " +
        "from price_observations where listing_id = $1",
      ["https://example.invalid/tools/drill-18v-kit"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, "12999");
    assert.equal(rows[0].currency, "USD");
    assert.equal(rows[0].type, "bigint");
  });

  it("stores JPY by its own exponent of 0: 12800 yen is 12800 minor units", async () => {
    const rows = await query(
      container.url,
      "select amount_minor_units::text as amount, currency, source_time_zone " +
        "from price_observations where listing_id = $1",
      ["https://example.invalid/tools/folding-saw-240"],
    );
    assert.equal(rows[0].amount, "12800");
    assert.equal(rows[0].currency, "JPY");
    assert.equal(rows[0].source_time_zone, "Asia/Tokyo");
  });

  it("stores KWD by its own exponent of 3: 12.995 dinars is 12995 fils", async () => {
    const rows = await query(
      container.url,
      "select amount_minor_units::text as amount, currency " +
        "from price_observations where listing_id = $1",
      ["https://example.invalid/tools/router-bit-set"],
    );
    assert.equal(rows[0].amount, "12995");
    assert.equal(rows[0].currency, "KWD");
  });

  it("keeps the instant timezone-aware and the source zone beside it", async () => {
    const rows = await query(
      container.url,
      "select pg_typeof(observed_at)::text as instant_type, " +
        "to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SSZ') as utc, " +
        "to_char(observed_at at time zone source_time_zone, 'YYYY-MM-DD HH24:MI') as local, " +
        "source_time_zone, " +
        "vendor_price_updated_at::text as vendor, " +
        "raw_context_retention_hours::text as retention " +
        "from price_observations where listing_id = $1",
      ["https://example.invalid/tools/drill-18v-kit"],
    );

    assert.equal(rows[0].instant_type, "timestamp with time zone");
    assert.equal(rows[0].utc, "2026-08-24T13:05:00Z");
    // The retailer's local day is what a 90-day low is anchored to, and it is
    // only reachable because the zone is stored beside the instant: timestamptz
    // does not retain the input zone.
    assert.equal(rows[0].local, "2026-08-24 09:05");
    assert.equal(rows[0].source_time_zone, "America/New_York");
    assert.ok(rows[0].vendor !== null, "the vendor's own timestamp is recorded");
    assert.equal(rows[0].retention, "72");
  });

  it("leaves the vendor timestamp and retention null where the source has none", async () => {
    const rows = await query(
      container.url,
      "select vendor_price_updated_at::text as vendor, " +
        "raw_context_retention_hours::text as retention " +
        "from price_observations where listing_id = $1",
      ["https://example.invalid/tools/folding-saw-240"],
    );
    assert.equal(rows[0].vendor, null);
    assert.equal(rows[0].retention, null);
  });

  it("stores the microdata offer's OWN price, not the item's above it", async () => {
    const rows = await query(
      container.url,
      "select amount_minor_units::text as amount, currency " +
        "from price_observations where listing_id = $1",
      ["https://example.invalid/tools/table-saw"],
    );
    assert.equal(rows.length, 1);
    // The accessory above the offer is 9.99, which is 999 minor units. A
    // document-wide itemprop scan stores THAT against this listing and never
    // reads the offer's own 349.00 at all.
    assert.equal(rows[0].amount, "34900");
    assert.equal(rows[0].currency, "USD");
  });

  it("stores one price stated twice in one offer once, at its value", async () => {
    const rows = await query(
      container.url,
      "select amount_minor_units::text as amount from price_observations " +
        "where listing_id = $1",
      ["https://example.invalid/tools/digital-caliper"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, "12999");
  });

  it("holds no negative amount: a price below zero never becomes a row", async () => {
    const rows = await query(
      container.url,
      "select count(*)::text as count from price_observations " +
        "where amount_minor_units < 0",
    );
    assert.equal(rows[0].count, "0");
  });

  it("leaves the store id null: it is HARD-8's dimension, not this phase's", async () => {
    const rows = await query(
      container.url,
      "select count(*)::text as populated from price_observations where store_id is not null",
    );
    assert.equal(rows[0].populated, "0");
  });
});

describe("criterion 3: the availability token is stored as received", () => {
  it("keeps a token outside the twelve documented members", async () => {
    const rows = await query(
      container.url,
      "select availability from price_observations where listing_id = $1",
      ["https://example.invalid/tools/benchtop-mortiser"],
    );
    assert.equal(rows[0].availability, "https://schema.org/ShipsInTwoToThreeWeeks");
  });

  it("keeps a token that is not InStock or OutOfStock", async () => {
    const rows = await query(
      container.url,
      "select availability from price_observations where listing_id = $1",
      ["https://example.invalid/tools/router-bit-set"],
    );
    assert.equal(rows[0].availability, "https://schema.org/LimitedAvailability");
  });

  it("records an absent availability as null, not as a boolean or a guess", async () => {
    const rows = await query(
      container.url,
      "select availability from price_observations where listing_id = $1",
      ["https://example.invalid/tools/sanding-belt-pack"],
    );
    assert.equal(rows[0].availability, null);
  });

  it("stores no boolean anywhere in the availability column", async () => {
    const rows = await query(
      container.url,
      "select pg_typeof(availability)::text as type from price_observations limit 1",
    );
    assert.equal(rows[0].type, "text");
  });
});

describe("the stored rows are readable as a set", () => {
  it("reads back every column of every row", async () => {
    const rows = await readObservations(container.url);
    assert.equal(rows.length, seeded.filter((entry) => entry.outcome.written).length);
    for (const row of rows) {
      assert.equal(row.store_id, null);
      assert.match(String(row.currency), /^[A-Z]{3}$/);
      // No sign: a stored amount is a non-negative exact integer minor unit.
      assert.match(String(row.amount_minor_units), /^\d+$/);
      assert.ok(String(row.source_time_zone).length > 0);
    }
  });
});

function listingIdFor(fixture: string): string {
  const slugs: Record<string, string> = {
    "no-offer-markup.html": "category-page",
    "two-variant-offers.html": "two-variants",
    "aggregate-offer-range.html": "range",
    "offer-without-price.html": "no-price",
    "price-not-a-number.html": "price-text",
    "negative-price.html": "negative-price",
    "price-without-currency.html": "no-currency",
    "currency-not-iso-4217.html": "bad-currency",
    "microdata-two-offers.html": "microdata-two-offers",
    "microdata-aggregate-offer-range.html": "microdata-range",
    "microdata-two-prices-one-offer.html": "microdata-two-prices",
  };
  return `https://example.invalid/tools/${slugs[fixture]}`;
}
