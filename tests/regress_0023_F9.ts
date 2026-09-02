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
          allowance: { limit: 1, periodMs: PERIOD_MS, warnFraction: 0.9 },
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
