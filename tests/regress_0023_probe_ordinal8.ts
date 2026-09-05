/**
 * regress_0023_probe_ordinal8 - impl-gate ordinal 8, spec
 * S0023-deal-sentinel-governor-2. Written by the refuter, not the implementer.
 *
 * This file is a PROBE, not a finding. Ordinal 7 refuted on F17 - concurrent
 * requests for one metered source on DIFFERENT hosts each read the same
 * allowance consumption and all leave - and commit `1c2d348` claims to have
 * closed it by SPENDING the unit rather than reading it. `tests/regress_0023_F17.ts`
 * is the implementer's grade for that claim. This file exists so the pass is not
 * signed on the implementer's own test:
 *
 *   - it goes WIDER than F17's artifact (30 hosts against a limit of 4, and 40
 *     concurrent store calls against a limit of 7, where F17 used 5 and 6);
 *   - it probes the STORE statement directly, asserting not merely that the
 *     total is bounded but that every granted reservation saw a DISTINCT total.
 *     A lost update is exactly a duplicate, and a bound alone can hide one;
 *   - it puts TWO Governor instances - two processes - on ONE database at once,
 *     which no test in the diff does. An "atomic" spend that is really a
 *     per-instance lock passes every single-process test and fails this one;
 *   - it grades AC19's OTHER TWO halves under that same concurrency: exactly one
 *     stop notification, and every other source - metered and unmetered - still
 *     served;
 *   - it grades "refusing its requests rather than slowing them" as elapsed
 *     virtual time, not as a returned reason.
 *
 * Nothing here reaches a host outside 127.0.0.0/8 or the local PostgreSQL
 * container (AC23).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, initializeHistory } from "@deal-sentinel/db";
import {
  Governor,
  LIVE_TRANSPORT,
  createMemoryAllowanceStore,
  createPostgresAllowanceStore,
  periodStartFor,
  systemClock,
  systemRandom,
} from "@deal-sentinel/governor";
import type { AllowanceStore } from "@deal-sentinel/governor";

import {
  buildGovernor,
  productRequests,
  recordingNotifier,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";
import { startLoopbackServer } from "../test/support/loopback-server.ts";
import type { LoopbackServer } from "../test/support/loopback-server.ts";
import {
  destroyPostgres,
  dockerCanRunContainers,
  startPostgres,
} from "../test/support/postgres-container.ts";
import type { PostgresContainer } from "../test/support/postgres-container.ts";
import { query } from "../test/support/seed.ts";

const PERIOD_MS = 3_600_000;

/** Loose enough that neither the ceiling nor the delay refuses anything. */
const HOST = { maxRequests: 10_000, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 };

/** A breaker that cannot trip, so the only gate under test is the allowance. */
const NO_BREAKER = {
  windowMs: 600_000,
  minimumOutcomes: 1_000_000,
  failureRateThreshold: 1,
  pauseMs: 1,
};

/** 127.0.0.0/8 is all loopback: a second address is a second host, same machine. */
function loopbackAddresses(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_unused, index) => {
    const n = offset + index + 1;
    return `127.0.${Math.floor(n / 250)}.${(n % 250) + 1}`;
  });
}

function config(hosts: string[], limit: number, warnFraction = 0.5) {
  return testConfig({
    hosts: Object.fromEntries(hosts.map((host) => [host, HOST])),
    http: { requestTimeoutMs: 5_000 },
    robots: { cacheBoundMs: PERIOD_MS },
    breaker: NO_BREAKER,
    backPressure: { defaultBackoffMs: 1 },
    sources: {
      metered: { allowance: { limit, periodMs: PERIOD_MS, warnFraction } },
      "metered-other": {
        allowance: { limit: 50, periodMs: PERIOD_MS, warnFraction: 0.99 },
      },
      unmetered: {},
    },
  });
}

// ---------------------------------------------------------------------------
// Part A: the in-process shape, wider than the diff's own concurrency cases.
// ---------------------------------------------------------------------------

