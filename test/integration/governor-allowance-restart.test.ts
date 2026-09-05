/**
 * Acceptance criterion 22 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN the process restarts inside an allowance period THE SYSTEM SHALL
 *   continue counting that period from the consumption already recorded and
 *   SHALL NOT reset it.
 *
 * Spec ruling R5: the counter therefore lives in the store this repository
 * already has, because "a crash loop inside a period is exactly how a free
 * allowance gets burned twice". This test does not mock that store. It starts a
 * real PostgreSQL container, runs the real migrations, spends part of an
 * allowance through one governor, throws that governor and its connection pool
 * away, builds a second one against the same database, and asserts the second
 * one continues the first one's count.
 *
 * The two endpoints in this file are the local Postgres container and a stub
 * HTTP server on 127.0.0.1. Nothing else is reached (AC23).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, initializeHistory } from "@deal-sentinel/db";
import {
  Governor,
  LIVE_TRANSPORT,
  createPostgresAllowanceStore,
  periodStartFor,
} from "@deal-sentinel/governor";
import type { AllowanceStore, GovernorConfig } from "@deal-sentinel/governor";

import {
  destroyPostgres,
  dockerCanRunContainers,
  startPostgres,
} from "../support/postgres-container.ts";
import type { PostgresContainer } from "../support/postgres-container.ts";
import { query } from "../support/seed.ts";
import { startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { recordingNotifier, testConfig } from "../support/governor-harness.ts";
import type { RecordingNotifier } from "../support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../support/fake-clock.ts";

const PERIOD_MS = 3_600_000;
const LIMIT = 6;
/** A fixed instant well inside one period, so both processes agree on it. */
const START = 4 * PERIOD_MS + 90_000;

let container: PostgresContainer;
let server: LoopbackServer;

/**
 * Answered before any test is declared, by starting a container. An
 * environment whose Docker cannot start one turns this suite into a skip with
 * a reason rather than into a hook timeout that reads like a defect in the
 * code under test.
 */
const dockerUsable = await dockerCanRunContainers();
const skip = dockerUsable
  ? false
  : "this machine's Docker cannot start a container, so the durable allowance " +
    "counter cannot be exercised against real PostgreSQL here";

before(async () => {
  if (!dockerUsable) return;
  container = await startPostgres("governor-allowance");
  const pool = new pg.Pool({ connectionString: container.url });
  try {
    await initializeHistory(pool, { note: "governor allowance restart suite" });
  } finally {
    await pool.end();
  }

  server = await startLoopbackServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      response.writeHead(404);
      response.end("no rules");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("a price would be here");
  });
}, { timeout: 300_000 });

