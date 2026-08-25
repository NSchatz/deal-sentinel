/**
 * Acceptance criteria 16 and 17 of spec S0023-deal-sentinel-governor-2:
 *
 *   AC16 WHEN a source's error-or-block rate over its configured window crosses
 *        its configured threshold THE SYSTEM SHALL refuse further requests for
 *        that source until its configured pause interval has elapsed, and SHALL
 *        continue to serve every other source at that other source's own
 *        ceiling.
 *   AC17 WHEN the breaker pauses a source THE SYSTEM SHALL emit exactly one
 *        notification for that pause, however many further failures or requests
 *        arrive while it is paused, and the refusal SHALL name the condition
 *        that paused it.
 *
 * "Notify once" is graded against an injected notification port (spec ruling
 * R3): ALERT-4 owns the channel, and this phase asserts what the governor emits
 * and never what a transport promises. The sink here counts calls.
 *
 * Two stub servers, on two loopback addresses, so "every other source at that
 * other source's own ceiling" is literally a different host with a different
 * configured ceiling - and so that nothing in this file leaves the machine
 * (AC23).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createFetchTransport } from "@deal-sentinel/governor";

import { reply, routes, startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import type { Harness } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const PAUSE_MS = 1_800_000;

let failing: LoopbackServer;
let healthy: LoopbackServer;

before(async () => {
  failing = await startLoopbackServer(
    routes({ "/robots.txt": reply(404, "no rules") }, 500),
    "127.0.0.1",
  );
  healthy = await startLoopbackServer(
    (request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        response.writeHead(404);
        response.end("no rules");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("a price would be here");
    },
    "127.0.0.2",
  );
});

after(async () => {
  await failing.close();
  await healthy.close();
});

function harness(clock: FakeClock): Harness {
  return buildGovernor({
    transport: createFetchTransport(),
    clock,
    config: testConfig({
      http: { requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576 },
      hosts: {
        "127.0.0.1": {
          maxRequests: 5_000,
          intervalMs: 60_000,
          minDelayMs: 1,
          jitterMs: 1,
        },
        // A different host with its own, slower, ceiling.
        "127.0.0.2": {
          maxRequests: 100,
          intervalMs: 60_000,
          minDelayMs: 250,
          jitterMs: 10,
        },
      },
      breaker: {
        windowMs: 600_000,
        minimumOutcomes: 4,
        failureRateThreshold: 0.5,
        pauseMs: PAUSE_MS,
      },
      sources: { "failing-source": {}, "healthy-source": {} },
    }),
  });
}

describe("a source whose failures cross its threshold is paused", () => {
  it("refuses further requests for that source, naming the condition", async () => {
    const clock = new FakeClock(0);
    const { governor, notifier } = harness(clock);

    // Outcomes for this source: one 404 on robots.txt (the host ANSWERED, so
    // not a failure) and then a 500 per request.
    const reasons: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const outcome = await governor.request({
        url: `${failing.origin}/listing/${index}`,
        sourceId: "failing-source",
      });
      reasons.push(outcome.ok ? `status ${outcome.response.status}` : outcome.reason);
    }

    assert.deepEqual(reasons.slice(0, 3), ["status 500", "status 500", "status 500"]);
    assert.deepEqual(reasons.slice(3), [
      "source-paused",
      "source-paused",
      "source-paused",
    ]);

    const refused = await governor.request({
      url: `${failing.origin}/listing/99`,
      sourceId: "failing-source",
    });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.match(refused.detail, /error or a block/);
    assert.match(refused.detail, /configured threshold of 0\.5/);
    assert.match(refused.detail, /paused for 1800000ms/);

    assert.equal(notifier.of("breaker-paused").length, 1);
  });

  it("emits exactly one notification however many requests arrive while paused", async () => {
    const clock = new FakeClock(0);
    const { governor, notifier } = harness(clock);

    for (let index = 0; index < 25; index += 1) {
      await governor.request({
        url: `${failing.origin}/listing/${index}`,
        sourceId: "failing-source",
      });
    }

    const paused = notifier.of("breaker-paused");
    assert.equal(paused.length, 1, `${paused.length} notifications for one pause`);
    assert.equal(paused[0].sourceId, "failing-source");
    assert.match(paused[0].detail, /every other source keeps running/);
    // Stamped from the INJECTED clock, which started at 0 in this test, and so
    // is nowhere near the wall clock. A notification timed by `Date.now()`
    // could not be asserted about at all.
    assert.ok(paused[0].at.getTime() <= clock.now());
    assert.ok(paused[0].at.getTime() < 1_000_000);
  });

  it("leaves every other source running, at that other source's own ceiling", async () => {
    const clock = new FakeClock(0);
    const { governor, notifier } = harness(clock);

    for (let index = 0; index < 6; index += 1) {
      await governor.request({
        url: `${failing.origin}/listing/${index}`,
        sourceId: "failing-source",
      });
    }
    const paused = await governor.request({
      url: `${failing.origin}/listing/x`,
      sourceId: "failing-source",
    });
    assert.equal(paused.ok, false);

    const servedBefore = healthy.served.length;
    const first = await governor.request({
      url: `${healthy.origin}/listing/1`,
      sourceId: "healthy-source",
    });
    const second = await governor.request({
      url: `${healthy.origin}/listing/2`,
      sourceId: "healthy-source",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(healthy.served.length - servedBefore, 3); // robots plus two pages
    // Its own ceiling: at least the 250ms floor configured for THAT host, not
    // the 1ms configured for the failing one.
    assert.ok(second.release.at - first.release.at >= 250);
    assert.equal(notifier.of("breaker-paused").length, 1);
  });

  it("serves the source again once the configured pause has elapsed", async () => {
    const clock = new FakeClock(0);
    const { governor, notifier } = harness(clock);

    for (let index = 0; index < 6; index += 1) {
      await governor.request({
        url: `${failing.origin}/listing/${index}`,
        sourceId: "failing-source",
      });
    }
    const duringPause = await governor.request({
      url: `${failing.origin}/listing/a`,
      sourceId: "failing-source",
    });
    assert.equal(duringPause.ok, false);

    await clock.advanceBy(PAUSE_MS + 1);

    const servedBefore = failing.served.length;
    const afterPause = await governor.request({
      url: `${failing.origin}/listing/b`,
      sourceId: "failing-source",
    });
    // The host is still broken, so this is a 500 rather than a refusal - but it
    // was ATTEMPTED, which is what the pause expiring means.
    assert.equal(afterPause.ok, true);
    if (!afterPause.ok) return;
    assert.equal(afterPause.response.status, 500);
    assert.equal(failing.served.length - servedBefore, 1);

    // And the window starts empty, so one failure does not re-trip it at once.
    assert.equal(notifier.of("breaker-paused").length, 1);
  });

  it("does not pause a source on too small a sample to have a rate", async () => {
    const clock = new FakeClock(0);
    const { governor, notifier } = harness(clock);

    // Two outcomes: the robots 404 and one 500. The configured minimum is four.
    const outcome = await governor.request({
      url: `${failing.origin}/listing/1`,
      sourceId: "failing-source",
    });
    assert.equal(outcome.ok, true);
    assert.equal(notifier.of("breaker-paused").length, 0);
  });
});
