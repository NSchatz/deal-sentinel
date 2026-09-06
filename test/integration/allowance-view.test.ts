/**
 * Acceptance criteria 8, 9 and 10 of spec S0042-deal-sentinel-ops-5, against
 * real PostgreSQL:
 *
 *    8. WHEN the allowance state of a metered source is requested THE SYSTEM
 *       SHALL report, for the period current at the instant of the request, the
 *       units consumed, the units remaining, the configured limit and the
 *       instant that period began, with consumed plus remaining equal to the
 *       limit.
 *    9. IF the current period has no stored counter row yet THEN THE SYSTEM
 *       SHALL report zero consumed and the full limit remaining for that period,
 *       and SHALL NOT report the state as unknown, blank or an error.
 *   10. IF a source is configured without an allowance THEN THE SYSTEM SHALL
 *       report it as unmetered and SHALL NOT report it as zero remaining,
 *       exhausted or at its limit.
 *
 * Criteria 9 and 10 are both about a NUMBER THAT DOES NOT EXIST being reported
 * as if it did. They are opposite mistakes - one reads an absent row as an
 * absent allowance, the other reads an absent allowance as a spent one - and
 * both end with an owner believing a source has stopped when it has not. So each
 * is graded against the read model AND against the rendered answer, because a
 * model that says `metered: false` and a page that prints "0 remaining" would
 * pass the first alone.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { answer, buildOverview } from "@deal-sentinel/dashboard";
import type { AllowanceView } from "@deal-sentinel/dashboard";
import { periodStartFor } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import { testDashboardConfig } from "../support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../support/source-3-harness.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const PERIOD_MS = 86_400_000;
const LIMIT = 2000;

const CONFIG = testDashboardConfig();

/** One metered source with a row, one metered source with none, one unmetered. */
const GOVERNOR: GovernorConfig = bestBuyGovernorConfig({
  sources: {
    "bestbuy-api": {
      allowance: { limit: LIMIT, periodMs: PERIOD_MS, warnFraction: 0.8 },
    },
    "fresh-period": {
      allowance: { limit: LIMIT, periodMs: PERIOD_MS, warnFraction: 0.8 },
    },
    "jsonld-generic": {},
  },
});

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;