after(async () => {
  if (server) await server.close();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

function config(): GovernorConfig {
  return testConfig({
    http: { requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576 },
    hosts: {
      "127.0.0.1": {
        maxRequests: 5_000,
        intervalMs: 60_000,
        minDelayMs: 1,
        jitterMs: 1,
      },
    },
    robots: { cacheBoundMs: 6 * PERIOD_MS },
    breaker: { minimumOutcomes: 10_000 },
    sources: {
      metered: { allowance: { limit: LIMIT, periodMs: PERIOD_MS, warnFraction: 0.5 } },
    },
  });
}

/**
 * One process's worth of governor: its own pool, its own store handle, its own
 * in-memory caches. Closing the pool is what "the process went away" means.
 */
function startProcess(clock: FakeClock): {
  governor: Governor;
  notifier: RecordingNotifier;
  store: AllowanceStore;
  stop: () => Promise<void>;
} {
  const pool = new pg.Pool({ connectionString: container.url });
  const store = createPostgresAllowanceStore(createDatabase(pool));
  const notifier = recordingNotifier();
  const governor = new Governor({
    config: config(),
    clock,
    random: sequenceRandom([0.5]),
    transport: LIVE_TRANSPORT,
    notifier,
    allowanceStore: store,
  });
  return {
    governor,
    notifier,
    store,
    stop: async () => {
      await pool.end();
    },
  };
}

async function storedConsumption(): Promise<number> {
  const rows = await query(
    container.url,
    "select consumed::text as consumed, warned_at::text as warned_at, " +
      "stopped_at::text as stopped_at from governor_allowance_usage " +
      "where source_id = $1 and period_start = $2",
    ["metered", periodStartFor(START, PERIOD_MS).toISOString()],
  );
  assert.equal(rows.length, 1, "the allowance ledger holds one row for this period");
  return Number(rows[0].consumed);
}

describe("the allowance counter survives the process that wrote it", { skip }, () => {
  it("continues the period's count after a restart rather than resetting it", { timeout: 300_000 }, async () => {
    // ---- first process ----
    const first = startProcess(new FakeClock(START));
    for (let index = 0; index < 3; index += 1) {
      const outcome = await first.governor.request({
        url: `${server.origin}/listing/${index}`,
        sourceId: "metered",
      });
      assert.equal(outcome.ok, true);
    }
    // Four releases: the robots retrieval and three listings.
    assert.equal(await storedConsumption(), 4);
    // Warn fraction 0.5 of 6 is 3, crossed on the third release.
    assert.equal(first.notifier.of("allowance-warn").length, 1);
    assert.equal(first.notifier.of("allowance-stop").length, 0);
    await first.stop();

    // ---- the process restarts, inside the same period ----
    const second = startProcess(new FakeClock(START + 60_000));

    // It reads what is already recorded, before it does anything at all.
    const record = await second.store.read("metered", periodStartFor(START, PERIOD_MS));
    assert.equal(record.consumed, 4, "the new process began the period again");
    assert.notEqual(record.warnedAt, null, "the warn mark did not survive the restart");

    // Two more releases: this process fetches robots.txt for itself (its cache
    // died with the last one) and then one listing. That is release five and
    // six of six, so the allowance is reached.
    const served = await second.governor.request({
      url: `${server.origin}/listing/after-restart`,
      sourceId: "metered",
    });
    assert.equal(served.ok, true);
    assert.equal(await storedConsumption(), LIMIT);

    // Stopped now, on a count the first process started.
    const refused = await second.governor.request({
      url: `${server.origin}/listing/one-too-many`,
      sourceId: "metered",
    });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.reason, "allowance-exhausted");

    // Exactly one stop notification, from the process that reached the
    // allowance - and NO second warning, because the warn mark is durable too.
    assert.equal(second.notifier.of("allowance-stop").length, 1);
    assert.equal(
      second.notifier.of("allowance-warn").length,
      0,
      "the restart re-sent a warning the owner had already had",
    );

    // The ledger says so in the row itself.
    const rows = await query(
      container.url,
      "select consumed::text as consumed, warned_at is not null as warned, " +
        "stopped_at is not null as stopped from governor_allowance_usage " +
        "where source_id = $1",
      ["metered"],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].consumed, String(LIMIT));
    assert.equal(rows[0].warned, true);
    assert.equal(rows[0].stopped, true);

    await second.stop();
  });

  it("starts the next period from zero, in a new row", { timeout: 300_000 }, async () => {
    const clock = new FakeClock(START + PERIOD_MS);
    const third = startProcess(clock);
    try {
      const outcome = await third.governor.request({
        url: `${server.origin}/listing/next-period`,
        sourceId: "metered",
      });
      assert.equal(outcome.ok, true, "the next period did not serve the stopped source");

      const rows = await query(
        container.url,
        "select period_start::text as period_start, consumed::text as consumed " +
          "from governor_allowance_usage where source_id = $1 order by period_start",
        ["metered"],
      );
      assert.equal(rows.length, 2, "the new period did not get its own row");
      assert.equal(rows[0].consumed, String(LIMIT));
      // Robots plus one listing in the new period.
      assert.equal(rows[1].consumed, "2");
      assert.equal(third.notifier.of("allowance-stop").length, 0);
    } finally {
      await third.stop();
    }
  });
});
