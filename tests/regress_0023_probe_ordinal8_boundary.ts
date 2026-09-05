/**
 * regress_0023_probe_ordinal8_boundary - impl-gate ordinal 8, spec
 * S0023-deal-sentinel-governor-2. Written by the refuter.
 *
 * A PROBE, not a finding. The conductor's ruling of 2026-09-05 sets a kill
 * condition on this item: "If ordinal 8 refutes on ANY check-then-act finding -
 * a gate gone stale across a wait, or two requests racing shared state - I KILL
 * this item." Ordinals 3, 4, 5 and 6 all refuted on the first shape and ordinal
 * 7 on the second, and commit `1c2d348` re-ordered the boundary in `#send` to
 * close the second: the allowance is now SPENT immediately before the wire
 * rather than read earlier. That re-ordering moved the store round trip, which
 * is the widest gap in the whole method, to a NEW place - so the question this
 * file asks is whether the FIRST shape has been reopened inside it.
 *
 * Two gates are re-asked on the far side of that reservation, synchronously,
 * and the module header claims both. This file makes each of them go stale
 * ON PURPOSE, inside the reservation itself, by arming a store whose `reserve`
 * runs a hook before it answers:
 *
 *   E - a `Retry-After` hold arrives for this host while the reservation is in
 *       flight (gate 6). AC12/AC14: no further request to that host until the
 *       interval has elapsed.
 *   F - the host's cached robots decision ages past `robots.cacheBoundMs` while
 *       the reservation is in flight (gate 5). AC10: re-retrieve before the
 *       next fetch to that host.
 *
 * Nothing here leaves the process: the transport is a recording stub and the
 * clock is virtual (AC23).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryAllowanceStore } from "@deal-sentinel/governor";
import type { AllowanceStore, TransportRequest } from "@deal-sentinel/governor";

import {
  buildGovernor,
  recordingTransport,
  testConfig,
} from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";

const PERIOD_MS = 3_600_000;

/**
 * A memory store whose `reserve` runs a hook AFTER taking the unit and BEFORE
 * answering - which is the inside of the reservation round trip, the one place
 * `#send` has to wait between certifying its gates and reaching the wire.
 */
function armableStore(): { store: AllowanceStore; arm(during: () => Promise<void>): void } {
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
        const hook = armed;
        armed = null;
        if (hook !== null) await hook();
        return granted;
      },
    },
  };
}

const HOST = "127.0.0.1";

function sentFor(sent: readonly (TransportRequest & { at: number })[], path: string) {
  return sent.filter((request) => new URL(request.url).pathname === path);
}

describe("probe E: a Retry-After hold lands INSIDE the allowance reservation", () => {
  it("AC12/AC14: the request does not leave before the hold the host asked for", async () => {
    const clock = new FakeClock(0);
    const armable = armableStore();
    const RETRY_AFTER_SECONDS = 60;

    const transport = recordingTransport(clock, (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/robots.txt") return { status: 404 };
      if (path === "/throttle") {
        return { status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDS) } };
      }
      return { status: 200 };
    });

    const { governor, allowanceStore } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0]),
      allowanceStore: armable.store,
      config: testConfig({
        hosts: { [HOST]: { maxRequests: 10_000, intervalMs: 60_000, minDelayMs: 10, jitterMs: 1 } },
        robots: { cacheBoundMs: PERIOD_MS },
        backPressure: { defaultBackoffMs: 1 },
        breaker: { windowMs: 600_000, minimumOutcomes: 1_000_000, failureRateThreshold: 1, pauseMs: 1 },
        sources: { metered: { allowance: { limit: 50, periodMs: PERIOD_MS, warnFraction: 0.99 } } },
      }),
    });

    // Warm the robots cache so the armed reservation is the product request's
    // own and not its /robots.txt retrieval's.
    const warm = await governor.request({ url: `http://${HOST}/warm`, sourceId: "metered" });
    assert.equal(warm.ok, true);

    // While the target's unit is being taken, another request to this same host
    // is answered 429 with a Retry-After of a minute. Gate 6's answer - "this
    // host is under no hold" - was true when the release was granted and is
    // false by the time the reservation comes back.
    armable.arm(async () => {
      await governor.request({ url: `http://${HOST}/throttle`, sourceId: "metered" });
    });

    const target = await governor.request({ url: `http://${HOST}/target`, sourceId: "metered" });

    const throttled = sentFor(transport.sent, "/throttle");
    const targets = sentFor(transport.sent, "/target");
    console.log(
      "[E1] 429 received at", throttled.map((request) => request.at),
      "; hold asked for", RETRY_AFTER_SECONDS * 1000, "ms",
      "; /target left at", targets.map((request) => request.at),
      "; outcome", target.ok ? "ok" : target.reason,
      "; counter", (await allowanceStore.read("metered", new Date(0))).consumed,
    );

    assert.equal(throttled.length, 1, "the hook's 429 never reached the transport");
    const heldFrom = throttled[0].at;
    for (const request of targets) {
      assert.equal(
        request.at >= heldFrom + RETRY_AFTER_SECONDS * 1000,
        true,
        `/target left at ${request.at}, which is inside the hold the host asked ` +
          `for at ${heldFrom} (${RETRY_AFTER_SECONDS}s). A hold that arrived ` +
          "while the allowance reservation was in flight was not re-asked before " +
          "the wire.",
      );
    }
  });
});

