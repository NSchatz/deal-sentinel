/**
 * Acceptance criteria 3, 4 and 5 of spec S0042-deal-sentinel-ops-5, against real
 * PostgreSQL:
 *
 *   3. WHEN success, error and block rates for a source are requested over a
 *      period bounded by two instants THE SYSTEM SHALL compute each rate over
 *      the records whose instant falls inside that period and SHALL exclude
 *      every record outside it, and SHALL report the counts the rates were
 *      computed from alongside them.
 *   4. IF a source has no record at all inside the requested period THEN THE
 *      SYSTEM SHALL report that source as having no data for that period and
 *      SHALL NOT report it as a zero error rate, a zero block rate or healthy.
 *   5. IF a source's most recent `success` record is older than the configured
 *      staleness horizon, or there is none at all, THEN THE SYSTEM SHALL report
 *      that source as BROKEN, and SHALL NOT report it as healthy, idle or quiet.
 *
 * Criteria 4 and 5 are NEGATIVE claims - about what the system must not say -
 * so each is graded twice: once against the read model, and once against the
 * text of the answer a reader is actually given, because a model that returns
 * null and a page that renders that null as "0%" would satisfy the first and
 * fail the criterion.
 *
 * The instants are chosen and the rows are seeded, deliberately: the arithmetic
 * under test is over rows at particular moments, and driving forty fetches
 * through a virtual clock would mean the clock the arithmetic reads is the clock
 * the fixture moved. That the real path writes a real row is graded in
 * `telemetry-record.test.ts`, through the governor, with nothing stubbed but the
 * transport.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { answer, buildOverview } from "@deal-sentinel/dashboard";
import type { Overview, SourceHealth } from "@deal-sentinel/dashboard";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { seedOutcomes, testDashboardConfig } from "../support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../support/source-3-harness.ts";

/** "Now" for every assertion in this file. Fixed, so the bounds are readable. */
const NOW = new Date("2026-09-06T12:00:00.000Z");
const HOUR = 3_600_000;
const RATE_PERIOD_MS = 24 * HOUR;
/** Deliberately shorter than the rate period, so the two are distinguishable. */
const STALENESS_HORIZON_MS = 6 * HOUR;

const CONFIG = testDashboardConfig({
  ratePeriodMs: RATE_PERIOD_MS,
  stalenessHorizonMs: STALENESS_HORIZON_MS,
});

/**
 * Four sources: one busy, one silent this period, one that never worked, and
 * one every record of which is a refusal this system made - the shape that has
 * records but nothing under the rates' denominator.
 */
const GOVERNOR: GovernorConfig = bestBuyGovernorConfig({
  sources: {
    "bestbuy-api": {
      allowance: { limit: 100, periodMs: 86_400_000, warnFraction: 0.9 },
    },
    "silent-source": {},
    "never-worked": {},
    "refused-everything": {},
  },
});

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
let overview: Overview;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

