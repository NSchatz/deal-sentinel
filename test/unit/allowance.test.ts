/**
 * Acceptance criteria 18 through 21 of spec S0023-deal-sentinel-governor-2:
 *
 *   AC18 WHEN a metered source's consumption for the current period reaches its
 *        configured warn fraction of its allowance THE SYSTEM SHALL emit exactly
 *        one warning for that period, however many further requests it serves.
 *   AC19 WHEN a metered source's consumption reaches its configured allowance
 *        THE SYSTEM SHALL stop that source for the remainder of the period,
 *        refusing its requests rather than slowing them, SHALL emit exactly one
 *        stop notification, and SHALL leave every other source serving.
 *   AC20 WHEN a request for a metered source leaves the process THE SYSTEM SHALL
 *        count it against that source's allowance whatever the response is,
 *        including an error, a 403 and a block.
 *   AC21 WHEN a new allowance period begins THE SYSTEM SHALL serve a previously
 *        stopped source again, counting from zero for the new period.
 *
 * AC22 - that the count survives a restart - is graded against real PostgreSQL
 * in `test/integration/governor-allowance-restart.test.ts`.
 *
 * READING TAKEN, and it shows up in every number below: the governor's own
 * retrieval of a host's `robots.txt` is a request made on behalf of that source
 * and IS counted against its allowance. Not counting it would mean a metered
 * source could issue requests the ledger never saw, which is the failure this
 * accounting exists to prevent. Each case says how many of its releases were
 * robots retrievals.
 *
 * CONCURRENCY IS PART OF THESE CRITERIA AND IS EXERCISED HERE. "Reaches its
 * configured allowance" is a statement about a counter that several requests
 * share, and the requests that share it are NOT serialised with one another:
 * `HostScheduler` queues per host by design, because AC4 forbids one host at its
 * ceiling from holding up another. So one metered source spread across several
 * hosts is the ordinary case, not an exotic one - it is what an adapter with a
 * page list does - and a suite that only ever offers one request at a time
 * cannot tell a counter that is spent atomically from one that is read, waited
 * on, and then written. The last two describe blocks offer them at once.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  LIVE_TRANSPORT,
  createMemoryAllowanceStore,
  periodStartFor,
} from "@deal-sentinel/governor";
import type { AllowanceStore } from "@deal-sentinel/governor";

import { closedLoopbackOrigin, startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import type { Harness } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const PERIOD_MS = 3_600_000;
const LIMIT = 6;

/**
 * 127.0.0.0/8 is loopback in its entirety, so a second address is a second HOST
 * on the same machine: separately accounted for by the governor (AC4), reached
 * without leaving this machine (AC23).
 */
const HOSTS = ["127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4"];

const answer = (request: { url?: string }): number => {
  const path = (request.url ?? "/").split("?")[0];
  const answers: Record<string, number> = {
    "/robots.txt": 404,
    "/ok": 200,
    "/forbidden": 403,
    "/error": 500,
    "/throttled": 429,
  };
  return answers[path] ?? 200;
};

let server: LoopbackServer;
/** One stub per address in `HOSTS`, all answering the same routes. */
const servers: LoopbackServer[] = [];

before(async () => {
  for (const host of HOSTS) {
    servers.push(
      await startLoopbackServer((request, response) => {
        response.writeHead(answer(request), { "content-type": "text/plain" });
        response.end(`answer for ${request.url}`);
      }, host),
    );
  }
  server = servers[0];
});

after(async () => {
  for (const stub of servers) await stub.close();
});

function harness(clock: FakeClock): Harness {
  return buildGovernor({
    transport: LIVE_TRANSPORT,
    clock,
    config: testConfig({
      http: { requestTimeoutMs: 2_000, maxResponseBytes: 1_048_576 },
      hosts: {
        "127.0.0.1": {
          maxRequests: 5_000,
          intervalMs: 60_000,
          minDelayMs: 1,
          jitterMs: 1,
        },
      },
      // Longer than the allowance period below, so that crossing a period
      // boundary in this file does not also expire the robots decision and add
      // a retrieval to the new period's count. The cache bound is graded in
      // robots-cache.test.ts.
      robots: { cacheBoundMs: 6 * PERIOD_MS },
      // The breaker is graded in breaker.test.ts; here it is out of the way so
      // that a 500 counts against the allowance and nothing else.
      breaker: { minimumOutcomes: 10_000 },
      backPressure: { defaultBackoffMs: 1 },
      sources: {
        metered: {
          allowance: { limit: LIMIT, periodMs: PERIOD_MS, warnFraction: 0.5 },
        },
        unmetered: {},
      },
    }),
  });
}

