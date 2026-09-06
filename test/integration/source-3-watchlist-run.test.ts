/**
 * Acceptance criteria 18, 19 and 20 of spec S0033-deal-sentinel-source-3,
 * against real PostgreSQL and a stubbed transport:
 *
 *  18. WHEN a collection run executes for a source THE SYSTEM SHALL attempt
 *      every enabled watchlist entry for that source and SHALL attempt no
 *      listing that is absent from the watchlist or disabled on it.
 *  19. IF a source has no enabled watchlist entry THEN THE SYSTEM SHALL
 *      complete its run without issuing any request and without reporting an
 *      error.
 *  20. IF the governor refuses a request for a watchlist entry, for any of its
 *      refusal reasons THEN THE SYSTEM SHALL record no observation for that
 *      entry, SHALL NOT retry that entry within the same run, and SHALL
 *      continue with the remaining entries.
 *
 * The watchlist here is the real table, read through the real query, so
 * "attempted no listing that is absent from it" is graded on what the STUB
 * TRANSPORT SAW and not on what the run reported about itself. A run that
 * quietly fetched a fourth listing would be caught by the transport's own log
 * even if its report said otherwise.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";

import {
  addWatchlistEntry,
  createDatabase,
  drizzleWatchlist,
  drizzleWriter,
  initializeHistory,
  memorySourceStops,
  setWatchlistEntryEnabled,
} from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import type { TransportRequest, TransportResponse } from "@deal-sentinel/governor";
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
  bestBuyGovernorConfig,
  fixtureAnswer,
  sourceHarness,
  testRegistry,
  vendorResponder,
} from "../support/source-3-harness.ts";
import type { SourceHarness, VendorAnswer } from "../support/source-3-harness.ts";

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;

const ENABLED = ["8880044", "6428337", "5901234"];
const DISABLED = "1299001";
const NOT_ON_THE_WATCHLIST = "7710055";

const registry = testRegistry();
const config = bestBuyGovernorConfig();

const ANSWERS: Record<string, VendorAnswer> = {
  "8880044": fixtureAnswer("product-on-sale.json"),
  "6428337": fixtureAnswer("product-not-on-sale.json"),
  "5901234": fixtureAnswer("product-no-price-update-date.json"),
  [DISABLED]: fixtureAnswer("product-whole-number-price.json"),
  [NOT_ON_THE_WATCHLIST]: fixtureAnswer("product-unreadable-price-update-date.json"),
};

before(async () => {
  container = await startPostgres("source-3-watchlist");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "source-3 watchlist suite" });
  database = createDatabase(pool);
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

beforeEach(async () => {
  await query(container.url, "delete from price_observations");
  await query(container.url, "delete from watchlist_entries");
});

async function seedWatchlist(): Promise<void> {
  for (const listingId of ENABLED) {
    await addWatchlistEntry(database, { sourceId: "bestbuy-api", listingId });
  }
  await addWatchlistEntry(database, {
    sourceId: "bestbuy-api",
    listingId: DISABLED,
    enabled: false,
    note: "switched off by the owner",
  });
  // Present on ANOTHER source's watchlist. Nothing about this run may reach it.
  await addWatchlistEntry(database, {
    sourceId: "some-other-source",
    listingId: NOT_ON_THE_WATCHLIST,
  });
}

function run(harness: SourceHarness): Promise<CollectionRunReport> {
  return runCollection({
    adapters: [
      bestBuyAdapter({
        governor: harness.governor,
        entry: registry.require("bestbuy-api"),
        credential: TEST_CREDENTIAL,
      }),
    ],
    registry,
    watchlist: drizzleWatchlist(database),
    writer: drizzleWriter(database),
    stops: memorySourceStops(),
    notifier: harness.notifier,
    clock: harness.clock,
    stopPeriodMsFor: stopPeriodsFromGovernorConfig(config),
    database,
  });
}

/** The skus that actually left the process, in order, robots.txt excluded. */
function skusRequested(harness: SourceHarness): string[] {
  return harness.transport.sent
    .filter((request) => new URL(request.url).pathname !== "/robots.txt")
    .map((request) => {
      const match = /\/products\/([^/.]+)\.json/.exec(new URL(request.url).pathname);
      return match === null ? "" : match[1];
    });
}

