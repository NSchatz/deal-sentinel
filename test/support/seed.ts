/**
 * Fixture-derived observations, and the reading of a stored row.
 *
 * The seed runs the real extractor over the real committed fixtures and writes
 * the results through the real write path. Nothing here fabricates a row: the
 * point of seeding this way is that the rows the restore proof compares are the
 * rows this system actually produces, failures and all.
 *
 * This file sits at the repo root rather than inside a package because it
 * composes two packages that must not depend on each other:
 * `@deal-sentinel/extractor` and `@deal-sentinel/db`. That is the seat a later
 * live adapter (SOURCE-3) will sit in.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { extractOffer } from "@deal-sentinel/extractor";
import type { ExtractionResult, ObservationContext } from "@deal-sentinel/shared";
import { recordObservation } from "@deal-sentinel/db";
import type { HistoryWriter, WriteOutcome } from "@deal-sentinel/db";

export const FIXTURES_DIR = fileURLToPath(
  new URL("../../packages/extractor/fixtures/", import.meta.url),
);

export function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

/**
 * One seed entry per fixture. The non-markup half of an observation (which
 * adapter, which listing, which zone) is what a live adapter would know and the
 * markup never carries, so it is stated here.
 */
export type SeedEntry = {
  fixture: string;
  context: ObservationContext;
};

export const SEED_ENTRIES: SeedEntry[] = [
  {
    fixture: "single-offer-clean.html",
    context: {
      sourceId: "fixture-suite",
      listingId: "https://example.invalid/tools/drill-18v-kit",
      observedAt: new Date("2026-08-24T13:05:00.000Z"),
      sourceTimeZone: "America/New_York",
      vendorPriceUpdatedAt: new Date("2026-08-23T21:14:00.000Z"),
      rawContextRetentionHours: 72,
      rawContext: "",
    },
  },
  {
    fixture: "single-offer-jpy.html",
    context: {
      sourceId: "fixture-suite",
      listingId: "https://example.invalid/tools/folding-saw-240",
      observedAt: new Date("2026-08-24T13:06:00.000Z"),
      sourceTimeZone: "Asia/Tokyo",
      rawContext: "",
    },
  },
  {
    fixture: "single-offer-kwd.html",
    context: {
      sourceId: "fixture-suite",
      listingId: "https://example.invalid/tools/router-bit-set",
      observedAt: new Date("2026-08-24T13:07:00.000Z"),
      sourceTimeZone: "Asia/Kuwait",
      rawContext: "",
    },
  },
  {
    fixture: "unrecognised-availability-token.html",
    context: {
      sourceId: "fixture-suite",
      listingId: "https://example.invalid/tools/benchtop-mortiser",
      observedAt: new Date("2026-08-24T13:08:00.000Z"),
      sourceTimeZone: "America/Chicago",
      rawContext: "",
    },
  },
  {
    fixture: "offer-without-availability.html",
    context: {
      sourceId: "fixture-suite",
      listingId: "https://example.invalid/tools/sanding-belt-pack",
      observedAt: new Date("2026-08-24T13:09:00.000Z"),
      sourceTimeZone: "America/New_York",
      rawContext: "",
    },
  },
  {
    fixture: "microdata-single-offer.html",
    context: {
      sourceId: "fixture-suite-microdata",
      listingId: "https://example.invalid/tools/cast-iron-bench-vice",
      observedAt: new Date("2026-08-24T13:10:00.000Z"),
      sourceTimeZone: "Europe/London",
      rawContext: "",
    },
  },
  // Every one of these refuses. They are seeded on purpose: "wrote nothing" is
  // an assertion, and a suite that only seeds the happy path never makes it.
  { fixture: "no-offer-markup.html", context: refusingContext("category-page") },
  { fixture: "two-variant-offers.html", context: refusingContext("two-variants") },
  { fixture: "aggregate-offer-range.html", context: refusingContext("range") },
  { fixture: "offer-without-price.html", context: refusingContext("no-price") },
  { fixture: "price-not-a-number.html", context: refusingContext("price-text") },
  {
    fixture: "price-without-currency.html",
    context: refusingContext("no-currency"),
  },
  {
    fixture: "currency-not-iso-4217.html",
    context: refusingContext("bad-currency"),
  },
];

function refusingContext(slug: string): ObservationContext {
  return {
    sourceId: "fixture-suite",
    listingId: `https://example.invalid/tools/${slug}`,
    observedAt: new Date("2026-08-24T13:20:00.000Z"),
    sourceTimeZone: "America/New_York",
    rawContext: "",
  };
}

export type SeedResult = {
  fixture: string;
  result: ExtractionResult;
  outcome: WriteOutcome;
};

/**
 * Extract every seed fixture and offer each result to the write path. The raw
 * context stored is the offer markup itself, which is what the fixture already
 * is: reduced to the offer, with no review body, reviewer name or account
 * identifier in it.
 */
export async function seedObservations(
  writer: HistoryWriter,
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const entry of SEED_ENTRIES) {
    const markup = readFixture(entry.fixture);
    const result = extractOffer(markup);
    const outcome = await recordObservation(writer, result, {
      ...entry.context,
      rawContext: markup,
    });
    results.push({ fixture: entry.fixture, result, outcome });
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Reading rows back, in a form two databases can be compared in                */
/* -------------------------------------------------------------------------- */

export type ComparableRow = Record<string, string | null>;

const OBSERVATION_COLUMNS = [
  "id",
  "source_id",
  "listing_id",
  "store_id",
  "amount_minor_units",
  "currency",
  "observed_at",
  "source_time_zone",
  "vendor_price_updated_at",
  "raw_context_retention_hours",
  "raw_context",
  "availability",
];

/**
 * Read every observation as text, column by column, ordered by id.
 *
 * Text on purpose: the comparison is "did every stored value come back", and
 * casting in SQL keeps a driver's own idea of bigint or Date out of the answer.
 * `md5(raw_context)` stands in for the raw context so a mismatch is still
 * caught without carrying kilobytes of markup through the assertion.
 */
export async function readObservations(url: string): Promise<ComparableRow[]> {
  const selected = OBSERVATION_COLUMNS.map((column) =>
    column === "raw_context"
      ? "md5(raw_context) as raw_context_md5"
      : `${column}::text as ${column}`,
  ).join(", ");
  return query(url, `select ${selected} from price_observations order by id`);
}

export async function readMarkerRows(url: string): Promise<ComparableRow[]> {
  return query(
    url,
    "select id::text, initialized_at::text, schema_version, note " +
      "from history_initialization order by id",
  );
}

export async function query(
  url: string,
  sql: string,
  values: unknown[] = [],
): Promise<ComparableRow[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(sql, values);
    return result.rows as ComparableRow[];
  } finally {
    await client.end();
  }
}