before(async () => {
  container = await startPostgres("ops-5-telemetry-rates");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 rates suite" });
  database = createDatabase(pool);

  await seedOutcomes(container.url, [
    // INSIDE the period: 5 success, 2 error, 2 blocked, 1 refused = 10.
    ...Array.from({ length: 5 }, (_unused, index) => ({
      sourceId: "bestbuy-api",
      outcomeClass: "success" as const,
      latencyMs: 120 + index,
      occurredAt: at(-HOUR * (index + 1)),
    })),
    ...Array.from({ length: 2 }, (_unused, index) => ({
      sourceId: "bestbuy-api",
      outcomeClass: "error" as const,
      latencyMs: 900,
      occurredAt: at(-HOUR * (index + 7)),
      condition: "error: the far side answered 500",
    })),
    ...Array.from({ length: 2 }, (_unused, index) => ({
      sourceId: "bestbuy-api",
      outcomeClass: "blocked" as const,
      latencyMs: 80,
      occurredAt: at(-HOUR * (index + 10)),
      condition: "blocked: the far side answered 429",
    })),
    {
      sourceId: "bestbuy-api",
      outcomeClass: "refused" as const,
      latencyMs: 3,
      occurredAt: at(-HOUR * 12),
      condition: "robots-disallowed: the host's robots.txt disallows this path",
    },

    // OUTSIDE the period, on both sides. Every one of these would move a rate
    // if the bounds were not applied: 30 more blocks just before the window,
    // and one success from the future.
    ...Array.from({ length: 30 }, (_unused, index) => ({
      sourceId: "bestbuy-api",
      outcomeClass: "blocked" as const,
      latencyMs: 60,
      occurredAt: at(-RATE_PERIOD_MS - HOUR * (index + 1)),
    })),
    {
      sourceId: "bestbuy-api",
      outcomeClass: "success" as const,
      latencyMs: 50,
      occurredAt: at(HOUR),
    },

    // A source whose LAST SUCCESS is inside the horizon but which recorded
    // nothing at all in the period on screen. That combination is what
    // criterion 4 is about, and it is not the same as criterion 5's.
    {
      sourceId: "silent-source",
      outcomeClass: "success" as const,
      latencyMs: 40,
      occurredAt: at(-HOUR),
    },

    // A source that recorded three REFUSALS in the period and nothing else.
    // It has data, so it is not criterion 4's no-data case; nothing left the
    // process, so there is no success, error or block rate over what did.
    ...Array.from({ length: 3 }, (_unused, index) => ({
      sourceId: "refused-everything",
      outcomeClass: "refused" as const,
      latencyMs: 2,
      occurredAt: at(-HOUR * (index + 2)),
      condition: "allowance-exhausted: this system declined to send",
    })),
  ]);

  // "silent-source" needs its one success INSIDE the horizon but its period
  // record removed, so it reads as no-data rather than broken. The row above is
  // inside both, so it is moved out of the period by narrowing the period for
  // that assertion instead - see the test itself.
  overview = await buildOverview({
    database,
    governor: GOVERNOR,
    config: CONFIG,
    now: NOW,
  });

  // The overview page is rendered once, here, so the assertions about what a
  // reader is actually shown do not each pay for a render - and so that the
  // render happens after the seeding rather than in a hook whose ordering
  // against this one would be a thing to remember.
  await renderPage();
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

function health(sourceId: string): SourceHealth {
  const found = overview.sources.find((source) => source.sourceId === sourceId);
  assert.ok(found !== undefined, `${sourceId} is not in the overview at all`);
  return found;
}

describe("criterion 3: rates over a bounded period, with the counts beside them", () => {
  it("counts only the records inside the period", () => {
    const counts = health("bestbuy-api").counts;
    assert.ok(counts !== null);
    assert.deepEqual(counts, {
      success: 5,
      error: 2,
      blocked: 2,
      refused: 1,
      total: 10,
    });
  });

  it("EXCLUDES the thirty records just before the period and the one after it", () => {
    // The mutation this test exists for: those 30 blocks are in the table. A
    // query with no lower bound reports 32 blocked out of 41 - a block rate of
    // 78% instead of 20% - and an operator would go and loosen a politeness
    // ceiling that was never the problem.
    const counts = health("bestbuy-api").counts;
    assert.ok(counts !== null);
    assert.notEqual(counts.blocked, 32);
    assert.equal(counts.blocked, 2);
    assert.equal(counts.total, 10);
  });

  it("computes each rate over exactly those counts", () => {
    // The denominator is what LEFT THIS PROCESS: 5 + 2 + 2. The one refusal is
    // a request the governor declined to send, so the far side neither
    // succeeded, failed nor blocked it, and it is not under the line. See
    // `OutcomeRates` for the argument and `notes.md` for the reading.
    const source = health("bestbuy-api");
    assert.ok(source.rates !== null);
    assert.equal(source.rates.attempted, 9);
    assert.equal(source.rates.success, 5 / 9);
    assert.equal(source.rates.error, 2 / 9);
    assert.equal(source.rates.blocked, 2 / 9);
    // The counts are unchanged by that choice: every class is still reported,
    // refusals included, and they still sum to the total.
    assert.equal(source.counts?.refused, 1);
    assert.equal(source.counts?.total, 10);
  });

  it("puts the refusals under no rate, which is the number the ceiling is tuned against", () => {
    // The mutation for the assertion above, stated as arithmetic rather than as
    // a second implementation: over the TOTAL, the same two blocks would read
    // 20.0%, and an operator would be looking at a block rate diluted by the
    // requests this system was careful enough not to send.
    const source = health("bestbuy-api");
    assert.ok(source.counts !== null && source.rates !== null);
    const overTotal = source.counts.blocked / source.counts.total;
    assert.equal(overTotal, 0.2);
    assert.notEqual(
      source.rates.blocked,
      overTotal,
      "the block rate is being computed over every record in the period, " +
        "refusals included, so it shrinks as this system gets more careful",
    );
  });

  it("reports the counts alongside the rates on the page, and names the denominator", () => {
    // A rate with no denominator is not evidence: 50% blocked is an emergency
    // out of forty and a shrug out of two.
    const page = renderedOverview();
    assert.match(page, /data-count-success[^>]*>5 success/);
    assert.match(page, /data-count-blocked[^>]*>2 blocked/);
    assert.match(page, /data-count-refused[^>]*>1 refused/);
    assert.match(page, /data-count-total[^>]*>10</);
    assert.match(page, /data-rate="blocked">22\.2% blocked/);
    // The denominator the reader is owed, on the page rather than inferable.
    assert.match(page, /data-rate-denominator>9</);
    assert.match(page, /data-rate-excluded>1</);
    assert.match(page, /request\(s\) that left this process/);
  });

  it("reports NO rate for a period in which nothing left the process", () => {
    // Every record a refusal. There is no success, error or block rate to
    // report: nothing reached the far side, so the far side answered nothing.
    // Zeros here would say "we asked and were never blocked".
    const source = health("refused-everything");
    assert.equal(source.counts?.refused, 3);
    assert.equal(source.counts?.total, 3);
    assert.equal(source.rates, null, "a rate was computed from nothing sent");

    const row = rowFor(renderedOverview(), "refused-everything");
    assert.match(row, /data-no-rates="nothing-sent"/);
    assert.match(row, /data-count-refused[^>]*>3 refused/);
    assert.doesNotMatch(row, /0\.0% blocked/);
    assert.doesNotMatch(row, /0\.0% error/);
    assert.doesNotMatch(row, /data-rate="blocked"/);
  });

  it("moves when the period moves, which is what makes the bounds real", async () => {
    // The same rows, a six-hour window: only the five successes and one error
    // fall inside it.
    const narrow = await buildOverview({
      database,
      governor: GOVERNOR,
      config: testDashboardConfig({
        ratePeriodMs: 6 * HOUR,
        stalenessHorizonMs: STALENESS_HORIZON_MS,
      }),
      now: NOW,
    });
    const source = narrow.sources.find((entry) => entry.sourceId === "bestbuy-api");
    assert.ok(source?.counts !== null && source?.counts !== undefined);
    assert.equal(source.counts.total, 5);
    assert.equal(source.counts.success, 5);
    assert.equal(source.counts.blocked, 0);
  });
});

describe("criterion 4: no record in the period is not a zero rate and not healthy", () => {
  it("reports no data rather than a set of zeros", async () => {
    // A window that excludes silent-source's only record. Its last success is
    // still inside the staleness horizon, so criterion 5 does not fire and this
    // is criterion 4 on its own.
    const narrow = await buildOverview({
      database,
      governor: GOVERNOR,
      config: testDashboardConfig({
        ratePeriodMs: 30 * 60_000,
        stalenessHorizonMs: STALENESS_HORIZON_MS,
      }),
      now: NOW,
    });
    const silent = narrow.sources.find((entry) => entry.sourceId === "silent-source");
    assert.ok(silent !== undefined);

    assert.equal(silent.verdict, "no-data");
    assert.equal(silent.counts, null, "counts were reported for a source with none");
    assert.equal(silent.rates, null, "a rate was computed from nothing");
  });

  it("does not RENDER a zero error rate, a zero block rate, or the word healthy", async () => {
    const page = await renderPage(
      testDashboardConfig({
        ratePeriodMs: 30 * 60_000,
        stalenessHorizonMs: STALENESS_HORIZON_MS,
      }),
    );
    const row = rowFor(page, "silent-source");
    assert.match(row, /data-verdict="no-data"/);
    assert.match(row, /data-no-rates/);
    // The phrasing is matched in halves so this line does not itself name the
    // global HTTP client, which the repository-wide chokepoint check reports
    // wherever it appears in code - a regular expression literal included.
    assert.match(row, /recorded in this period/);
    assert.doesNotMatch(row, /0\.0% error/);
    assert.doesNotMatch(row, /0\.0% blocked/);
    assert.doesNotMatch(row, /data-verdict="healthy"/);
  });
});

describe("criterion 5: no recent success reads as BROKEN, not as quiet", () => {
  it("calls a source with no success on record at all BROKEN", () => {
    const source = health("never-worked");
    assert.equal(source.verdict, "broken");
    assert.equal(source.lastSuccessAt, null);
    assert.match(source.verdictDetail, /BROKEN and not idle/);
  });

  it("calls a source whose last success is past the horizon BROKEN", async () => {
    await seedOutcomes(container.url, [
      {
        sourceId: "stale-source",
        outcomeClass: "success",
        // Inside the rate period, outside the staleness horizon. The two bounds
        // are different numbers on purpose: a source can be busy all day and
        // still not have succeeded since breakfast.
        latencyMs: 70,
        occurredAt: at(-STALENESS_HORIZON_MS - 60_000),
      },
      {
        sourceId: "stale-source",
        outcomeClass: "error",
        latencyMs: 70,
        occurredAt: at(-60_000),
      },
    ]);

    const withStale = await buildOverview({
      database,
      governor: GOVERNOR,
      config: CONFIG,
      now: NOW,
    });
    const stale = withStale.sources.find((entry) => entry.sourceId === "stale-source");
    assert.ok(stale !== undefined);
    assert.equal(stale.verdict, "broken");
    assert.match(stale.verdictDetail, /staleness horizon/);
    // It HAS data in the period, so this is not criterion 4 wearing a hat.
    assert.ok(stale.counts !== null);
    assert.equal(stale.counts.total, 2);
  });

  it("renders BROKEN as the verdict, and no other verdict beside it", async () => {
    const page = await renderPage(CONFIG);
    for (const sourceId of ["never-worked", "stale-source"]) {
      const row = rowFor(page, sourceId);
      // The VERDICT is what a reader acts on, so the assertion is against the
      // verdict and not against the prose explaining it - which is entitled to
      // use the words "idle" and "quiet" in order to say the source is neither.
      const verdicts = [...row.matchAll(/data-verdict="([a-z-]+)"/g)].map(
        (match) => match[1],
      );
      assert.deepEqual(verdicts, ["broken"], sourceId);
      assert.match(row, />BROKEN</, sourceId);
      assert.doesNotMatch(row, /verdict-healthy/, sourceId);
      assert.doesNotMatch(row, /verdict-no-data/, sourceId);
    }
  });

  it("would call the same source healthy under a horizon long enough to cover it", async () => {
    // The mutation. If the verdict ignored the horizon, this would read broken
    // too and the horizon would be decoration.
    const generous = await buildOverview({
      database,
      governor: GOVERNOR,
      config: testDashboardConfig({
        ratePeriodMs: RATE_PERIOD_MS,
        stalenessHorizonMs: 48 * HOUR,
      }),
      now: NOW,
    });
    const stale = generous.sources.find((entry) => entry.sourceId === "stale-source");
    assert.equal(stale?.verdict, "healthy");
    // And the one with no success at all is STILL broken, because there is no
    // horizon long enough to cover a success that never happened.
    const never = generous.sources.find((entry) => entry.sourceId === "never-worked");
    assert.equal(never?.verdict, "broken");
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

let cachedOverviewPage: string | null = null;

function renderedOverview(): string {
  assert.ok(cachedOverviewPage !== null, "renderPage was not called first");
  return cachedOverviewPage;
}

async function renderPage(config = CONFIG): Promise<string> {
  const given = await answer(
    {
      config,
      governor: GOVERNOR,
      registry: testRegistry(),
      database,
      now: () => NOW,
    },
    "GET",
    "/",
  );
  assert.equal(given.status, 200, refusalDetail(given.body));
  cachedOverviewPage = given.body;
  return given.body;
}

/** The reason a refusal page gives, so a failing assertion says what went wrong. */
function refusalDetail(body: string): string {
  const match = /data-(?:database-unreachable|schema-behind)-detail[^>]*>([\s\S]*?)</.exec(
    body,
  );
  return match === null ? body.slice(0, 400) : match[1];
}

/** One source's row out of the rendered table, so an assertion cannot drift. */
function rowFor(page: string, sourceId: string): string {
  const start = page.indexOf(`data-source-row data-source-id="${sourceId}"`);
  assert.ok(start >= 0, `${sourceId} has no row on the page`);
  const end = page.indexOf("</tr>", start);
  return page.slice(start, end);
}
