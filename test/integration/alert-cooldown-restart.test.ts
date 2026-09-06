/**
 * Acceptance criterion A3 of spec S0036-deal-sentinel-alert-4:
 *
 *   WHEN a rule has fired for a listing THE SYSTEM SHALL send no further
 *   notification for that listing and rule until that rule's configured
 *   cooldown has elapsed, and that suppression SHALL survive a process restart
 *   between the two evaluations.
 *
 * This test does not mock the store, for the same reason
 * `governor-allowance-restart.test.ts` does not: a suppression that was
 * simulated proves nothing about a container that comes back. It starts a real
 * PostgreSQL container, runs the real migrations, seeds real observations
 * through the real write path, fires an alert through one process, THROWS THAT
 * PROCESS AWAY - its pool, its store handle, every byte of its memory - builds
 * a second one against the same database, and asserts the second one stays
 * quiet.
 *
 * Then it advances past the cooldown and asserts the alert comes back, because
 * a suppression that never lifts is not a cooldown, it is a bug that looks like
 * peace and quiet.
 *
 * The one endpoint in this file is the local Postgres container. The channel is
 * a recording stub: what a channel does on the wire is graded in
 * `test/unit/alert-channel.test.ts`, and what is under test here is whether the
 * suppression survives the process.
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
import type { RecordingChannel } from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";
import {
  destroyPostgres,
  dockerCanRunContainers,
  startPostgres,
} from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";

const SOURCE = "bestbuy-api";
const LISTING = "8880044";
const RULE = "window-low-test";
const LINK = "https://www.example.invalid/site/cordless-drill/8880044.p";
/** The cooldown the harness configuration carries. */
const COOLDOWN_MS = 7 * DAY_MS;

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

let container: PostgresContainer;

const dockerUsable = await dockerCanRunContainers();
const skip = dockerUsable
  ? false
  : "this machine's Docker cannot start a container, so a cooldown that " +
    "survives a restart cannot be exercised against real PostgreSQL here";

before(async () => {
  if (!dockerUsable) return;
  container = await startPostgres("alert-cooldown");

  const pool = new pg.Pool({ connectionString: container.url });
  try {
    await initializeHistory(pool, { note: "alert cooldown restart suite" });
    const database = createDatabase(pool);
    await addWatchlistEntry(database, {
      sourceId: SOURCE,
      listingId: LISTING,
      listingUrl: LINK,
      note: "the alert cooldown restart suite",
    });
    await seedSeries(database);
  } finally {
    await pool.end();
  }
}, { timeout: 300_000 });

after(async () => {
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

/**
 * A synthetic series whose last observation beats the rest by more than the
 * configured margin. Written through the REAL write path, so the rows the rule
 * reads are the rows this system actually produces.
 */
async function seedSeries(database: HistoryDatabase): Promise<void> {
  const writer = drizzleWriter(database);
  const series: [bigint, number][] = [
    [12_999n, 5],
    [10_999n, 4],
    [11_999n, 3],
    [8_999n, 0],
  ];
  for (const [amountMinorUnits, daysAgo] of series) {
    const written = await recordObservation(
      writer,
      { ok: true, amountMinorUnits, currency: "USD", availability: "InStock" },
      {
        sourceId: SOURCE,
        listingId: LISTING,
        observedAt: new Date(NOW - daysAgo * DAY_MS),
        sourceTimeZone: "America/New_York",
        rawContextRetentionHours: 24,
        rawContext: "<offer/>",
      },
    );
    assert.equal(written.written, true);
  }
}

/**
 * One process's worth of evaluation: its own pool, its own store handles, its
 * own memory. Closing the pool is what "the process went away" means.
 */
function startProcess(atMs: number): {
  run: () => Promise<{ delivered: number; suppressed: number }>;
  channel: RecordingChannel;
  stop: () => Promise<void>;
} {
  const pool = new pg.Pool({ connectionString: container.url });
  const database = createDatabase(pool);
  const channel = recordingChannel();

  return {
    channel,
    async run() {
      const report = await runAlertEvaluation({
        config: testAlertConfig(),
        listings: drizzleAlertListings(database),
        history: drizzleObservationHistory(database),
        cooldowns: drizzleAlertCooldowns(database),
        channel,
        clock: new FakeClock(atMs),
        sourceIds: [SOURCE],
      });
      const source = report.sources[0];
      return { delivered: source.delivered.length, suppressed: source.suppressed.length };
    },
    stop: async () => {
      await pool.end();
    },
  };
}

async function storedCooldowns(): Promise<Record<string, string>[]> {
  return query(
    container.url,
    "select source_id, listing_id, rule_id, " +
      // Read as epoch milliseconds: PostgreSQL's own text form of a
      // `timestamptz` carries a "+00" offset that `Date` does not parse, and a
      // NaN compares false against everything without ever saying so.
      "(extract(epoch from fired_at) * 1000)::bigint::text as fired_at_ms, " +
      "amount_minor_units::text as amount_minor_units, currency " +
      "from alert_cooldowns order by listing_id, rule_id",
  ) as Promise<Record<string, string>[]>;
}

describe("the cooldown survives the process that wrote it", { skip }, () => {
  it("suppresses the second evaluation after a restart, then lets it through", { timeout: 300_000 }, async () => {
    // ---- first process: the alert fires ----
    const first = startProcess(NOW);
    const firstRun = await first.run();
    assert.equal(firstRun.delivered, 1, "the seeded series did not fire the rule");
    assert.equal(first.channel.delivered.length, 1);
    assert.match(first.channel.delivered[0].body, /USD 89\.99/);

    const rows = await storedCooldowns();
    assert.equal(rows.length, 1, "the delivered alert recorded no durable cooldown");
    assert.equal(rows[0].source_id, SOURCE);
    assert.equal(rows[0].listing_id, LISTING);
    assert.equal(rows[0].rule_id, RULE);
    assert.equal(rows[0].amount_minor_units, "8999");
    assert.equal(rows[0].currency, "USD");
    assert.equal(Number(rows[0].fired_at_ms), NOW);

    await first.stop();

    // ---- the process restarts, INSIDE the cooldown ----
    const second = startProcess(NOW + DAY_MS);
    const secondRun = await second.run();

    assert.deepEqual(
      second.channel.asked,
      [],
      "the restart re-sent an alert the owner had already had, which is the " +
        "failure mode BRIEF.md section 7 names as the one that kills these tools",
    );
    assert.equal(secondRun.delivered, 0);
    assert.equal(secondRun.suppressed, 1);
    assert.equal((await storedCooldowns()).length, 1, "a second row appeared for one alert");
    await second.stop();

    // ---- a third process, one minute before the cooldown expires ----
    const third = startProcess(NOW + COOLDOWN_MS - 60_000);
    const thirdRun = await third.run();
    assert.equal(thirdRun.suppressed, 1, "the cooldown lifted a minute early");
    assert.deepEqual(third.channel.asked, []);
    await third.stop();

    // ---- a fourth, after it: a cooldown that never lifts is not a cooldown ----
    const fourth = startProcess(NOW + COOLDOWN_MS + 60_000);
    const fourthRun = await fourth.run();
    assert.equal(fourthRun.delivered, 1, "the cooldown never lifted");
    assert.equal(fourth.channel.delivered.length, 1);

    const after = await storedCooldowns();
    assert.equal(after.length, 1, "the second firing added a row instead of moving the instant");
    assert.equal(
      Number(after[0].fired_at_ms),
      NOW + COOLDOWN_MS + 60_000,
      "the second firing did not move the cooldown forward",
    );
    await fourth.stop();
  });
});
