/**
 * regress_0023_F9 - impl-gate ordinal 3, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F9 (advisory): an INTERNAL refusal raised inside the governor's own
 * robots.txt retrieval is recorded as "unreachable" and CACHED under that
 * verdict for the whole robots cache bound, even though no server error and no
 * network error occurred.
 *
 * `governor.ts`, `#retrieveRobots`:
 *
 *   if (!outcome.ok) {
 *     // Every refusal below this line leaves robots.txt undefined, and RFC
 *     // 9309 2.3.1.4 says undefined means complete disallow. Nothing is
 *     // fetched.
 *     return { kind: "unreachable", detail: outcome.detail };
 *   }
 *
 * `#send` can refuse for `allowance-exhausted` on the far side of the per-host
 * wait, so an allowance that runs out between gate 4 and the robots release
 * turns into a cached "this host is completely disallowed" that outlives the
 * allowance period that caused it.
 *
 * Direction of the error is SAFE - fewer requests, never more - which is why
 * this is filed advisory rather than blocking. It is recorded because AC7
 * scopes the unreachable fail-safe to "a server error or a network error", the
 * `## Readings taken` section records no reading extending it to the
 * governor's own refusals, and the cost is a host that stays unfetchable for
 * `robots.cacheBoundMs` (21600000 ms in the committed configuration) after the
 * condition that caused it has cleared.
 *
 * RE-POINTED by the implementer in the impl-gate-4 fix loop, on the conductor's
 * ruling of 2026-09-03 ("the implementer may retire or re-point that
 * artifact"), because F9 IS FIXED and this file was still exiting non-zero for
 * a reason that is not F9. Impl gate 4 established the reason: the probe set
 * `allowance.limit: 1`, and under a recorded reading of AC20 the governor's own
 * `robots.txt` retrieval is itself spent from the metered allowance, so that
 * single unit goes on the politeness fetch and `ok` is unreachable in ANY
 * period, fixed or not. The one thing changed below is that number, 1 to 2 - a
 * period that affords the politeness fetch AND the page - so that the closing
 * assertion measures what this file says it measures.
 *
 * It still reproduces F9. Against the code this file was written for, the
 * retrieval refused for `allowance-exhausted` is recorded as `unreachable` and
 * CACHED under it, so the request after the period rolls is refused
 * `robots-unreachable` by a six-hour-old verdict and the assertion fails on
 * exactly the finding. Retiring the file instead would have deleted that.
 *
 * This file documents the behaviour. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";

const PERIOD_MS = 3_600_000;

describe("F9: an internal refusal is cached as an unreachable robots.txt", () => {
  it("serves the host again once the allowance period rolls", async () => {
    const clock = new FakeClock();
    const config = testConfig({
      hosts: {
        // The slower host reaches its robots.txt release after the faster one
        // has already spent the single unit of allowance.
        "127.0.0.1": { maxRequests: 100, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        "127.0.0.2": {
          maxRequests: 100,
          intervalMs: 60_000,
          minDelayMs: 60_000,
          jitterMs: 1,
        },
      },
      robots: { cacheBoundMs: 21_600_000 },
      sources: {
        "test-source": {
          // Two: the period affords the governor's own politeness fetch and the
          // page behind it. At one, the politeness fetch spends the period and
          // nothing can ever be served - see the header.
          allowance: { limit: 2, periodMs: PERIOD_MS, warnFraction: 0.9 },
        },
      },
    });

    const transport = recordingTransport(clock, robotsAbsent(() => ({ status: 200 })));
    const { governor } = buildGovernor({
      transport,
      config,
      clock,
      random: sequenceRandom([0]),
    });

    const both = await Promise.all([
      governor.request({ url: "http://127.0.0.1/one", sourceId: "test-source" }),
      governor.request({ url: "http://127.0.0.2/two", sourceId: "test-source" }),
    ]);
    console.log(
      "first period:",
      both.map((outcome) => (outcome.ok ? "ok" : outcome.reason)).join(", "),
    );

    // A new allowance period. AC21: the source is served again from zero.
    await clock.advanceBy(PERIOD_MS);

    const afterRoll = await governor.request({
      url: "http://127.0.0.2/two",
      sourceId: "test-source",
    });
    console.log(
      "after the period rolled:",
      afterRoll.ok ? "ok" : `${afterRoll.reason} - ${afterRoll.detail}`,
    );

    assert.equal(
      afterRoll.ok ? "ok" : afterRoll.reason,
      "ok",
      "the host is still refused as robots-unreachable in the new period",
    );
  });
});