describe("probe F: the robots decision expires INSIDE the allowance reservation", () => {
  it("AC10: nothing leaves under a decision older than the configured bound", async () => {
    const CACHE_BOUND_MS = 50_000;
    const clock = new FakeClock(0);
    const armable = armableStore();

    const transport = recordingTransport(clock, (request) => {
      const path = new URL(request.url).pathname;
      return path === "/robots.txt" ? { status: 404 } : { status: 200 };
    });

    const { governor } = buildGovernor({
      transport,
      clock,
      random: sequenceRandom([0]),
      allowanceStore: armable.store,
      config: testConfig({
        hosts: { [HOST]: { maxRequests: 10_000, intervalMs: 60_000, minDelayMs: 10, jitterMs: 1 } },
        robots: { cacheBoundMs: CACHE_BOUND_MS },
        backPressure: { defaultBackoffMs: 1 },
        breaker: { windowMs: 600_000, minimumOutcomes: 1_000_000, failureRateThreshold: 1, pauseMs: 1 },
        sources: { metered: { allowance: { limit: 50, periodMs: PERIOD_MS, warnFraction: 0.99 } } },
      }),
    });

    const warm = await governor.request({ url: `http://${HOST}/warm`, sourceId: "metered" });
    assert.equal(warm.ok, true);

    // The decision was fresh when gate 5 was asked and when gate 6 granted the
    // release. It expires while the unit is being taken.
    armable.arm(async () => {
      await clock.advanceBy(CACHE_BOUND_MS + 5_000);
    });

    const target = await governor.request({ url: `http://${HOST}/target`, sourceId: "metered" });

    const retrievals = sentFor(transport.sent, "/robots.txt");
    const targets = sentFor(transport.sent, "/target");
    console.log(
      "[F1] cacheBoundMs", CACHE_BOUND_MS,
      "; robots retrieved at", retrievals.map((request) => request.at),
      "; /target left at", targets.map((request) => request.at),
      "; outcome", target.ok ? "ok" : target.reason,
    );

    for (const request of targets) {
      const decidedAt = retrievals
        .map((retrieval) => retrieval.at)
        .filter((at) => at <= request.at)
        .pop();
      assert.notEqual(decidedAt, undefined, "/target left with no robots decision behind it");
      assert.equal(
        request.at - (decidedAt as number) < CACHE_BOUND_MS,
        true,
        `/target left at ${request.at} under a robots decision taken at ` +
          `${decidedAt}, which is ${request.at - (decidedAt as number)}ms old ` +
          `against a configured bound of ${CACHE_BOUND_MS}ms. The decision ` +
          "expired while the allowance reservation was in flight and was not " +
          "re-asked before the wire.",
      );
    }
    // Either it refused, or it re-retrieved and left fresh. Both discharge AC10;
    // what is forbidden is leaving under the expired one.
    assert.equal(
      target.ok === false || retrievals.length >= 2,
      true,
      "the request left without either refusing or re-retrieving robots.txt",
    );
  });
});
