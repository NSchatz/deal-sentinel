/**
 * Acceptance criteria 12, 13, 14 and 15 of spec S0042-deal-sentinel-ops-5,
 * against real PostgreSQL:
 *
 *   12. WHEN a source's breaker pauses it THE SYSTEM SHALL durably record that
 *       pause, the instant it began, the instant it expires and the condition
 *       that caused it (the failing count, the total in the window, the window,
 *       and the threshold crossed), and a reader in a DIFFERENT process SHALL be
 *       able to see that the source is paused and read that condition.
 *   13. WHEN a pause has expired THE SYSTEM SHALL report that source as not
 *       currently paused while the expired pause remains readable as history,
 *       and SHALL NOT require a process restart or a manual reset for it to read
 *       as resumed.
 *   14. WHEN one source is paused THE SYSTEM SHALL report every other configured
 *       source as not paused.
 *   15. WHEN a source is stopped for a period because the SOURCE ITSELF refused
 *       THE SYSTEM SHALL show that stop, its period and its recorded reason as a
 *       fact DISTINCT from a breaker pause and distinct from this system
 *       reaching its own configured allowance, and SHALL NOT present any two of
 *       the three as the same state.
 *
 * `Breaker` keeps every counter in a `Map` in one process and resumes lazily, so
 * criterion 12's "a reader in a different process" is a real requirement rather
 * than a restatement. It is graded the only way that means anything: a CHILD
 * PROCESS drives the real governor until the real breaker decides to pause the
 * source, the child exits, and this process - which never held that Map - reads
 * the pause and its condition back.
 *
 * Nothing here inserts a breaker_pauses row by hand. A pause is a DECISION, and
 * a row that merely looks like one would prove that this suite can write SQL.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, initializeHistory } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";
import { answer, buildOverview } from "@deal-sentinel/dashboard";
import { periodStartFor } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";

import { destroyPostgres, startPostgres } from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import { testDashboardConfig } from "../support/dashboard-harness.ts";
import { bestBuyGovernorConfig, testRegistry } from "../support/source-3-harness.ts";

const execFile = promisify(execFileCallback);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = path.join(REPO_ROOT, "test/support/record-outcome-child.ts");

const PERIOD_MS = 86_400_000;
const CONFIG = testDashboardConfig({ stalenessHorizonMs: 86_400_000 });

/** Two metered sources and one unmetered, so "every other source" has members. */
const GOVERNOR: GovernorConfig = bestBuyGovernorConfig({
  sources: {
    "bestbuy-api": {
      allowance: { limit: 2000, periodMs: PERIOD_MS, warnFraction: 0.8 },
    },
    "second-source": {
      allowance: { limit: 2000, periodMs: PERIOD_MS, warnFraction: 0.8 },
    },
    "jsonld-generic": {},
  },
});

let container: PostgresContainer;
let pool: pg.Pool;
let database: HistoryDatabase;
/** The pause the child's breaker decided, read back here. */
let pausedAt: Date;
let expiresAt: Date;

before(async () => {
  container = await startPostgres("ops-5-breaker-pause");
  pool = new pg.Pool({ connectionString: container.url });
  await initializeHistory(pool, { note: "ops-5 breaker pause suite" });
  database = createDatabase(pool);

  // A whole process, driven to a real pause and then gone. Two outcomes in the
  // window (the robots retrieval succeeds, the product fetch fails) at a
  // configured threshold of 0.5 is a rate the breaker pauses on, and the two
  // offers after it are refused by the pause it took.
  const { stderr } = await execFile(
    process.execPath,
    [CHILD, container.url, "error", "bestbuy-api", "2", "3"],
    { cwd: REPO_ROOT, timeout: 120_000 },
  );
  assert.equal(stderr.trim(), "", stderr);

  const rows = await query(
    container.url,
    "select paused_at::text as paused_at, expires_at::text as expires_at " +
      "from breaker_pauses order by id",
  );
  assert.equal(rows.length, 1, "the child did not produce exactly one pause");
  pausedAt = new Date(rows[0].paused_at ?? "");
  expiresAt = new Date(rows[0].expires_at ?? "");
}, { timeout: 300_000 });

