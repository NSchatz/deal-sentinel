/**
 * Acceptance criterion 1 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN any code path in this repo issues an outbound HTTP request THE SYSTEM
 *   SHALL apply the destination host's configured request ceiling and a
 *   randomised delay before that request leaves the process.
 *
 * "Before it leaves the process" is the assertable part, so the transport here
 * records the instant on the injected clock at which it was handed each
 * request, and every assertion is about that instant. Nothing sleeps: the clock
 * is virtual (`test/support/fake-clock.ts`).
 *
 * Criterion 2 - that there is no other way out of the process - is graded in
 * `no-direct-http.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGovernor,
  productRequests,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../support/fake-clock.ts";

const HOST = "127.0.0.1";

function ceilings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    [HOST]: {
      maxRequests: 100,
      intervalMs: 60_000,
      minDelayMs: 2_000,
      jitterMs: 1_000,
      ...overrides,
    },
  };
}

describe("every request leaves through the governor, and not before its delay", () => {
  it("holds the first request for the configured delay plus jitter", async () => {
    const clock = new FakeClock(1_000_000);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      // 0.4 of a 1000ms jitter window is 400ms on top of the 2000ms floor.
      random: sequenceRandom([0.4]),
      config: testConfig({ hosts: ceilings() }),
    });

    const outcome = await governor.request({
      url: `http://${HOST}:8080/listing/1`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, true);
    // Two requests left: this host's robots.txt, then the listing. Both waited.
    assert.equal(transport.sent.length, 2);
    assert.equal(transport.sent[0].at, 1_000_000 + 2_400);
    assert.equal(transport.sent[1].at, 1_000_000 + 2_400 + 2_400);
    assert.equal(productRequests(transport.sent).length, 1);
  });

  it("carries the configured user agent on what it releases", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: testConfig({
        hosts: ceilings(),
        userAgent: "deal-sentinel-test/9.9 (+loopback only)",
      }),
    });

    await governor.request({ url: `http://${HOST}:8080/x`, sourceId: "test-source" });

    for (const request of transport.sent) {
      assert.equal(request.headers["user-agent"], "deal-sentinel-test/9.9 (+loopback only)");
    }
  });

  it("varies the delay across a sample rather than emitting a constant one", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0, 0.25, 0.5, 0.75, 0.999, 0.1]),
      config: testConfig({ hosts: ceilings() }),
    });

    for (let index = 0; index < 5; index += 1) {
      const outcome = await governor.request({
        url: `http://${HOST}:8080/listing/${index}`,
        sourceId: "test-source",
      });
      assert.equal(outcome.ok, true);
    }

    const instants = transport.sent.map((request) => request.at);
    const gaps = instants.slice(1).map((instant, index) => instant - instants[index]);

    for (const gap of gaps) {
      assert.ok(gap >= 2_000, `a gap of ${gap}ms is below the configured 2000ms floor`);
      assert.ok(gap <= 3_000, `a gap of ${gap}ms is above the floor plus the jitter`);
    }
    assert.ok(
      new Set(gaps).size >= 3,
      `the delay did not vary across the sample: ${gaps.join(", ")}`,
    );
  });

  it("applies the ceiling as well as the delay", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0]),
      // Two requests per ten seconds: the robots fetch and one listing fit, the
      // second listing does not.
      config: testConfig({
        hosts: ceilings({ maxRequests: 2, intervalMs: 10_000, minDelayMs: 100, jitterMs: 1 }),
      }),
    });

    await governor.request({ url: `http://${HOST}:8080/a`, sourceId: "test-source" });
    await governor.request({ url: `http://${HOST}:8080/b`, sourceId: "test-source" });

    const instants = transport.sent.map((request) => request.at);
    assert.equal(instants.length, 3);
    assert.equal(instants[0], 100);
    assert.equal(instants[1], 200);
    // The third release waits for the first to age out of the ten-second window.
    assert.equal(instants[2], 10_100);
  });

  it("refuses a URL that is not http or https rather than handing it to a client", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: testConfig({ hosts: ceilings() }),
    });

    await assert.rejects(
      () => governor.request({ url: "file:///etc/passwd", sourceId: "test-source" }),
      /not a scheme this governor fetches/,
    );
    await assert.rejects(
      () => governor.request({ url: "/relative/path", sourceId: "test-source" }),
      /not an absolute URL/,
    );
    assert.equal(transport.sent.length, 0);
  });

  it("reports the delay it applied, so an operator can see what the ceiling cost", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0.5]),
      config: testConfig({ hosts: ceilings() }),
    });

    const outcome = await governor.request({
      url: `http://${HOST}:8080/listing/7`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.release.host, HOST);
    assert.equal(outcome.release.delayMs, 2_500);
    assert.equal(outcome.release.at, transport.sent[1].at);
  });
});
