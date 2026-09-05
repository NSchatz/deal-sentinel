/**
 * regress_0023_F8 - impl-gate ordinal 3, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F8: once the breaker has paused a source, requests for that source
 * that were already waiting at the per-host politeness gate still LEAVE THE
 * PROCESS, one every `minDelayMs`, for as long as the queue holds them.
 *
 * Acceptance criterion 16 (spec.md):
 *
 *   WHEN a source's error-or-block rate over its configured window crosses its
 *   configured threshold THE SYSTEM SHALL refuse further requests for that
 *   source until its configured pause interval has elapsed, and SHALL continue
 *   to serve every other source at that other source's own ceiling.
 *
 * Spine assertion 4 of the same spec: "THE SYSTEM SHALL pause that source".
 *
 * The boundary the spec uses everywhere else is the process boundary, not the
 * call boundary: AC1 says the ceiling and the delay are applied "before that
 * request leaves the process", and AC20 counts a metered request "WHEN a
 * request for a metered source leaves the process". Under that same boundary a
 * request that leaves the process while its source is paused is a request the
 * governor did not refuse.
 *
 * Root cause, `packages/governor/src/governor.ts`. `request()` consults the
 * breaker at gate 3, BEFORE the per-host wait, and `#send` - which runs on the
 * far side of that wait - never consults it again. The same method re-asks the
 * allowance in exactly that position, and says why:
 *
 *   // Asked again on the far side of the wait: a request that queued behind
 *   // the ceiling for an hour must not spend an allowance the period has
 *   // meanwhile used up.
 *   const allowance = await this.#allowance.check(request.sourceId);
 *
 * The breaker gets no such second look, so the reasoning that produced that
 * comment stops one gate short.
 *
 * Why it is not a corner case. The governor is built for concurrent offers -
 * the scheduler keeps a per-host queue whose whole job is to serialise them,
 * the robots gate de-duplicates in-flight retrievals, and the durable
 * allowance store is written for "two racing workers". An adapter that offers
 * a page list for one source is the mainline use, and the shipped
 * configuration pauses for 3600000 ms, so every request already in that queue
 * keeps going to a source the governor has declared paused.
 *
 * `## Readings taken` for this spec records no reading on this fork.
 *
 * This file documents the defect. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGovernor,
  productRequests,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";

function probeConfig() {
  return testConfig({
    hosts: {
      "127.0.0.1": {
        maxRequests: 100,
        intervalMs: 60_000,
        minDelayMs: 60_000,
        jitterMs: 1,
      },
    },
    breaker: {
      windowMs: 6_000_000,
      minimumOutcomes: 2,
      failureRateThreshold: 0.5,
      pauseMs: 3_600_000,
    },
    sources: { "test-source": {} },
  });
}

describe("F8: the breaker pauses a source, and the queue keeps sending anyway", () => {
  it("releases no further request for a source paused while its requests waited", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(
      clock,
      robotsAbsent(() => ({ status: 500 })),
    );
    const { governor, notifier } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    // Six URLs for one source, offered together, exactly as an adapter with a
    // page list would. The host ceiling serialises them one per minDelayMs.
    const offered = ["/a", "/b", "/c", "/d", "/e", "/f"].map((path) =>
      governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
    );
    await Promise.all(offered);

    const pause = notifier.of("breaker-paused")[0];
    assert.notEqual(pause, undefined, "the breaker never paused: the probe is not set up");

    const pausedAt = pause.at.getTime();
    const left = productRequests(transport.sent);
    const afterPause = left.filter((request) => request.at > pausedAt);

    console.log(
      `breaker paused the source at ${pausedAt}; requests that left afterwards:`,
      afterPause.map((request) => `${request.url}@${request.at}`),
    );

    assert.deepEqual(
      afterPause.map((request) => request.url),
      [],
      `${afterPause.length} request(s) for "test-source" left the process after ` +
        "its breaker paused it",
    );
  });

  it("control: a request OFFERED after the pause is refused, so the gate itself works", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(
      clock,
      robotsAbsent(() => ({ status: 500 })),
    );
    const { governor, notifier } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    // Sequential, so the breaker has tripped before the next offer is made.
    await governor.request({ url: "http://127.0.0.1/a", sourceId: "test-source" });
    await governor.request({ url: "http://127.0.0.1/b", sourceId: "test-source" });
    assert.equal(notifier.of("breaker-paused").length, 1);

    const sentBefore = productRequests(transport.sent).length;
    const refused = await governor.request({
      url: "http://127.0.0.1/c",
      sourceId: "test-source",
    });

    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? refused.reason : "", "source-paused");
    assert.equal(
      productRequests(transport.sent).length,
      sentBefore,
      "the sequential path is correct: nothing left for a paused source",
    );
  });
});