describe("criterion 18: the run attempts exactly the enabled entries", () => {
  it("attempts every enabled entry for the source", async () => {
    await seedWatchlist();
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);

    assert.deepEqual(report.sources[0].attempted, ENABLED);
    assert.deepEqual(skusRequested(harness), ENABLED);
    assert.equal(report.sources[0].observed.length, ENABLED.length);
  });

  it("attempts no listing that is disabled on the watchlist", async () => {
    await seedWatchlist();
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);

    assert.ok(!report.sources[0].attempted.includes(DISABLED));
    assert.ok(
      !skusRequested(harness).includes(DISABLED),
      "a request left the process for a listing the owner switched off",
    );
    const rows = await query(
      container.url,
      "select count(*)::text as n from price_observations where listing_id = $1",
      [DISABLED],
    );
    assert.equal(rows[0].n, "0");
  });

  it("attempts no listing that is absent from this source's watchlist", async () => {
    await seedWatchlist();
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    await run(harness);

    assert.ok(
      !skusRequested(harness).includes(NOT_ON_THE_WATCHLIST),
      "a request left for a listing that belongs to another source's watchlist",
    );
  });

  it("follows the watchlist when it changes, with no code change", async () => {
    await seedWatchlist();
    await setWatchlistEntryEnabled(database, "bestbuy-api", DISABLED, true);
    await setWatchlistEntryEnabled(database, "bestbuy-api", ENABLED[0], false);

    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);

    assert.deepEqual(report.sources[0].attempted, [ENABLED[1], ENABLED[2], DISABLED]);
    assert.ok(!skusRequested(harness).includes(ENABLED[0]));
  });

  it("does not attempt one listing twice, however often it is added", async () => {
    await addWatchlistEntry(database, { sourceId: "bestbuy-api", listingId: "8880044" });
    await addWatchlistEntry(database, {
      sourceId: "bestbuy-api",
      listingId: "8880044",
      note: "added again by the owner",
    });

    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);

    assert.deepEqual(report.sources[0].attempted, ["8880044"]);
    assert.deepEqual(skusRequested(harness), ["8880044"]);
  });
});

describe("criterion 19: an empty watchlist is a complete run, not a failure", () => {
  it("issues no request at all", async () => {
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);

    assert.deepEqual(harness.transport.sent, [], "something left for an empty watchlist");
    assert.deepEqual(report.sources[0].attempted, []);
  });

  it("reports no error", async () => {
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);
    const source = report.sources[0];

    assert.deepEqual(source.errors, []);
    assert.deepEqual(source.refusals, []);
    assert.deepEqual(source.extractionFailures, []);
    assert.equal(source.stopped, null);
    assert.equal(source.skippedBecauseStopped, false);
  });

  it("is the same when every entry is disabled rather than absent", async () => {
    for (const listingId of ENABLED) {
      await addWatchlistEntry(database, {
        sourceId: "bestbuy-api",
        listingId,
        enabled: false,
      });
    }
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);

    assert.deepEqual(harness.transport.sent, []);
    assert.deepEqual(report.sources[0].attempted, []);
    assert.deepEqual(report.sources[0].errors, []);
  });

  it("still sweeps retention, so an idle source's content still ages out", async () => {
    const harness = sourceHarness({ config, registry, answers: ANSWERS });
    const report = await run(harness);
    assert.ok(report.retention !== null, "an idle run skipped the retention sweep");
  });
});

