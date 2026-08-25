/**
 * Acceptance criteria 3 and 4 of spec S0023-deal-sentinel-governor-2:
 *
 *   AC3 WHEN more requests are offered for one host than its configured ceiling
 *       permits in the configured interval THE SYSTEM SHALL release no more than
 *       that ceiling within that interval, SHALL separate consecutive releases
 *       to that host by at least the configured minimum delay, and SHALL vary
 *       that delay across a sample rather than emit a constant one.
 *   AC4 WHEN one host is at its ceiling THE SYSTEM SHALL still release a request
 *       for a different host as soon as that other host's own ceiling and delay
 *       allow, accounting for each host separately.
 *
 * Every instant asserted here is virtual. The governor's own fetch of each
 * host's robots.txt is a release to that host and is counted like any other: a
 * ceiling that exempted the governor's own traffic would be a ceiling with a
 * hole in it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../support/fake-clock.ts";
import type { SentRequest } from "../support/governor-harness.ts";

const A = "127.0.0.1";
const B = "127.0.0.2";

function releasesFor(sent: readonly SentRequest[], host: string): number[] {
  return sent
    .filter((request) => new URL(request.url).hostname === host)
    .map((request) => request.at);
}

describe("one host's ceiling bounds what is released inside its interval", () => {
  it("never releases more than the ceiling in any window of the configured length", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0, 0.3, 0.6, 0.9, 0.2, 0.45, 0.75, 0.1]),
      config: testConfig({
        hosts: {
          [A]: {
            maxRequests: 3,
            intervalMs: 10_000,
            minDelayMs: 500,
            jitterMs: 500,
          },
        },
      }),
    });

    for (let index = 0; index < 7; index += 1) {
      const outcome = await governor.request({
        url: `http://${A}:8080/listing/${index}`,
        sourceId: "test-source",
      });
      assert.equal(outcome.ok, true);
    }

    // Eight releases: one robots.txt and seven listings.
    const instants = releasesFor(transport.sent, A);
    assert.equal(instants.length, 8);

    for (const start of instants) {
      const inWindow = instants.filter(
        (instant) => instant >= start && instant < start + 10_000,
      );
      assert.ok(
        inWindow.length <= 3,
        `${inWindow.length} releases fell inside the 10000ms window opening at ` +
          `${start}: ${inWindow.join(", ")}`,
      );
    }
  });

  it("separates consecutive releases by at least the configured minimum delay", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0, 0.5, 0.999, 0.25, 0.75, 0.125]),
      config: testConfig({
        hosts: {
          [A]: {
            maxRequests: 100,
            intervalMs: 60_000,
            minDelayMs: 3_000,
            jitterMs: 2_000,
          },
        },
      }),
    });

    for (let index = 0; index < 5; index += 1) {
      await governor.request({
        url: `http://${A}:8080/listing/${index}`,
        sourceId: "test-source",
      });
    }

    const instants = releasesFor(transport.sent, A);
    const gaps = instants.slice(1).map((instant, index) => instant - instants[index]);

    for (const gap of gaps) {
      assert.ok(gap >= 3_000, `${gap}ms is shorter than the configured 3000ms floor`);
      assert.ok(gap <= 5_000, `${gap}ms is longer than the floor plus the jitter`);
    }
    assert.ok(
      new Set(gaps).size >= 3,
      `a constant delay is not a randomised one: ${gaps.join(", ")}`,
    );
  });

  it("draws the delay from the injected randomness, so two runs differ", async () => {
    const run = async (values: number[]): Promise<number[]> => {
      const clock = new FakeClock(0);
      const transport = recordingTransport(clock, robotsAbsent());
      const { governor } = buildGovernor({
        transport,
        clock,
        random: sequenceRandom(values),
        config: testConfig({
          hosts: {
            [A]: { maxRequests: 100, intervalMs: 60_000, minDelayMs: 1_000, jitterMs: 4_000 },
          },
        }),
      });
      for (let index = 0; index < 3; index += 1) {
        await governor.request({
          url: `http://${A}:8080/listing/${index}`,
          sourceId: "test-source",
        });
      }
      return releasesFor(transport.sent, A);
    };

    const first = await run([0.1, 0.2, 0.3, 0.4]);
    const second = await run([0.9, 0.8, 0.7, 0.6]);
    assert.notDeepEqual(first, second);
  });
});

describe("a host at its ceiling does not hold up another host", () => {
  it("releases the other host's request as soon as that host's own delay allows", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0]),
      config: testConfig({
        hosts: {
          // Three releases per minute: the robots fetch and two listings fill it.
          [A]: { maxRequests: 3, intervalMs: 60_000, minDelayMs: 100, jitterMs: 1 },
          [B]: { maxRequests: 50, intervalMs: 60_000, minDelayMs: 100, jitterMs: 1 },
        },
      }),
    });

    await governor.request({ url: `http://${A}:8080/one`, sourceId: "test-source" });
    await governor.request({ url: `http://${A}:8080/two`, sourceId: "test-source" });

    const beforeContention = clock.now();
    assert.equal(releasesFor(transport.sent, A).length, 3);

    // Host A is now at its ceiling for the next minute. Offer it another
    // request and, at the same time, offer one to a different host.
    const [blocked, other] = await Promise.all([
      governor.request({ url: `http://${A}:8080/three`, sourceId: "test-source" }),
      governor.request({ url: `http://${B}:8080/one`, sourceId: "test-source" }),
    ]);

    assert.equal(blocked.ok, true);
    assert.equal(other.ok, true);
    if (!blocked.ok || !other.ok) return;

    // B waited for its own robots fetch and its own delay - about 200ms - and
    // not for A's minute.
    assert.ok(
      other.release.at - beforeContention <= 500,
      `the other host waited ${other.release.at - beforeContention}ms, which is ` +
        "A's ceiling and not its own",
    );
    assert.ok(
      blocked.release.at - beforeContention >= 59_000,
      `the host at its ceiling was released after only ${
        blocked.release.at - beforeContention
      }ms`,
    );
    assert.ok(other.release.at < blocked.release.at);

    // Each host's releases are counted against that host alone.
    assert.equal(releasesFor(transport.sent, A).length, 4);
    assert.equal(releasesFor(transport.sent, B).length, 2);
  });

  it("keeps a host with no configured ceiling from borrowing another host's", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: testConfig({
        hosts: {
          [A]: { maxRequests: 10, intervalMs: 60_000, minDelayMs: 100, jitterMs: 1 },
        },
      }),
    });

    const outcome = await governor.request({
      url: `http://${B}:8080/one`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "unconfigured-host");
    assert.equal(transport.sent.length, 0);
  });
});