after(async () => {
  if (pool) await pool.end();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

/** "Now" inside the pause, so the reader sees it in force. */
function duringPause(): Date {
  return new Date(pausedAt.getTime() + 1000);
}

/** "Now" after the pause has expired, with nothing else changed. */
function afterPause(): Date {
  return new Date(expiresAt.getTime() + 1000);
}

async function renderAt(now: Date): Promise<string> {
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

describe("criterion 12: a pause another process took is visible here", () => {
  it("was written by a process that has since exited", async () => {
    const rows = await query(
      container.url,
      "select source_id, failing_count::text as failing_count, " +
        "window_outcomes::text as window_outcomes, window_ms::text as window_ms, " +
        "failure_rate_threshold, condition from breaker_pauses order by id",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_id, "bestbuy-api");
    // The condition, IN PARTS, so a later reader does not have to parse English
    // to answer "what threshold was in force when this fired".
    assert.equal(rows[0].failing_count, "1");
    assert.equal(rows[0].window_outcomes, "2");
    assert.equal(rows[0].window_ms, "600000");
    assert.equal(rows[0].failure_rate_threshold, "0.5");
    assert.match(rows[0].condition ?? "", /error or a block/);
  });

  it("records the pause EXACTLY once, however many requests arrive behind it", async () => {
    // The child offered three. The two after the pause were refused by it, and
    // a second row would mean the record is written from `status()` rather than
    // from the one place a pause is announced.
    const rows = await query(
      container.url,
      "select count(*)::text as n from breaker_pauses",
    );
    assert.equal(rows[0].n, "1");

    const refused = await query(
      container.url,
      "select count(*)::text as n from fetch_outcomes where outcome_class = 'refused'",
    );
    assert.equal(
      refused[0].n,
      "2",
      "the two offers behind the pause were not refused by it, so the pause " +
        "was not actually in force",
    );
  });

  it("reads as paused, with its condition, from this process", async () => {
    const overview = await buildOverview({
      database,
      governor: GOVERNOR,
      config: CONFIG,
      now: duringPause(),
    });
    const source = overview.sources.find((entry) => entry.sourceId === "bestbuy-api");
    assert.ok(source?.breakerPause !== null && source?.breakerPause !== undefined);
    assert.equal(source.breakerPause.failingCount, 1);
    assert.equal(source.breakerPause.windowOutcomes, 2);
    assert.equal(source.breakerPause.windowMs, 600_000);
    assert.equal(source.breakerPause.failureRateThreshold, "0.5");
  });

  it("shows the pause and every part of its condition on the page", async () => {
    const body = await renderAt(duringPause());
    const state = stateFor(body, "data-breaker-pause", "bestbuy-api");
    assert.match(state, /data-breaker-pause="paused"/);
    assert.match(state, /PAUSED BY THE BREAKER/);
    assert.match(state, /data-pause-failing>1</);
    assert.match(state, /data-pause-total>2</);
    assert.match(state, /data-pause-window>600000</);
    assert.match(state, /data-pause-threshold>0\.5</);
  });
});

describe("criterion 13: an expired pause reads as resumed, and stays as history", () => {
  it("reports the source as not currently paused once the pause has expired", async () => {
    const overview = await buildOverview({
      database,
      governor: GOVERNOR,
      config: CONFIG,
      now: afterPause(),
    });
    const source = overview.sources.find((entry) => entry.sourceId === "bestbuy-api");
    assert.equal(source?.breakerPause, null);
  });

  it("needed no restart, no reset and no write to say so", async () => {
    // Nothing between the two reads but the instant they were taken at. The
    // pause row is still exactly where it was, byte for byte.
    const rows = await query(
      container.url,
      "select count(*)::text as n from breaker_pauses",
    );
    assert.equal(rows[0].n, "1");

    const before = await renderAt(duringPause());
    const after = await renderAt(afterPause());
    assert.match(before, /data-breaker-pause="paused"/);
    assert.doesNotMatch(after, /data-breaker-pause="paused"/);
  });

  it("keeps the expired pause readable as history", async () => {
    const overview = await buildOverview({
      database,
      governor: GOVERNOR,
      config: CONFIG,
      now: afterPause(),
    });
    const source = overview.sources.find((entry) => entry.sourceId === "bestbuy-api");
    assert.equal(source?.breakerPauseHistory.length, 1);
    assert.deepEqual(source?.breakerPauseHistory[0].pausedAt, pausedAt);

    const body = await renderAt(afterPause());
    assert.match(body, /data-pause-history>1 pause\(s\) on record/);
  });
});

describe("criterion 14: one source paused leaves every other reported not paused", () => {
  it("reports every other configured source as not paused", async () => {
    const overview = await buildOverview({
      database,
      governor: GOVERNOR,
      config: CONFIG,
      now: duringPause(),
    });
    for (const sourceId of ["second-source", "jsonld-generic"]) {
      const source = overview.sources.find((entry) => entry.sourceId === sourceId);
      assert.ok(source !== undefined, `${sourceId} is missing from the overview`);
      assert.equal(source.breakerPause, null, sourceId);
    }
  });

  it("says so on the page, for each of them by name", async () => {
    const body = await renderAt(duringPause());
    for (const sourceId of ["second-source", "jsonld-generic"]) {
      const state = stateFor(body, "data-breaker-pause", sourceId);
      assert.match(state, /data-breaker-pause="none"/, sourceId);
      assert.match(state, /Not paused by the breaker/, sourceId);
    }
  });
});

describe("criterion 15: three states, and never two of them shown as one", () => {
  before(async () => {
    const periodStart = periodStartFor(duringPause().getTime(), PERIOD_MS);
    // THE VENDOR's refusal, for a DIFFERENT source than the paused one.
    await query(
      container.url,
      "insert into source_period_stops (source_id, period_start, stopped_at, reason) " +
        "values ('second-source', $1, $2, $3)",
      [
        periodStart.toISOString(),
        duringPause().toISOString(),
        "second-source answered 403. The vendor documents that status as the " +
          "API key being invalid or the allocated call limit exceeded.",
      ],
    );
    // THIS SYSTEM's own budget, spent, for a THIRD source.
    await query(
      container.url,
      "insert into governor_allowance_usage (source_id, period_start, consumed, stopped_at) " +
        "values ('bestbuy-api', $1, 2000, $2)",
      [periodStart.toISOString(), duringPause().toISOString()],
    );
  });

  it("shows the vendor's stop with its period and its recorded reason", async () => {
    const body = await renderAt(duringPause());
    const state = stateFor(body, "data-vendor-stop", "second-source");
    assert.match(state, /data-vendor-stop="stopped"/);
    assert.match(state, /STOPPED BY THE SOURCE ITSELF/);
    assert.match(state, /data-vendor-stop-period>/);
    assert.match(state, /data-vendor-stop-reason>[^<]*answered 403/);
  });

  it("gives each of the three its own marker, and never one marker for two", async () => {
    const body = await renderAt(duringPause());
    // bestbuy-api is BOTH paused by the breaker AND at its own allowance. Two
    // states at once, on one source, and the page has to carry both without
    // merging them - which is the hardest version of this criterion.
    const breaker = stateFor(body, "data-breaker-pause", "bestbuy-api");
    const allowance = stateFor(body, "data-allowance-state", "bestbuy-api");
    const vendor = stateFor(body, "data-vendor-stop", "bestbuy-api");

    assert.match(breaker, /data-breaker-pause="paused"/);
    assert.match(allowance, /data-allowance-state="stopped"/);
    // And the VENDOR has not stopped this one, which is the distinction: its
    // own allowance being spent is not the vendor refusing it.
    assert.match(vendor, /data-vendor-stop="none"/);

    // The three sentences say three different things about who decided.
    assert.match(breaker, /this system's own verdict about this source/);
    assert.match(allowance, /our budget, not the vendor's refusal/);
    const vendorElsewhere = stateFor(body, "data-vendor-stop", "second-source");
    assert.match(vendorElsewhere, /the vendor's verdict about us/);
  });

  it("keeps the three attributes disjoint: no element carries two of them", async () => {
    const body = await renderAt(duringPause());
    const elements = body.match(/<span class="state[^>]*>/g) ?? [];
    assert.ok(elements.length >= 9, `only ${elements.length} state elements`);
    for (const element of elements) {
      const carried = [
        "data-breaker-pause",
        "data-allowance-state",
        "data-vendor-stop",
      ].filter((attribute) => element.includes(attribute));
      assert.equal(
        carried.length,
        1,
        `one element carries ${carried.join(" and ")}, so two of the three ` +
          `states are the same state on the page: ${element}`,
      );
    }
  });

  it("second-source is stopped by the vendor and NOT by the breaker or its allowance", async () => {
    const overview = await buildOverview({
      database,
      governor: GOVERNOR,
      config: CONFIG,
      now: duringPause(),
    });
    const source = overview.sources.find((entry) => entry.sourceId === "second-source");
    assert.ok(source !== undefined);
    assert.ok(source.vendorStop !== null, "the vendor stop is not visible at all");
    assert.equal(source.breakerPause, null, "a vendor stop was read as a pause");
    assert.ok(source.allowance.metered);
    assert.equal(
      source.allowance.atLimit,
      false,
      "a vendor stop was read as this system's own allowance being spent",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One state element out of the page, so an assertion cannot drift onto another.
 *
 * Sliced from its opening tag to the start of the NEXT state element (or the end
 * of the section), rather than to the first closing tag: these elements have
 * children, and a non-greedy match would stop at the first one and quietly hide
 * everything the criterion is about.
 */
function stateFor(body: string, attribute: string, sourceId: string): string {
  const pattern = new RegExp(
    `<span class="state[^>]*${attribute}="[^"]*" data-source-id="${sourceId}"[^>]*>`,
  );
  const match = pattern.exec(body);
  assert.ok(match !== null, `${sourceId} has no ${attribute} element on the page`);

  const start = match.index;
  const next = body.indexOf('<span class="state', start + match[0].length);
  const sectionEnd = body.indexOf("</section>", start);
  const end =
    next === -1 || (sectionEnd !== -1 && sectionEnd < next) ? sectionEnd : next;
  return body.slice(start, end === -1 ? body.length : end);
}