describe("criterion 20: a governor refusal skips the entry and the run carries on", () => {
  /**
   * Refuse the MIDDLE listing at the governor, by every reason a run can
   * plausibly meet, and leave the other two alone. `unconfigured-host` and
   * `robots-disallowed` are produced by the governor itself; `transport-error`
   * is produced by the transport failing.
   */
  async function runRefusingMiddle(
    responder: (
      request: TransportRequest,
      index: number,
    ) => Partial<TransportResponse> | Error,
  ): Promise<{ harness: SourceHarness; report: CollectionRunReport }> {
    await seedWatchlist();
    const harness = sourceHarness({ config, registry, responder });
    const report = await run(harness);
    return { harness, report };
  }

  it("skips the entry a robots.txt disallows, and keeps the other two", async () => {
    const { harness, report } = await runRefusingMiddle((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/robots.txt") {
        // Disallow exactly the middle listing's path.
        return {
          status: 200,
          body: "User-agent: *\nDisallow: /v1/products/6428337.json\n",
        };
      }
      return vendorResponder(ANSWERS)(request, 0);
    });

    const source = report.sources[0];
    assert.deepEqual(source.attempted, ENABLED, "the refused entry was never attempted");
    assert.deepEqual(
      source.refusals.map((refusal) => refusal.listingId),
      ["6428337"],
    );
    assert.equal(source.refusals[0].reason, "robots-disallowed");

    // No observation for it, and the other two are written.
    assert.deepEqual(
      source.observed.map((entry) => entry.listingId),
      ["8880044", "5901234"],
    );
    const rows = await query(
      container.url,
      "select listing_id from price_observations order by listing_id",
    );
    assert.deepEqual(
      rows.map((row) => row.listing_id),
      ["5901234", "8880044"],
    );

    // NOT RETRIED: exactly one product request for the refused listing... and
    // in fact none, because the refusal happened before anything left.
    assert.deepEqual(skusRequested(harness), ["8880044", "5901234"]);
  });

  it("skips one the transport could not reach, and keeps the other two", async () => {
    const { harness, report } = await runRefusingMiddle(
      vendorResponder({
        ...ANSWERS,
        "6428337": new Error("connection reset by peer"),
      }),
    );

    const source = report.sources[0];
    assert.deepEqual(source.attempted, ENABLED);
    assert.deepEqual(
      source.refusals.map((refusal) => refusal.reason),
      ["transport-error"],
    );
    assert.equal(source.observed.length, 2);

    // Attempted ONCE. A retry would show as a second request for that sku.
    assert.deepEqual(
      skusRequested(harness).filter((sku) => sku === "6428337").length,
      1,
    );
  });

  it("skips every entry when the host carries no ceiling, without erroring", async () => {
    await seedWatchlist();
    // A governor that has never heard of this host refuses at its first gate,
    // for every entry. The run still completes, and still writes nothing.
    const harness = sourceHarness({
      config: bestBuyGovernorConfig({
        hosts: {
          "127.0.0.1": { maxRequests: 10, intervalMs: 1000, minDelayMs: 1, jitterMs: 1 },
        },
      }),
      registry,
      answers: ANSWERS,
    });
    const report = await run(harness);
    const source = report.sources[0];

    assert.deepEqual(source.attempted, ENABLED);
    assert.equal(source.refusals.length, ENABLED.length);
    for (const refusal of source.refusals) {
      assert.equal(refusal.reason, "unconfigured-host");
    }
    assert.equal(source.observed.length, 0);
    assert.deepEqual(harness.transport.sent, [], "a refused request still left");

    const rows = await query(
      container.url,
      "select count(*)::text as n from price_observations",
    );
    assert.equal(rows[0].n, "0");
  });

  it("skips every entry once the allowance for the period is spent", async () => {
    await seedWatchlist();
    // Two units. The governor's own `/robots.txt` retrieval is a request that
    // leaves the process, so it spends one - which is the governor counting
    // what actually left, and is worth stating rather than working around.
    // That leaves exactly one unit for the first product.
    const harness = sourceHarness({
      config: bestBuyGovernorConfig({
        sources: {
          "bestbuy-api": {
            allowance: { limit: 2, periodMs: 86_400_000, warnFraction: 0.9 },
          },
        },
      }),
      registry,
      answers: ANSWERS,
    });
    const report = await run(harness);
    const source = report.sources[0];

    // The first entry spends the last unit; the other two are refused, once
    // each, and the run finishes.
    assert.deepEqual(source.attempted, ENABLED);
    assert.equal(source.observed.length, 1);
    assert.deepEqual(
      source.refusals.map((refusal) => refusal.reason),
      ["allowance-exhausted", "allowance-exhausted"],
    );
    assert.deepEqual(skusRequested(harness), ["8880044"]);
  });

  it("records a typed extraction failure without stopping the run either", async () => {
    await seedWatchlist();
    const harness = sourceHarness({
      config,
      registry,
      answers: { ...ANSWERS, "6428337": fixtureAnswer("product-inexact-price.json") },
    });
    const report = await run(harness);
    const source = report.sources[0];

    assert.deepEqual(source.attempted, ENABLED);
    assert.equal(source.extractionFailures.length, 1);
    assert.equal(source.extractionFailures[0].listingId, "6428337");
    assert.equal(source.observed.length, 2);
  });
});