before(async () => {
  container = await startPostgres("ops-5-allowance-view");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 allowance suite" });
  database = createDatabase(pool);

  const periodStart = periodStartFor(NOW.getTime(), PERIOD_MS);
  await query(
    container.url,
    "insert into governor_allowance_usage (source_id, period_start, consumed) " +
      "values ('bestbuy-api', $1, 750)",
    [periodStart.toISOString()],
  );
  // A row from an EARLIER period, which must not be read as this period's.
  await query(
    container.url,
    "insert into governor_allowance_usage (source_id, period_start, consumed) " +
      "values ('bestbuy-api', $1, 1999)",
    [new Date(periodStart.getTime() - PERIOD_MS).toISOString()],
  );
  // And one for the source that has none in the CURRENT period, so its absence
  // here is an absence and not an empty table.
  await query(
    container.url,
    "insert into governor_allowance_usage (source_id, period_start, consumed) " +
      "values ('fresh-period', $1, 1234)",
    [new Date(periodStart.getTime() - PERIOD_MS).toISOString()],
  );
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

async function allowanceFor(sourceId: string, now = NOW): Promise<AllowanceView> {
  const overview = await buildOverview({
    database,
    governor: GOVERNOR,
    config: CONFIG,
    now,
  });
  const source = overview.sources.find((entry) => entry.sourceId === sourceId);
  assert.ok(source !== undefined, `${sourceId} is not in the overview`);
  return source.allowance;
}

async function page(now = NOW): Promise<string> {
  const given = await answer(
    {
      config: CONFIG,
      governor: GOVERNOR,
      registry: testRegistry(),
      database,
      now: () => now,
    },
    "GET",
    "/",
  );
  assert.equal(given.status, 200);
  return given.body;
}

function rowFor(body: string, sourceId: string): string {
  const start = body.indexOf(`data-source-row data-source-id="${sourceId}"`);
  assert.ok(start >= 0, `${sourceId} has no row on the page`);
  return body.slice(start, body.indexOf("</tr>", start));
}

describe("criterion 8: the allowance for the period current at the request", () => {
  it("reports consumed, remaining, the limit and the period's start", async () => {
    const allowance = await allowanceFor("bestbuy-api");
    assert.equal(allowance.metered, true);
    assert.ok(allowance.metered);
    assert.equal(allowance.consumed, 750);
    assert.equal(allowance.remaining, LIMIT - 750);
    assert.equal(allowance.limit, LIMIT);
    assert.deepEqual(
      allowance.periodStart,
      periodStartFor(NOW.getTime(), PERIOD_MS),
    );
  });

  it("keeps consumed plus remaining equal to the limit", async () => {
    const allowance = await allowanceFor("bestbuy-api");
    assert.ok(allowance.metered);
    assert.equal(allowance.consumed + allowance.remaining, allowance.limit);
  });

  it("reads THIS period's row and not an earlier one", async () => {
    // The previous period's row says 1999 of 2000. Reading it would tell the
    // owner their source is about to stop when it has spent a third of today.
    const allowance = await allowanceFor("bestbuy-api");
    assert.ok(allowance.metered);
    assert.notEqual(allowance.consumed, 1999);
    assert.equal(allowance.consumed, 750);
  });

  it("moves to the next period's row when the instant moves", async () => {
    // The same rows, a day later: this period has no row, so the answer is a
    // fresh allowance rather than yesterday's.
    const tomorrow = new Date(NOW.getTime() + PERIOD_MS);
    const allowance = await allowanceFor("bestbuy-api", tomorrow);
    assert.ok(allowance.metered);
    assert.equal(allowance.consumed, 0);
    assert.equal(allowance.remaining, LIMIT);
    assert.deepEqual(
      allowance.periodStart,
      periodStartFor(tomorrow.getTime(), PERIOD_MS),
    );
  });

  it("renders all four numbers", async () => {
    const row = rowFor(await page(), "bestbuy-api");
    assert.match(row, /data-allowance-consumed>750</);
    assert.match(row, /data-allowance-remaining>1250</);
    assert.match(row, /data-allowance-limit>2000</);
    assert.match(row, /data-allowance-period-start>2026-09-06T00:00:00\.000Z</);
  });
});

describe("criterion 9: a period with no row yet is zero spent, not unknown", () => {
  it("reports zero consumed and the whole limit remaining", async () => {
    const allowance = await allowanceFor("fresh-period");
    assert.equal(allowance.metered, true);
    assert.ok(allowance.metered);
    assert.equal(allowance.consumed, 0);
    assert.equal(allowance.remaining, LIMIT);
    assert.equal(allowance.limit, LIMIT);
  });

  it("there really is no row, which is what makes the answer an inference", async () => {
    const rows = await query(
      container.url,
      "select count(*)::text as n from governor_allowance_usage " +
        "where source_id = 'fresh-period' and period_start = $1",
      [periodStartFor(NOW.getTime(), PERIOD_MS).toISOString()],
    );
    assert.equal(rows[0].n, "0");
  });

  it("renders numbers and not unknown, blank or an error", async () => {
    const row = rowFor(await page(), "fresh-period");
    assert.match(row, /data-allowance="metered"/);
    assert.match(row, /data-allowance-consumed>0</);
    assert.match(row, /data-allowance-remaining>2000</);
    assert.doesNotMatch(row, /unknown/i);
    assert.doesNotMatch(row, /error/i);
    assert.doesNotMatch(row, /data-allowance-at-limit/);
  });
});

describe("criterion 10: an unmetered source is unmetered, not exhausted", () => {
  it("reports it as unmetered", async () => {
    const allowance = await allowanceFor("jsonld-generic");
    assert.equal(allowance.metered, false);
  });

  it("renders the word unmetered and none of the three wrong ones", async () => {
    const row = rowFor(await page(), "jsonld-generic");
    assert.match(row, /data-allowance="unmetered"/);
    assert.match(row, /unmetered/);
    // The three mistakes, each of which reads as "this source has stopped".
    assert.doesNotMatch(row, /0 remaining/);
    assert.doesNotMatch(row, /exhausted/i);
    assert.doesNotMatch(row, /data-allowance-at-limit/);
    assert.doesNotMatch(row, /at its limit/i);
  });

  it("says the same thing in the states section, where an operator looks next", async () => {
    const body = await page();
    const start = body.indexOf(
      'data-allowance-state="unmetered" data-source-id="jsonld-generic"',
    );
    assert.ok(start >= 0, "the unmetered source has no allowance state at all");
    const state = body.slice(start, start + 400);
    assert.match(state, /no allowance is configured/);
    assert.doesNotMatch(state, /STOPPED/);
  });

  it("a source AT its limit does say so, so the absence above is a distinction", async () => {
    // The mutation: if "at its limit" were never rendered for anybody, the
    // assertions above would pass against a page that cannot say it at all.
    await query(
      container.url,
      "update governor_allowance_usage set consumed = $1 " +
        "where source_id = 'bestbuy-api' and period_start = $2",
      [LIMIT, periodStartFor(NOW.getTime(), PERIOD_MS).toISOString()],
    );
    const row = rowFor(await page(), "bestbuy-api");
    assert.match(row, /data-allowance-at-limit/);
    assert.match(row, /at its limit/);

    const allowance = await allowanceFor("bestbuy-api");
    assert.ok(allowance.metered);
    assert.equal(allowance.atLimit, true);
    assert.equal(allowance.remaining, 0);

    // And the unmetered one is STILL not at its limit under the same render.
    const unmetered = rowFor(await page(), "jsonld-generic");
    assert.doesNotMatch(unmetered, /data-allowance-at-limit/);
  });
});
