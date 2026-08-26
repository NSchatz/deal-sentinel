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
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { LIVE_TRANSPORT, periodStartFor } from "@deal-sentinel/governor";

import { closedLoopbackOrigin, startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import type { Harness } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const PERIOD_MS = 3_600_000;
const LIMIT = 6;

let server: LoopbackServer;

before(async () => {
  server = await startLoopbackServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const answers: Record<string, number> = {
      "/robots.txt": 404,
      "/ok": 200,
      "/forbidden": 403,
      "/error": 500,
      "/throttled": 429,
    };
    response.writeHead(answers[path] ?? 200, { "content-type": "text/plain" });
    response.end(`answer for ${path}`);
  });
});

after(async () => {
  await server.close();
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