async function consumed(harness: Harness, sourceId: string): Promise<number> {
  const record = await harness.allowanceStore.read(
    sourceId,
    periodStartFor(harness.clock.now(), PERIOD_MS),
  );
  return record.consumed;
}

describe("every request that leaves is counted, whatever comes back", () => {
  it("counts a 200, a 403, a 500 and a 429 alike", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    for (const path of ["/ok", "/forbidden", "/error", "/throttled"]) {
      const outcome = await context.governor.request({
        url: `${server.origin}${path}`,
        sourceId: "metered",
      });
      assert.equal(outcome.ok, true, `${path} did not leave the process`);
    }

    // Five releases: the robots retrieval and the four listings.
    assert.equal(await consumed(context, "metered"), 5);
  });

  it("counts a request that never got an answer at all", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);
    const dead = await closedLoopbackOrigin();

    const outcome = await context.governor.request({
      url: `${dead}/ok`,
      sourceId: "metered",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // The robots retrieval left this process and failed. It is still spent.
    assert.equal(outcome.reason, "robots-unreachable");
    assert.equal(await consumed(context, "metered"), 1);
  });

  it("counts nothing for a source with no configured allowance", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "unmetered",
    });
    assert.equal(await consumed(context, "unmetered"), 0);
  });
});

describe("the warn fraction warns once, and the allowance stops the source", () => {
  it("warns exactly once for the period", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    // Warn fraction 0.5 of 6 is 3. The robots retrieval is the first release,
    // so the third release - the second listing - crosses it.
    await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    assert.equal(context.notifier.of("allowance-warn").length, 0);

    await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    assert.equal(await consumed(context, "metered"), 3);
    assert.equal(context.notifier.of("allowance-warn").length, 1);

    await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    assert.equal(
      context.notifier.of("allowance-warn").length,
      1,
      "a second warning was emitted inside one period",
    );
    assert.match(context.notifier.of("allowance-warn")[0].detail, /warn fraction of 0\.5/);
  });

  it("stops the source at its allowance, refusing rather than slowing", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    // Six releases: the robots retrieval plus five listings.
    for (let index = 0; index < 5; index += 1) {
      const outcome = await context.governor.request({
        url: `${server.origin}/ok`,
        sourceId: "metered",
      });
      assert.equal(outcome.ok, true);
    }
    assert.equal(await consumed(context, "metered"), LIMIT);
    assert.equal(context.notifier.of("allowance-stop").length, 1);

    const servedBefore = server.served.length;
    const stoppedAt = clock.now();

    const refused = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });

    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.reason, "allowance-exhausted");
    assert.match(refused.detail, /stopped for the remainder of the period rather than slowed/);
    // Refused, not slowed: nothing left the process and no time was spent
    // waiting to send it.
    assert.equal(server.served.length, servedBefore);
    assert.equal(clock.now(), stoppedAt);
    assert.equal(await consumed(context, "metered"), LIMIT);
  });

  it("emits exactly one stop notification however many requests are refused", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    for (let index = 0; index < 20; index += 1) {
      await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    }

    assert.equal(context.notifier.of("allowance-stop").length, 1);
    assert.equal(context.notifier.of("allowance-warn").length, 1);
    assert.equal(await consumed(context, "metered"), LIMIT);
    assert.equal(context.notifier.of("allowance-stop")[0].sourceId, "metered");
  });

  it("leaves every other source serving", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    for (let index = 0; index < 8; index += 1) {
      await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    }
    const stopped = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });
    assert.equal(stopped.ok, false);

    const other = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "unmetered",
    });
    assert.equal(other.ok, true, "one source's exhausted allowance stopped another");
  });
});

describe("a new period starts the count again", () => {
  it("serves a previously stopped source, counting from zero", async () => {
    const clock = new FakeClock(0);
    const context = harness(clock);

    for (let index = 0; index < 8; index += 1) {
      await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    }
    const stopped = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });
    assert.equal(stopped.ok, false);
    assert.equal(await consumed(context, "metered"), LIMIT);

    await clock.advanceBy(PERIOD_MS);

    const served = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });
    assert.equal(served.ok, true, "the new period did not serve the source again");
    // Robots is still cached for this host, so the only release in the new
    // period is the listing itself.
    assert.equal(await consumed(context, "metered"), 1);

    // The new period gets its own single warning and its own single stop.
    assert.equal(context.notifier.of("allowance-warn").length, 1);
    for (let index = 0; index < 8; index += 1) {
      await context.governor.request({ url: `${server.origin}/ok`, sourceId: "metered" });
    }
    assert.equal(context.notifier.of("allowance-warn").length, 2);
    assert.equal(context.notifier.of("allowance-stop").length, 2);
  });

  it("aligns periods to the epoch, so every process agrees where one starts", () => {
    assert.equal(periodStartFor(PERIOD_MS * 3 + 5, PERIOD_MS).getTime(), PERIOD_MS * 3);
    assert.equal(periodStartFor(PERIOD_MS * 3, PERIOD_MS).getTime(), PERIOD_MS * 3);
    assert.equal(periodStartFor(PERIOD_MS * 3 - 1, PERIOD_MS).getTime(), PERIOD_MS * 2);
  });
});