describe("probe A: one metered source offered to thirty hosts at once", () => {
  const HOSTS = loopbackAddresses(30);
  const LIMIT = 4;

  async function burst(store?: AllowanceStore) {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent(() => ({ status: 200 })));
    const harness = buildGovernor({
      transport,
      config: config(HOSTS, LIMIT),
      clock,
      random: sequenceRandom([0]),
      allowanceStore: store ?? createMemoryAllowanceStore(),
    });
    const outcomes = await Promise.all(
      HOSTS.map((host) =>
        harness.governor.request({ url: `http://${host}/listing`, sourceId: "metered" }),
      ),
    );
    const record = await harness.allowanceStore.read(
      "metered",
      periodStartFor(clock.now(), PERIOD_MS),
    );
    return { ...harness, transport, outcomes, record, clock };
  }

  it("AC19: no more than the configured allowance ever leaves the process", async () => {
    const { transport, record, outcomes } = await burst();
    console.log(
      "[A1] limit", LIMIT,
      "; hosts offered", HOSTS.length,
      "; requests that left", transport.sent.length,
      "; counter", record.consumed,
      "; refused", outcomes.filter((o) => !o.ok).length,
    );
    assert.equal(
      transport.sent.length <= LIMIT,
      true,
      `${transport.sent.length} requests left for a metered source whose ` +
        `configured allowance is ${LIMIT}; the counter reads ${record.consumed}.`,
    );
    // Not a case that passes by never reaching the allowance.
    assert.equal(record.consumed, LIMIT, "the burst never reached the allowance");
    // AC20 as an equation: the counter equals what actually left.
    assert.equal(record.consumed, transport.sent.length);
  });

  it("AC19: exactly one stop notification and one warning, under 30-way concurrency", async () => {
    const { notifier } = await burst();
    console.log(
      "[A2] allowance-stop", notifier.of("allowance-stop").length,
      "; allowance-warn", notifier.of("allowance-warn").length,
    );
    assert.equal(notifier.of("allowance-stop").length, 1);
    assert.equal(notifier.of("allowance-warn").length, 1);
  });

  it("AC19: every OTHER source still serves - metered and unmetered alike", async () => {
    const { governor, transport } = await burst();
    const before = transport.sent.length;

    const other = await governor.request({
      url: `http://${HOSTS[0]}/listing`,
      sourceId: "metered-other",
    });
    const unmetered = await governor.request({
      url: `http://${HOSTS[1]}/listing`,
      sourceId: "unmetered",
    });
    const stopped = await governor.request({
      url: `http://${HOSTS[2]}/listing`,
      sourceId: "metered",
    });

    console.log(
      "[A3] second metered source:", other.ok ? "ok" : other.reason,
      "; unmetered source:", unmetered.ok ? "ok" : unmetered.reason,
      "; the stopped source:", stopped.ok ? "ok" : stopped.reason,
      "; further requests that left:", transport.sent.length - before,
    );
    assert.equal(other.ok, true, "a second METERED source was stopped by the first's allowance");
    assert.equal(unmetered.ok, true, "an unmetered source was stopped by another source's allowance");
    assert.equal(stopped.ok, false);
    if (stopped.ok) return;
    assert.equal(stopped.reason, "allowance-exhausted");
  });

  it("AC19: a stopped source is REFUSED, not slowed - no time passes at all", async () => {
    const { governor, clock, transport } = await burst();
    const at = clock.now();
    const sentBefore = transport.sent.length;

    const refused = await governor.request({
      url: `http://${HOSTS[3]}/listing`,
      sourceId: "metered",
    });

    console.log(
      "[A4] virtual ms elapsed while refusing:", clock.now() - at,
      "; sleeps still pending:", clock.pending,
      "; requests that left:", transport.sent.length - sentBefore,
      "; reason:", refused.ok ? "ok" : refused.reason,
    );
    assert.equal(refused.ok, false);
    assert.equal(
      clock.now() - at,
      0,
      "the stopped source's request was SLOWED (it waited on the host queue) " +
        "rather than refused, which is what AC19 forbids in terms",
    );
    assert.equal(transport.sent.length - sentBefore, 0);
  });

  it("AC21: the next period serves the stopped source again, from zero", async () => {
    const { governor, clock, allowanceStore, transport } = await burst();
    await clock.advanceBy(PERIOD_MS);
    const fresh = await allowanceStore.read("metered", periodStartFor(clock.now(), PERIOD_MS));
    assert.equal(fresh.consumed, 0);

    const before = transport.sent.length;
    const served = await governor.request({
      url: `http://${HOSTS[4]}/listing`,
      sourceId: "metered",
    });
    console.log(
      "[A5] next period first outcome:", served.ok ? "ok" : served.reason,
      "; requests that left:", transport.sent.length - before,
    );
    assert.equal(served.ok, true, "the new period did not serve the previously stopped source");
  });
});

// ---------------------------------------------------------------------------
// Part B: the durable store, and two processes on it at once.
// ---------------------------------------------------------------------------

const dockerUsable = await dockerCanRunContainers();
const skip = dockerUsable
  ? false
  : "this machine's Docker cannot start a container, so the durable allowance " +
    "counter cannot be probed against real PostgreSQL here";

let container: PostgresContainer;
const servers: LoopbackServer[] = [];
const SERVER_ADDRESSES = loopbackAddresses(8, 100);

