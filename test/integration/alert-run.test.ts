/**
 * Acceptance criterion A17 of spec S0036-deal-sentinel-alert-4:
 *
 *   WHEN an evaluation run completes THE SYSTEM SHALL have written no price
 *   observation and modified no stored observation.
 *
 * Graded against a real PostgreSQL container, column by column. The whole
 * `price_observations` table is read before the run and after it and the two
 * readings are compared value for value, so a row that was added, removed or
 * edited anywhere is a failing test - including one edited in a column nobody
 * thought to assert on. Price history cannot be backfilled: the page a row came
 * from is gone a week later, so the run that READS it for a comparison is the
 * one place this property is worth proving rather than reasoning about.
 *
 * The run is a real one and not a no-op, which is what stops this test passing
 * vacuously: it fires an alert, skips a listing with no history, refuses a
 * listing whose window mixes two currencies, and its own cooldown bookkeeping
 * does get written - to its own table.
 *
 * The one endpoint in this file is the local Postgres container.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { runAlertEvaluation } from "@deal-sentinel/alerts";
import {
  addWatchlistEntry,
  createDatabase,
  drizzleAlertCooldowns,
  drizzleAlertListings,
  drizzleObservationHistory,
  drizzleWriter,
  initializeHistory,
  recordObservation,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";

import { DAY_MS, recordingChannel, testAlertConfig } from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";
import {
  destroyPostgres,
  dockerCanRunContainers,
  startPostgres,
} from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query, readObservations } from "../support/seed.ts";

const SOURCE = "bestbuy-api";
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

/** A listing that fires, one with no history, and one that mixes currencies. */
const FIRES = "8880044";
const NO_HISTORY = "8880045";
const MIXED = "8880046";

let container: PostgresContainer;

const dockerUsable = await dockerCanRunContainers();
const skip = dockerUsable
  ? false
  : "this machine's Docker cannot start a container, so a run's effect on real " +
    "stored observations cannot be exercised here";

before(async () => {
  if (!dockerUsable) return;
  container = await startPostgres("alert-run");

  const pool = new pg.Pool({ connectionString: container.url });
  try {
    await initializeHistory(pool, { note: "alert run suite" });
    const database = createDatabase(pool);

    for (const listingId of [FIRES, NO_HISTORY, MIXED]) {
      await addWatchlistEntry(database, {
        sourceId: SOURCE,
        listingId,
        listingUrl: `https://www.example.invalid/site/${listingId}.p`,
      });
    }

    await seed(database);
  } finally {
    await pool.end();
  }
}, { timeout: 300_000 });

after(async () => {
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

async function seed(database: HistoryDatabase): Promise<void> {
  const writer = drizzleWriter(database);

  const rows: [string, bigint, string, number][] = [
    // The listing that fires: three observations behind it, then a low.
    [FIRES, 12_999n, "USD", 5],
    [FIRES, 10_999n, "USD", 4],
    [FIRES, 11_999n, "USD", 3],
    [FIRES, 8_999n, "USD", 0],
    // The listing with nothing inside the window: one observation, far too old.
    [NO_HISTORY, 4_999n, "USD", 400],
    // The listing whose window mixes two currencies.
    [MIXED, 12_999n, "USD", 5],
    [MIXED, 10_999n, "USD", 4],
    [MIXED, 9_000n, "JPY", 3],
    [MIXED, 1_999n, "USD", 0],
  ];

  for (const [listingId, amountMinorUnits, currency, daysAgo] of rows) {
    const written = await recordObservation(
      writer,
      { ok: true, amountMinorUnits, currency, availability: "InStock" },
      {
        sourceId: SOURCE,
        listingId,
        observedAt: new Date(NOW - daysAgo * DAY_MS),
        sourceTimeZone: "America/New_York",
        rawContextRetentionHours: 24,
        rawContext: `<offer listing="${listingId}"/>`,
      },
    );
    assert.equal(written.written, true);
  }
}

describe("an evaluation run writes and modifies no price observation", { skip }, () => {
  it("leaves every stored observation exactly as it found it", { timeout: 300_000 }, async () => {
    const before_ = await readObservations(container.url);
    assert.equal(before_.length, 9, "the suite did not seed what it thinks it seeded");

    const pool = new pg.Pool({ connectionString: container.url });
    const database = createDatabase(pool);
    const channel = recordingChannel();

    let report;
    try {
      report = await runAlertEvaluation({
        config: testAlertConfig(),
        listings: drizzleAlertListings(database),
        history: drizzleObservationHistory(database),
        cooldowns: drizzleAlertCooldowns(database),
        channel,
        clock: new FakeClock(NOW),
        sourceIds: [SOURCE],
      });
    } finally {
      await pool.end();
    }

    // The run was a real one. A test that proved "wrote nothing" about a run
    // that did nothing would prove nothing at all.
    const source = report.sources[0];
    assert.deepEqual(source.considered, [FIRES, NO_HISTORY, MIXED]);
    assert.equal(source.delivered.length, 1);
    assert.equal(source.delivered[0].listingId, FIRES);
    assert.equal(source.delivered[0].observedMinorUnits, 8_999n);
    assert.equal(source.delivered[0].referenceMinorUnits, 10_999n);
    assert.equal(source.skipped.length, 1);
    assert.equal(source.skipped[0].listingId, NO_HISTORY);
    assert.equal(source.mismatches.length, 1);
    assert.equal(source.mismatches[0].listingId, MIXED);
    assert.equal(channel.delivered.length, 1);

    // And the history is untouched, column for column.
    const after_ = await readObservations(container.url);
    assert.deepEqual(
      after_,
      before_,
      "the evaluation run changed the price history it was only reading",
    );

    // Its own bookkeeping did get written, which is the other half of the
    // property: the run is not simply unable to write.
    const cooldowns = await query(
      container.url,
      "select listing_id, rule_id from alert_cooldowns order by listing_id",
    );
    assert.deepEqual(cooldowns, [{ listing_id: FIRES, rule_id: "window-low-test" }]);
  });

  it("adds no observation for a listing it alerted on, on a second run", { timeout: 300_000 }, async () => {
    const before_ = await readObservations(container.url);

    const pool = new pg.Pool({ connectionString: container.url });
    const database = createDatabase(pool);
    try {
      await runAlertEvaluation({
        config: testAlertConfig(),
        listings: drizzleAlertListings(database),
        history: drizzleObservationHistory(database),
        cooldowns: drizzleAlertCooldowns(database),
        channel: recordingChannel(),
        clock: new FakeClock(NOW + 60_000),
        sourceIds: [SOURCE],
      });
    } finally {
      await pool.end();
    }

    assert.deepEqual(await readObservations(container.url), before_);
  });
});
