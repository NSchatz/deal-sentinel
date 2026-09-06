/**
 * Acceptance criteria 4 and 15 of spec S0033-deal-sentinel-source-3, against
 * real PostgreSQL and a STUBBED 403:
 *
 *   4. IF a source answers 403 THEN THE SYSTEM SHALL stop that source for the
 *      period and notify once, rather than retry it.
 *  15. WHEN one source has been stopped for the period after a 403 THE SYSTEM
 *      SHALL leave every other source running.
 *
 * The vendor documents that status twice: its terms say "If a request is made
 * after the limit is reached, it results in an error response with a 403 status
 * code", and its own error table reads 403 as "The API key is not valid, or the
 * allocated call limit has been exceeded". Only the vendor knows which of the
 * two it meant, and neither is improved by asking again, so both readings have
 * the same answer: stop, notify once, do not retry.
 *
 * "For the period" is graded across a RESTART, because a stop held in one
 * process's memory is a stop that a crash loop erases - which is exactly when
 * an exhausted allowance would otherwise be hammered a second time. The second
 * run below shares nothing with the first except the database.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";

import {
  createDatabase,
  drizzleSourceStops,
  drizzleWriter,
  initializeHistory,
  memoryWatchlist,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { periodStartFor } from "@deal-sentinel/governor";
import {
  bestBuyAdapter,
  runCollection,
  stopPeriodsFromGovernorConfig,
} from "@deal-sentinel/sources";
import type { SourceAdapter } from "@deal-sentinel/sources";

import { FakeClock } from "../support/fake-clock.ts";
import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import {
  SECOND_SOURCE_ID,
  TEST_CREDENTIAL,
  bestBuyGovernorConfig,
  fixtureAnswer,
  limitExceededAnswer,
  sourceHarness,
  twoSourceRegistry,
} from "../support/source-3-harness.ts";
import type { SourceHarness } from "../support/source-3-harness.ts";

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;

/** Three listings for the stopping source: the 403 lands on the first. */
const STOPPING_LISTINGS = ["8880044", "6428337", "5901234"];
/** One listing for the other source, which must keep running. */
const SURVIVING_LISTING = "1299001";

const config = bestBuyGovernorConfig();
const registry = twoSourceRegistry();
const PERIOD_MS = config.sources["bestbuy-api"].allowance?.periodMs ?? 0;

before(async () => {
  container = await startPostgres("source-3-403");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "source-3 403 suite" });
  database = createDatabase(pool);
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

beforeEach(async () => {
  await query(container.url, "delete from source_period_stops");
  await query(container.url, "delete from price_observations");
});

/** The source that answers 403 on every product call. */
function stoppingAdapter(harness: SourceHarness): SourceAdapter {
  return bestBuyAdapter({
    governor: harness.governor,
    entry: harness.registry.require("bestbuy-api"),
    credential: TEST_CREDENTIAL,
  });
}

/** The other source, answering normally, on a different host. */
function survivingAdapter(harness: SourceHarness): SourceAdapter {
  return bestBuyAdapter({
    governor: harness.governor,
    entry: harness.registry.require(SECOND_SOURCE_ID),
    credential: "a-second-credential",
  });
}

function harnessAnswering403(): SourceHarness {
  return sourceHarness({
    config,
    registry,
    answers: {
      // Every listing of the stopping source answers with the documented 403.
      "8880044": limitExceededAnswer(),
      "6428337": limitExceededAnswer(),
      "5901234": limitExceededAnswer(),
      // The other source's listing answers normally.
      [SURVIVING_LISTING]: fixtureAnswer("product-whole-number-price.json"),
    },
  });
}

function runWith(harness: SourceHarness, adapters: SourceAdapter[]) {
  return runCollection({
    adapters,
    registry,
    watchlist: memoryWatchlist([
      ...STOPPING_LISTINGS.map((listingId) => ({
        sourceId: "bestbuy-api",
        listingId,
        enabled: true,
      })),
      { sourceId: SECOND_SOURCE_ID, listingId: SURVIVING_LISTING, enabled: true },
    ]),
    writer: drizzleWriter(database),
    stops: drizzleSourceStops(database),
    notifier: harness.notifier,
    clock: harness.clock,
    stopPeriodMsFor: stopPeriodsFromGovernorConfig(config),
    database,
  });
}

function productRequests(harness: SourceHarness): string[] {
  return harness.transport.sent
    .filter((request) => new URL(request.url).pathname !== "/robots.txt")
    .map((request) => new URL(request.url).pathname);
}