/**
 * A harness whose hosts are the four loopback addresses above, so that one
 * metered source can be offered several requests that nothing serialises.
 */
function spreadHarness(clock: FakeClock, limit: number, store?: AllowanceStore): Harness {
  return buildGovernor({
    transport: LIVE_TRANSPORT,
    clock,
    allowanceStore: store,
    config: testConfig({
      http: { requestTimeoutMs: 2_000, maxResponseBytes: 1_048_576 },
      hosts: Object.fromEntries(
        HOSTS.map((host) => [
          host,
          // Loose enough that neither the ceiling nor the delay is what refuses
          // anything: the only gate under test here is the allowance.
          { maxRequests: 5_000, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        ]),
      ),
      robots: { cacheBoundMs: 6 * PERIOD_MS },
      breaker: { minimumOutcomes: 10_000 },
      backPressure: { defaultBackoffMs: 1 },
      sources: {
        metered: { allowance: { limit, periodMs: PERIOD_MS, warnFraction: 0.5 } },
        unmetered: {},
      },
    }),
  });
}

/** Everything the four stubs actually received, whoever asked for it. */
function receivedEverywhere(): number {
  return servers.reduce((total, stub) => total + stub.served.length, 0);
}

describe("one metered source offered to several hosts at once (AC19, AC20)", () => {
  it("serves no more than the allowance, however many hosts are offered together", async () => {
    const clock = new FakeClock(0);
    const limit = 3;
    const context = spreadHarness(clock, limit);
    const before = receivedEverywhere();

    // What an adapter with a page list does. Nothing serialises these: the
    // per-host queue is per host, so each one reaches the allowance on its own.
    const outcomes = await Promise.all(
      servers.map((stub) =>
        context.governor.request({ url: `${stub.origin}/ok`, sourceId: "metered" }),
      ),
    );

    const left = receivedEverywhere() - before;
    const counted = await consumed(context, "metered");

    assert.equal(
      left <= limit,
      true,
      `${left} requests reached a server for a metered source whose configured ` +
        `allowance for this period is ${limit}. The overspend must be bounded ` +
        "by the allowance, not by how many hosts are offered at once.",
    );
    // AC20 as an equation: the counter records exactly what left, so a unit
    // taken for a request that was then stopped before the wire went back.
    assert.equal(counted, left, "the counter and what actually left disagree");
    assert.equal(counted <= limit, true);
    // The offer was big enough to reach the allowance, so this is not a case
    // that passes by never getting there.
    assert.equal(counted, limit);
    assert.equal(
      outcomes.some((outcome) => !outcome.ok && outcome.reason === "allowance-exhausted"),
      true,
      "nothing was refused, so the allowance was never actually reached",
    );
  });

  it("still emits exactly one stop notification, and one warning", async () => {
    const clock = new FakeClock(0);
    const context = spreadHarness(clock, 3);

    await Promise.all(
      servers.map((stub) =>
        context.governor.request({ url: `${stub.origin}/ok`, sourceId: "metered" }),
      ),
    );

    assert.equal(
      context.notifier.of("allowance-stop").length,
      1,
      "concurrency turned notify-once into notify-once-per-racer",
    );
    assert.equal(context.notifier.of("allowance-warn").length, 1);
  });

  it("leaves every other source serving after the concurrent stop", async () => {
    const clock = new FakeClock(0);
    const context = spreadHarness(clock, 3);

    await Promise.all(
      servers.map((stub) =>
        context.governor.request({ url: `${stub.origin}/ok`, sourceId: "metered" }),
      ),
    );
    const stopped = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });
    assert.equal(stopped.ok, false);

    const other = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "unmetered",
    });
    assert.equal(other.ok, true, "one source's exhausted allowance stopped another");
  });

  it("serves the allowance again from zero in the next period (AC21)", async () => {
    const clock = new FakeClock(0);
    const context = spreadHarness(clock, 3);

    await Promise.all(
      servers.map((stub) =>
        context.governor.request({ url: `${stub.origin}/ok`, sourceId: "metered" }),
      ),
    );
    assert.equal(await consumed(context, "metered"), 3);

    await clock.advanceBy(PERIOD_MS);
    assert.equal(await consumed(context, "metered"), 0);

    // Offered the same way: all at once. How many of these are pages rather
    // than robots retrievals depends on which hosts the first period got as far
    // as caching a decision for, so the assertions below are about the
    // allowance and not about that split.
    const outcomes = await Promise.all(
      servers.map((stub) =>
        context.governor.request({ url: `${stub.origin}/ok`, sourceId: "metered" }),
      ),
    );
    assert.equal(
      outcomes.some((outcome) => outcome.ok),
      true,
      "the new period did not serve the previously stopped source at all",
    );
    assert.equal(
      await consumed(context, "metered"),
      3,
      "the new period did not spend its own full allowance from zero",
    );
    // The new period gets its own single stop, not a second one for the old.
    assert.equal(context.notifier.of("allowance-stop").length, 2);
  });
});

