/**
 * Acceptance criterion 6 of spec S0042-deal-sentinel-ops-5, against real
 * PostgreSQL:
 *
 *   IF recording a fetch's outcome fails for any reason THEN THE SYSTEM SHALL
 *   complete the collection run, SHALL still store the observation that fetch
 *   produced, and SHALL NOT retry the fetch, re-offer it to the governor, or
 *   spend any further allowance on account of the failed recording.
 *
 * THIS IS THE CRITERION THE REPOSITORY CARD IS ABOUT. This system "acts on third
 * parties from the household's residential IP, and keeping that IP in good
 * standing is part of the point, so a runaway scraper burns something the whole
 * house depends on and no re-run undoes it". A telemetry write that threw into a
 * caller, and a caller that did the honest thing with an exception, is that
 * runaway - assembled out of an observability feature that was supposed to be
 * the safe part of the phase.
 *
 * So it is graded against the REAL collection run, with the REAL write path, on
 * a REAL database, and the failure is a real one: the table the sink writes to is
 * dropped out from under it. The assertions are about what the transport saw
 * (one request per listing, and no more), what the history holds (every
 * observation), and what the durable allowance counter says (one unit per
 * request that left, and no more).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import {
  addWatchlistEntry,
  createDatabase,
  drizzleBreakerPauses,
  drizzleFetchOutcomes,
  drizzleWatchlist,
  drizzleWriter,
  initializeHistory,
  memorySourceStops,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { createPostgresAllowanceStore, periodStartFor } from "@deal-sentinel/governor";
import {
  bestBuyAdapter,
  redactedTelemetry,
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
  testRegistry,
} from "../support/source-3-harness.ts";
import type { SourceHarness } from "../support/source-3-harness.ts";

const WATCHED: [string, string][] = [
  ["8880044", "product-on-sale.json"],
  ["6428337", "product-not-on-sale.json"],
  ["5901234", "product-no-price-update-date.json"],
];

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let harness: SourceHarness;
let report: CollectionRunReport;
/** Every failure the sink reported. Non-empty is what makes this suite real. */
const recordFailures: unknown[] = [];

before(async () => {
  container = await startPostgres("ops-5-telemetry-write-failure");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 write-failure suite" });
  database = createDatabase(pool);

  for (const [listingId] of WATCHED) {
    await addWatchlistEntry(database, { sourceId: "bestbuy-api", listingId });
  }

  // THE FAILURE, and it is a real one rather than a stub that throws: the table
  // the sink writes to is gone. Every insert it attempts raises an undefined-table
  // error out of the driver, which is exactly what a database one migration
  // behind, a revoked grant or a disk full would produce.
  await query(container.url, "drop table fetch_outcomes");

  harness = sourceHarness({
    answers: Object.fromEntries(
      WATCHED.map(([listingId, fixture]) => [listingId, fixtureAnswer(fixture)]),
    ),
    allowanceStore: createPostgresAllowanceStore(database),
    telemetry: redactedTelemetry({
      outcomes: drizzleFetchOutcomes(database),
      pauses: drizzleBreakerPauses(database),
      registry: testRegistry(),
      redactor: { scrub: (text) => text },
      onRecordFailure: (error) => recordFailures.push(error),
    }),
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

describe("criterion 6: a failed recording does not reach the fetch path", () => {
  it("the recording really did fail, which is what makes the rest mean anything", () => {
    assert.ok(
      recordFailures.length > 0,
      "no telemetry write failed, so this suite is asserting nothing at all",
    );
    for (const failure of recordFailures) {
      assert.match(
        failure instanceof Error ? failure.message : String(failure),
        /fetch_outcomes/,
        "the failure was not the one this suite arranged",
      );
    }
  });

  it("completes the collection run", () => {
    assert.equal(report.sources.length, 1);
    const source = report.sources[0];
    assert.equal(source.skippedBecauseStopped, false);
    assert.equal(source.stopped, null);
    // Every watchlist entry was attempted, in order, exactly once.
    assert.deepEqual(
      source.attempted,
      WATCHED.map(([listingId]) => listingId),
    );
  });

  it("still stores the observation each fetch produced", async () => {
    const rows = await query(
      container.url,
      "select listing_id, amount_minor_units::text as amount from price_observations " +
        "order by listing_id",
    );
    assert.equal(
      rows.length,
      WATCHED.length,
      "an observation was lost because its telemetry row could not be written",
    );
    assert.equal(report.sources[0].observed.length, WATCHED.length);
  });

  it("does NOT retry the fetch or re-offer it to the governor", () => {
    // The count that matters. One product request per listing and no more: a
    // retry earned by a lost telemetry row is traffic from the household's own
    // address that nothing undoes.
    const products = harness.transport.sent.filter(
      (request) => new URL(request.url).pathname !== "/robots.txt",
    );
    assert.equal(
      products.length,
      WATCHED.length,
      `${products.length} product requests left for ${WATCHED.length} listings`,
    );
    assert.deepEqual(
      products.map((request) => new URL(request.url).pathname.split("/").pop()),
      WATCHED.map(([listingId]) => `${listingId}.json`),
    );
  });

  it("spends no further allowance on account of the failed recording", async () => {
    // The DURABLE counter, read from the table rather than from memory. It
    // counts what LEFT the process: one unit per product request, plus one for
    // the single robots.txt retrieval, and nothing else.
    const robots = harness.transport.sent.filter(
      (request) => new URL(request.url).pathname === "/robots.txt",
    );
    const settings = harness.config.sources["bestbuy-api"]?.allowance;
    assert.ok(settings !== undefined);
    const periodStart = periodStartFor(harness.clock.now(), settings.periodMs);

    const rows = await query(
      container.url,
      "select consumed::text as consumed from governor_allowance_usage " +
        "where source_id = 'bestbuy-api' and period_start = $1",
      [periodStart.toISOString()],
    );
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].consumed,
      String(harness.transport.sent.length),
      `the allowance counted ${rows[0].consumed} against ` +
        `${WATCHED.length} product requests and ${robots.length} robots ` +
        "retrievals that actually left",
    );
  });

  it("wrote no telemetry row, because it could not", async () => {
    // The other half of "nothing was silently fine": the table is gone, so the
    // outcomes really were lost. A run that had quietly recreated it, or that had
    // buffered the rows somewhere, would be a run doing something on the fetch
    // path that nobody asked for.
    const present = await query(
      container.url,
      "select to_regclass('public.fetch_outcomes') as t",
    );
    assert.equal(present[0].t, null);
  });
});