describe("criterion 4: a 403 stops the source for the period and notifies once", () => {
  it("stops the source rather than retrying the entry", async () => {
    const harness = harnessAnswering403();
    const report = await runWith(harness, [stoppingAdapter(harness)]);

    const stopping = report.sources[0];
    assert.equal(stopping.sourceId, "bestbuy-api");
    assert.ok(stopping.stopped !== null, "the source was not stopped by a 403");
    assert.equal(stopping.observed.length, 0);

    // ONE request, for the first listing. Not two for it, and not one for each
    // of the three: the stop happens at the first 403 and nothing else is
    // asked.
    assert.deepEqual(productRequests(harness), ["/v1/products/8880044.json"]);
    assert.deepEqual(stopping.attempted, ["8880044"]);
  });

  it("records the stop durably, keyed to the source and the period", async () => {
    const harness = harnessAnswering403();
    await runWith(harness, [stoppingAdapter(harness)]);

    const rows = await query(
      container.url,
      "select source_id, period_start::text as period_start, reason, " +
        "notified_at::text as notified_at from source_period_stops",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_id, "bestbuy-api");
    assert.equal(
      new Date(rows[0].period_start ?? "").toISOString(),
      periodStartFor(harness.clock.now(), PERIOD_MS).toISOString(),
    );
    assert.match(rows[0].reason ?? "", /403/);
    assert.ok(rows[0].notified_at !== null, "the stop was recorded without notifying");
    assert.ok(
      !(rows[0].reason ?? "").includes(TEST_CREDENTIAL),
      "the stored reason carries the credential",
    );
  });

  it("notifies exactly once, and says which source", async () => {
    const harness = harnessAnswering403();
    await runWith(harness, [stoppingAdapter(harness)]);

    const notifications = harness.notifier.of("source-limit-exceeded");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].sourceId, "bestbuy-api");
    assert.match(notifications[0].detail, /stopped/);
    assert.ok(!notifications[0].detail.includes(TEST_CREDENTIAL));
  });

  it("issues NOTHING on a second run in the same period, and does not notify again", async () => {
    const first = harnessAnswering403();
    await runWith(first, [stoppingAdapter(first)]);

    // A whole new process would look exactly like this: a new governor, a new
    // transport, a new notifier, a new clock inside the same period. The only
    // thing carried over is the database.
    const second = harnessAnswering403();
    const report = await runWith(second, [stoppingAdapter(second)]);

    assert.deepEqual(productRequests(second), []);
    assert.equal(report.sources[0].skippedBecauseStopped, true);
    assert.deepEqual(report.sources[0].attempted, []);
    assert.equal(second.notifier.of("source-limit-exceeded").length, 0);

    const rows = await query(
      container.url,
      "select count(*)::text as n from source_period_stops",
    );
    assert.equal(rows[0].n, "1", "a second stop row was written for one period");
  });

  it("runs again once the period has turned over", async () => {
    const first = harnessAnswering403();
    await runWith(first, [stoppingAdapter(first)]);

    // A new period is a new row, by the key, so nothing had to be reset.
    const next = sourceHarness({
      config,
      registry,
      answers: { "8880044": fixtureAnswer("product-on-sale.json") },
      clock: new FakeClock(first.clock.now() + PERIOD_MS),
    });
    const report = await runWith(next, [stoppingAdapter(next)]);

    assert.equal(report.sources[0].skippedBecauseStopped, false);
    assert.ok(productRequests(next).length > 0, "the next period issued nothing");
    assert.equal(report.sources[0].observed.length, 1);
  });

  it("writes no observation for the entry that was refused", async () => {
    const harness = harnessAnswering403();
    await runWith(harness, [stoppingAdapter(harness)]);
    const rows = await query(
      container.url,
      "select count(*)::text as n from price_observations where source_id = 'bestbuy-api'",
    );
    assert.equal(rows[0].n, "0");
  });
});

describe("criterion 15: one source stopping leaves every other source running", () => {
  it("keeps the other source fetching, and writing, in the same run", async () => {
    const harness = harnessAnswering403();
    const report = await runWith(harness, [
      stoppingAdapter(harness),
      survivingAdapter(harness),
    ]);

    const [stopped, surviving] = report.sources;
    assert.equal(stopped.sourceId, "bestbuy-api");
    assert.ok(stopped.stopped !== null);

    assert.equal(surviving.sourceId, SECOND_SOURCE_ID);
    assert.equal(surviving.stopped, null);
    assert.deepEqual(surviving.attempted, [SURVIVING_LISTING]);
    assert.equal(surviving.observed.length, 1);

    const rows = await query(
      container.url,
      "select source_id, listing_id, amount_minor_units::text as amount " +
        "from price_observations",
    );
    assert.deepEqual(rows, [
      { source_id: SECOND_SOURCE_ID, listing_id: SURVIVING_LISTING, amount: "129900" },
    ]);
  });

  it("stops only the source that answered, and says so in the store", async () => {
    const harness = harnessAnswering403();
    await runWith(harness, [stoppingAdapter(harness), survivingAdapter(harness)]);

    const rows = await query(
      container.url,
      "select source_id from source_period_stops order by source_id",
    );
    assert.deepEqual(
      rows.map((row) => row.source_id),
      ["bestbuy-api"],
      "the stop spread to a source that never answered 403",
    );
  });

  it("keeps the other source running on the NEXT run too", async () => {
    const first = harnessAnswering403();
    await runWith(first, [stoppingAdapter(first), survivingAdapter(first)]);

    const second = harnessAnswering403();
    const report = await runWith(second, [
      stoppingAdapter(second),
      survivingAdapter(second),
    ]);

    assert.equal(report.sources[0].skippedBecauseStopped, true);
    assert.equal(report.sources[1].skippedBecauseStopped, false);
    assert.deepEqual(report.sources[1].attempted, [SURVIVING_LISTING]);
    assert.deepEqual(productRequests(second), [`/v1/products/${SURVIVING_LISTING}.json`]);
  });

  it("emits one notification for the one source that stopped", async () => {
    const harness = harnessAnswering403();
    await runWith(harness, [stoppingAdapter(harness), survivingAdapter(harness)]);
    const notifications = harness.notifier.of("source-limit-exceeded");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].sourceId, "bestbuy-api");
  });
});