before(async () => {
  if (!dockerUsable) return;
  container = await startPostgres("governor-probe8");
  const pool = new pg.Pool({ connectionString: container.url });
  try {
    await initializeHistory(pool, { note: "ordinal 8 allowance concurrency probe" });
  } finally {
    await pool.end();
  }
  for (const address of SERVER_ADDRESSES) {
    servers.push(
      await startLoopbackServer((request, response) => {
        if ((request.url ?? "/").split("?")[0] === "/robots.txt") {
          response.writeHead(404);
          response.end("no rules");
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("a price would be here");
      }, address),
    );
  }
}, { timeout: 300_000 });

after(async () => {
  for (const server of servers) await server.close();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

describe("probe B: the PostgreSQL statement itself, under real concurrency", { skip }, () => {
  it("grants exactly the limit, and every grant saw a DISTINCT total (no lost update)", { timeout: 300_000 }, async () => {
    // 20 connections so the 40 calls below genuinely overlap in the server.
    const pool = new pg.Pool({ connectionString: container.url, max: 20 });
    try {
      const store = createPostgresAllowanceStore(createDatabase(pool));
      const periodStart = periodStartFor(Date.now(), PERIOD_MS);
      const limit = 7;
      const source = "probe-distinct";

      const results = await Promise.all(
        Array.from({ length: 40 }, () => store.reserve(source, periodStart, 1, limit)),
      );

      const granted = results.filter((result) => result.granted);
      const totals = granted.map((result) => result.consumed).sort((a, b) => a - b);
      const rows = await query(
        container.url,
        "select consumed::text as consumed from governor_allowance_usage where source_id = $1",
        [source],
      );

      console.log(
        "[B1] 40 concurrent reserves, limit", limit,
        "; granted", granted.length,
        "; totals each grant saw", totals,
        "; row now records", rows.map((row) => row.consumed),
      );

      assert.equal(granted.length, limit, "the store granted more (or fewer) than the limit");
      assert.deepEqual(
        totals,
        Array.from({ length: limit }, (_unused, index) => index + 1),
        "two grants saw the same total, which is a lost update: the addition " +
          "and the test are not one indivisible step",
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].consumed, String(limit));
    } finally {
      await pool.end();
    }
  });

  it("grants exactly one unit when the limit is one and thirty callers race", { timeout: 300_000 }, async () => {
    const pool = new pg.Pool({ connectionString: container.url, max: 20 });
    try {
      const store = createPostgresAllowanceStore(createDatabase(pool));
      const periodStart = periodStartFor(Date.now(), PERIOD_MS);
      const source = "probe-limit-one";

      const results = await Promise.all(
        Array.from({ length: 30 }, () => store.reserve(source, periodStart, 1, 1)),
      );
      const granted = results.filter((result) => result.granted).length;
      const rows = await query(
        container.url,
        "select consumed::text as consumed from governor_allowance_usage where source_id = $1",
        [source],
      );
      console.log("[B2] 30 concurrent reserves, limit 1; granted", granted,
        "; row records", rows.map((row) => row.consumed));
      assert.equal(granted, 1);
      assert.equal(rows[0].consumed, "1");
    } finally {
      await pool.end();
    }
  });

  it("gives a released unit back exactly once, and the limit is spendable again", { timeout: 300_000 }, async () => {
    const pool = new pg.Pool({ connectionString: container.url, max: 10 });
    try {
      const store = createPostgresAllowanceStore(createDatabase(pool));
      const periodStart = periodStartFor(Date.now(), PERIOD_MS);
      const source = "probe-release";
      const limit = 3;

      for (let index = 0; index < limit; index += 1) {
        assert.equal((await store.reserve(source, periodStart, 1, limit)).granted, true);
      }
      assert.equal((await store.reserve(source, periodStart, 1, limit)).granted, false);

      await store.release(source, periodStart, 1);
      const again = await store.reserve(source, periodStart, 1, limit);
      const after = await store.reserve(source, periodStart, 1, limit);
      const rows = await query(
        container.url,
        "select consumed::text as consumed from governor_allowance_usage where source_id = $1",
        [source],
      );
      console.log("[B3] after release: re-reserve granted", again.granted,
        "; the next one granted", after.granted,
        "; row records", rows.map((row) => row.consumed));
      assert.equal(again.granted, true);
      assert.equal(again.consumed, limit);
      assert.equal(after.granted, false, "the release widened the allowance past its limit");
      assert.equal(rows[0].consumed, String(limit));
    } finally {
      await pool.end();
    }
  });
});

describe("probe C: TWO governors on ONE database, offered at the same moment", { skip }, () => {
  it("AC19: their combined traffic stays inside the one configured allowance", { timeout: 300_000 }, async () => {
    const LIMIT = 5;
    const addresses = SERVER_ADDRESSES;
    const half = Math.ceil(addresses.length / 2);

    const pools = [
      new pg.Pool({ connectionString: container.url, max: 10 }),
      new pg.Pool({ connectionString: container.url, max: 10 }),
    ];
    const notifiers = [recordingNotifier(), recordingNotifier()];
    try {
      const governors = pools.map(
        (pool, index) =>
          new Governor({
            config: config(addresses, LIMIT, 0.6),
            clock: systemClock,
            random: systemRandom,
            transport: LIVE_TRANSPORT,
            notifier: notifiers[index],
            allowanceStore: createPostgresAllowanceStore(createDatabase(pool)),
          }),
      );

      const offers = servers.map((server, index) => {
        const governor = governors[index < half ? 0 : 1];
        return governor.request({ url: `${server.origin}/listing`, sourceId: "metered" });
      });
      const outcomes = await Promise.all(offers);

      const served = servers.reduce((total, server) => total + server.served.length, 0);
      const rows = await query(
        container.url,
        "select consumed::text as consumed, stopped_at is not null as stopped, " +
          "warned_at is not null as warned from governor_allowance_usage where source_id = $1",
        ["metered"],
      );
      const stopNotifications =
        notifiers[0].of("allowance-stop").length + notifiers[1].of("allowance-stop").length;
      const warnNotifications =
        notifiers[0].of("allowance-warn").length + notifiers[1].of("allowance-warn").length;

      console.log(
        "[C1] two governors, one database; limit", LIMIT,
        "; requests the servers actually received", served,
        "; outcomes", outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
        "; row", rows.map((row) => row.consumed),
        "; stop notifications across BOTH processes", stopNotifications,
        "; warn notifications across BOTH processes", warnNotifications,
      );

      assert.equal(
        served <= LIMIT,
        true,
        `${served} requests reached a server for a metered source whose one ` +
          `configured allowance is ${LIMIT}. Two processes sharing the counter ` +
          "each spent it as if it were their own.",
      );
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].consumed) <= LIMIT, true);
      assert.equal(
        stopNotifications <= 1,
        true,
        "each process announced the stop for itself: 'exactly one stop " +
          "notification' held only because there was only ever one process",
      );
      assert.equal(
        warnNotifications <= 1,
        true,
        "the single warning for the period was sent once per process",
      );

      // A follow-up offer proves the source really is stopped and that the one
      // stop notification exists at all.
      const later = await governors[1].request({
        url: `${servers[0].origin}/listing/later`,
        sourceId: "metered",
      });
      const stopTotal =
        notifiers[0].of("allowance-stop").length + notifiers[1].of("allowance-stop").length;
      console.log("[C2] follow-up outcome", later.ok ? "ok" : later.reason,
        "; stop notifications now", stopTotal);
      assert.equal(later.ok, false);
      if (later.ok) return;
      assert.equal(later.reason, "allowance-exhausted");
      assert.equal(stopTotal, 1, "the stop was announced zero times or more than once");
    } finally {
      for (const pool of pools) await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Part D: the boundary property the whole class of prior findings turned on -
// a gate consumed on the far side of an unbounded wait - re-probed at HEAD.
// ---------------------------------------------------------------------------

describe("probe D: a queue full of requests for a source stopped mid-queue", () => {
  it("AC19/AC20: the queue does not drain past the allowance once it is reached", async () => {
    const clock = new FakeClock(0);
    const host = "127.0.0.1";
    // ONE host, a real minimum delay: every request after the first waits on the
    // per-host queue, which is the unbounded wait the earlier findings lived in.
    const transport = recordingTransport(clock, robotsAbsent(() => ({ status: 200 })));
    const { governor, allowanceStore, notifier } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0]),
      config: testConfig({
        hosts: { [host]: { maxRequests: 1_000, intervalMs: 600_000, minDelayMs: 5_000, jitterMs: 1 } },
        robots: { cacheBoundMs: PERIOD_MS },
        breaker: NO_BREAKER,
        backPressure: { defaultBackoffMs: 1 },
        sources: { metered: { allowance: { limit: 3, periodMs: PERIOD_MS, warnFraction: 0.5 } } },
      }),
    });

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        governor.request({ url: `http://${host}/listing/${index}`, sourceId: "metered" }),
      ),
    );
    const record = await allowanceStore.read("metered", periodStartFor(clock.now(), PERIOD_MS));

    console.log(
      "[D1] twelve queued requests, allowance 3; left:",
      transport.sent.map((request) => `${new URL(request.url).pathname}@${request.at}`),
      "; counter", record.consumed,
      "; outcomes", outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
      "; stop notifications", notifier.of("allowance-stop").length,
    );

    assert.equal(transport.sent.length <= 3, true, "the queue drained past the allowance");
    assert.equal(record.consumed, transport.sent.length, "the counter and what left disagree");
    assert.equal(notifier.of("allowance-stop").length, 1);
    // The queue really was in play: the releases are spaced by the delay.
    const productPaths = productRequests(transport.sent).map((request) => request.url);
    assert.equal(productPaths.length >= 1, true);
  });
});