/**
 * The other half of counting what LEFT: a unit taken for a request that is then
 * stopped before the wire has to go back, or the allowance is quietly smaller
 * than the configured one and shrinks a little further on every such request.
 *
 * The gap is real rather than theoretical: taking the unit is a store round
 * trip, and while it is in flight another request's response can pause this
 * source's breaker. The boundary re-asks every in-memory gate on the far side of
 * that round trip - with no `await` left between the answer and the send - so
 * this request is stopped, and what it holds is returned.
 *
 * The store below delays exactly one `reserve` so the collision happens on
 * purpose rather than when the machine is slow enough. It is armed by the test
 * rather than at construction, because the first reservation a request makes is
 * usually its own `/robots.txt` retrieval's and that is not the one under test.
 */
function interruptibleStore(): {
  store: AllowanceStore;
  arm(during: () => Promise<void>): void;
} {
  const inner = createMemoryAllowanceStore();
  let armed: (() => Promise<void>) | null = null;
  return {
    arm(during) {
      armed = during;
    },
    store: {
      ...inner,
      async reserve(sourceId, periodStart, amount, limit) {
        const granted = await inner.reserve(sourceId, periodStart, amount, limit);
        // Disarmed before the hook runs, so the requests the hook makes
        // reserve normally and nothing re-enters this branch.
        const hook = armed;
        armed = null;
        if (hook !== null) await hook();
        return granted;
      },
    },
  };
}

describe("a unit taken for a request that never leaves goes back (AC20)", () => {
  it("refuses the request the breaker paused mid-reservation, and gives its unit back", async () => {
    const clock = new FakeClock(0);
    const interruptible = interruptibleStore();

    // Trips once a failure is among the outcomes in the window: the /error
    // request below is that failure.
    const context: Harness = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock,
      allowanceStore: interruptible.store,
      config: testConfig({
        http: { requestTimeoutMs: 2_000, maxResponseBytes: 1_048_576 },
        hosts: {
          "127.0.0.1": { maxRequests: 5_000, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        },
        robots: { cacheBoundMs: 6 * PERIOD_MS },
        breaker: {
          windowMs: 600_000,
          minimumOutcomes: 2,
          failureRateThreshold: 0.3,
          pauseMs: 1_800_000,
        },
        backPressure: { defaultBackoffMs: 1 },
        sources: {
          metered: { allowance: { limit: 20, periodMs: PERIOD_MS, warnFraction: 0.9 } },
        },
      }),
    });

    // Warm the robots cache first, so that the interrupted reservation is the
    // product request's own and not its robots.txt retrieval's.
    const warmup = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });
    assert.equal(warmup.ok, true);
    assert.equal(await consumed(context, "metered"), 2);

    // From here the next reservation - the product request's own, with robots
    // already cached - is the one interrupted.
    interruptible.arm(async () => {
      await context.governor.request({
        url: `${server.origin}/error`,
        sourceId: "metered",
      });
    });

    const servedOk = server.servedFor("/ok").length;
    const interrupted = await context.governor.request({
      url: `${server.origin}/ok`,
      sourceId: "metered",
    });

    assert.equal(interrupted.ok, false);
    if (interrupted.ok) return;
    assert.equal(
      interrupted.reason,
      "source-paused",
      "a source paused while the reservation was in flight still sent",
    );
    assert.equal(
      server.servedFor("/ok").length,
      servedOk,
      "the request left the process after its source had been paused",
    );
    // Two from the warm-up plus one for the /error request that tripped the
    // breaker. The interrupted request's unit was taken and given back.
    assert.equal(
      await consumed(context, "metered"),
      3,
      "the unit taken for a request that never left was kept",
    );
  });
});
