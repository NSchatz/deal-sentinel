/**
 * regress_0023_F13 - impl-gate ordinal 5, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F13: the per-host wait (gate 6) is taken BEFORE the gate 5 re-ask
 * that impl gate 4 added, and that re-ask can itself put a request on the wire.
 * When it does, whatever that robots.txt fetch learns about the host - a 429, a
 * `Retry-After` - is placed on a scheduler the waiting request has already
 * cleared, so the request leaves the process in the SAME instant, ignoring the
 * hold, and with none of the configured minimum delay separating it from the
 * fetch that just earned that hold.
 *
 * Acceptance criteria violated (spec.md, verbatim):
 *
 *   AC14: WHEN a host answers 429 with no `Retry-After` THE SYSTEM SHALL hold
 *   that host for at least its configured back-off interval before the next
 *   request to it.
 *
 *   AC12: WHEN a response from a host carries `Retry-After` in the
 *   `delay-seconds` form THE SYSTEM SHALL issue no further request to that host
 *   until at least that many seconds have elapsed.
 *
 *   AC1: WHEN any code path in this repo issues an outbound HTTP request THE
 *   SYSTEM SHALL apply the destination host's configured request ceiling and a
 *   randomised delay before that request leaves the process.
 *
 * Root cause, `packages/governor/src/governor.ts`, `#send`:
 *
 *     const release = await this.#scheduler.release(host, ceiling);   // line 300
 *     ...
 *     if (options.recheckRobots ?? true) {                            // line 323
 *       const robots = await this.#robotsGate(url, request.sourceId);
 *       if (robots !== null) return robots;
 *     }
 *
 * `#robotsGate` calls `RobotsGate.decide`, which on an expired or absent cache
 * entry calls `#retrieveRobots`, which is itself a `#send` to the SAME host. So
 * between the release on line 300 and the transport call on line 344 this
 * method can spend an unbounded amount of time and can receive back-pressure
 * for this very host - and `#applyBackPressure` writes that hold into
 * `HostScheduler`, which this request is no longer consulting. `release` is the
 * only thing that reads `holdUntil`, and it has already returned.
 *
 * This is the SAME class the conductor's ruling of 2026-09-03 scoped this fix
 * loop to close - a decision about a moment, consumed on the far side of a
 * moment that has passed - one gate further along again. Impl gate 3 moved
 * gates 3 and 4 past the wait; impl gate 4 moved gate 5 past it as well. Moving
 * gate 5 past the wait is what created this: gate 5 is the only re-asked gate
 * that can SEND, and it now sends after gate 6's answer has been taken.
 *
 * Direction of the error is MORE requests, against a host that has just asked
 * in the plainest terms available to HTTP for fewer, from the residential IP
 * `cards/deal-sentinel.md` names as this repository's blast radius.
 *
 * This file documents the behaviour. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGovernor,
  productRequests,
  recordingTransport,
  testConfig,
} from "../test/support/governor-harness.ts";
import type { SentRequest } from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";

const BACKOFF_MS = 900_000;
const MIN_DELAY_MS = 5_000;
/** Short enough that a queued request outlives it, which is F10's own shape. */
const CACHE_BOUND_MS = 2_000;

const ALLOW_EVERYTHING = "User-agent: *\nAllow: /\n";

const NO_BREAKER = {
  windowMs: 600_000,
  minimumOutcomes: 1_000_000,
  failureRateThreshold: 1,
  pauseMs: 1,
};

function probeConfig() {
  return testConfig({
    hosts: {
      "127.0.0.1": {
        maxRequests: 1_000,
        intervalMs: 60_000,
        minDelayMs: MIN_DELAY_MS,
        jitterMs: 0,
      },
    },
    robots: { cacheBoundMs: CACHE_BOUND_MS },
    backPressure: { defaultBackoffMs: BACKOFF_MS },
    breaker: NO_BREAKER,
    sources: { "test-source": {} },
  });
}

function robotsRequests(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter((request) => new URL(request.url).pathname === "/robots.txt");
}

function report(sent: readonly SentRequest[]): string[] {
  return sent.map((request) => `${new URL(request.url).pathname}@${request.at}`);
}

/**
 * A host that allows everything, and whose SECOND answer for `/robots.txt` is a
 * 429 with no `Retry-After` - the plainest form of "stop" HTTP has, and the one
 * AC14 names. A 4xx on robots.txt is "this host carries no rules" (RFC 9309
 * 2.3.1.3), so the robots gate goes on allowing the fetch: the only thing under
 * test here is whether the BACK-PRESSURE that answer carries is honoured.
 */
function hostThatSaysStopOnItsSecondRobots(): (request: { url: string }) => {
  status: number;
  headers?: Record<string, string>;
  body: string;
} {
  let robotsServed = 0;
  return (request) => {
    if (new URL(request.url).pathname !== "/robots.txt") {
      return { status: 200, body: "a price would be here" };
    }
    robotsServed += 1;
    if (robotsServed >= 2) return { status: 429, body: "slow down" };
    return { status: 200, body: ALLOW_EVERYTHING };
  };
}

describe("F13: a 429 earned by the re-asked robots gate does not hold the host", () => {
  it("issues no request to a host inside the back-off it just earned (AC14)", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, hostThatSaysStopOnItsSecondRobots());
    const { governor } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    // Two URLs for one host, offered together, as an adapter with a page list
    // would. The second waits behind the first, and outlives the robots cache
    // bound while it waits, so its gate 5 re-ask retrieves `/robots.txt` again
    // on the far side of its own release - and that retrieval is what the host
    // answers 429 to.
    const outcomes = await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const refusedFor = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));
    assert.deepEqual(
      refusedFor,
      [],
      "the probe is not set up: something refused these before the send",
    );

    const asked = robotsRequests(transport.sent);
    const stopped = asked.find((request) => request.at !== asked[0].at);
    assert.notEqual(
      stopped,
      undefined,
      "the probe is not set up: robots.txt was only retrieved once, so the " +
        "host never got the chance to answer 429",
    );
    const stoppedAt = (stopped as SentRequest).at;

    const left = productRequests(transport.sent);
    const insideBackoff = left.filter(
      (request) => request.at >= stoppedAt && request.at < stoppedAt + BACKOFF_MS,
    );

    console.log(
      `[429 on the re-asked robots] robots.txt retrieved ${asked.length} time(s) ` +
        `at ${asked.map((request) => request.at).join(", ")}; the 429 arrived at ` +
        `${stoppedAt}; configured back-off ${BACKOFF_MS}ms; requests that left:`,
      report(left),
    );

    assert.deepEqual(
      report(insideBackoff),
      [],
      `${insideBackoff.length} request(s) left for 127.0.0.1 at or after ` +
        `${stoppedAt}, when that host answered 429 with no Retry-After, and ` +
        `before the configured back-off of ${BACKOFF_MS}ms had elapsed`,
    );
  });

  it("respects a Retry-After the re-asked robots gate earned (AC12)", async () => {
    const clock = new FakeClock();
    let robotsServed = 0;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname !== "/robots.txt") {
        return { status: 200, body: "a price would be here" };
      }
      robotsServed += 1;
      if (robotsServed >= 2) {
        // delay-seconds form, RFC 9110 10.2.3. Two hours.
        return { status: 429, headers: { "retry-after": "7200" }, body: "" };
      }
      return { status: 200, body: ALLOW_EVERYTHING };
    });
    const { governor } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const asked = robotsRequests(transport.sent);
    const stopped = asked.find((request) => request.at !== asked[0].at);
    assert.notEqual(stopped, undefined, "the probe is not set up: one retrieval only");
    const stoppedAt = (stopped as SentRequest).at;

    const left = productRequests(transport.sent);
    const insideHold = left.filter(
      (request) => request.at >= stoppedAt && request.at < stoppedAt + 7_200_000,
    );

    console.log(
      "[Retry-After on the re-asked robots] the header asked for 7200s at " +
        `${stoppedAt}; requests that left:`,
      report(left),
    );

    assert.deepEqual(
      report(insideHold),
      [],
      `${insideHold.length} request(s) left for 127.0.0.1 inside the 7200s ` +
        `Retry-After that host asked for at ${stoppedAt}`,
    );
  });

  it("leaves the configured minimum delay between the robots fetch and the page (AC1, AC3)", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, hostThatSaysStopOnItsSecondRobots());
    const { governor } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const instants = transport.sent.map((request) => request.at);
    const tooClose: string[] = [];
    for (let index = 1; index < instants.length; index += 1) {
      const gap = instants[index] - instants[index - 1];
      if (gap < MIN_DELAY_MS) {
        tooClose.push(
          `${new URL(transport.sent[index - 1].url).pathname}@${instants[index - 1]} -> ` +
            `${new URL(transport.sent[index].url).pathname}@${instants[index]} (${gap}ms)`,
        );
      }
    }

    console.log(
      `[spacing] every request that left 127.0.0.1, minDelayMs ${MIN_DELAY_MS}:`,
      report(transport.sent),
    );

    assert.deepEqual(
      tooClose,
      [],
      `${tooClose.length} consecutive pair(s) of requests left for 127.0.0.1 ` +
        `closer together than the configured minimum delay of ${MIN_DELAY_MS}ms`,
    );
  });

  it("the same finding on the numbers config/governor.json actually ships", async () => {
    // Nothing invented here. Every number below is read off the committed
    // default file, so the finding does not rest on a config a test made up:
    //   hosts["127.0.0.1"] = { maxRequests 240, intervalMs 60000,
    //                          minDelayMs 1, jitterMs 1 }
    //   robots.cacheBoundMs             21600000  (six hours)
    //   backPressure.defaultBackoffMs     900000  (fifteen minutes)
    // The trigger is the one the conductor's ruling of 2026-09-03 already
    // accepted as realistic for F10: "one Retry-After seven hours out against
    // the shipped six-hour bound".
    const shippedCacheBoundMs = 21_600_000;
    const shippedBackoffMs = 900_000;

    const clock = new FakeClock();
    let robotsServed = 0;
    let heldAlready = false;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname === "/robots.txt") {
        robotsServed += 1;
        // The host is still under load when the governor comes back for its
        // rules six hours later, and says so the only way HTTP has.
        if (robotsServed >= 2) return { status: 429, body: "slow down" };
        return { status: 200, body: ALLOW_EVERYTHING };
      }
      if (heldAlready) return { status: 200, body: "a price would be here" };
      heldAlready = true;
      // Seven hours, in the HTTP-date form, on the first page fetch.
      return {
        status: 503,
        headers: { "retry-after": new Date(clock.now() + 7 * 3_600_000).toUTCString() },
        body: "",
      };
    });
    const { governor } = buildGovernor({
      transport,
      config: testConfig({
        hosts: {
          "127.0.0.1": {
            maxRequests: 240,
            intervalMs: 60_000,
            minDelayMs: 1,
            jitterMs: 1,
          },
        },
        robots: { cacheBoundMs: shippedCacheBoundMs },
        backPressure: { defaultBackoffMs: shippedBackoffMs },
        breaker: NO_BREAKER,
        sources: { "test-source": {} },
      }),
      clock,
      random: sequenceRandom([0]),
    });

    await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const asked = robotsRequests(transport.sent);
    const stopped = asked.find((request) => request.at !== asked[0].at);
    assert.notEqual(
      stopped,
      undefined,
      "the probe is not set up: robots.txt was retrieved once only",
    );
    const stoppedAt = (stopped as SentRequest).at;

    const left = productRequests(transport.sent);
    const insideBackoff = left.filter(
      (request) => request.at >= stoppedAt && request.at < stoppedAt + shippedBackoffMs,
    );

    console.log(
      "[shipped config] every request that left 127.0.0.1:",
      report(transport.sent),
      `; the 429 arrived at ${stoppedAt}, back-off ${shippedBackoffMs}ms`,
    );

    assert.deepEqual(
      report(insideBackoff),
      [],
      `${insideBackoff.length} request(s) left for 127.0.0.1 inside the ` +
        `${shippedBackoffMs}ms back-off that host earned at ${stoppedAt}, on ` +
        "the numbers config/governor.json ships",
    );
  });

  it("control: a 429 the host answers to a PRODUCT fetch does hold it, so the gate works", async () => {
    const clock = new FakeClock();
    let productServed = 0;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname === "/robots.txt") {
        return { status: 200, body: ALLOW_EVERYTHING };
      }
      productServed += 1;
      if (productServed === 1) return { status: 429, body: "slow down" };
      return { status: 200, body: "a price would be here" };
    });
    const { governor } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    const first = await governor.request({
      url: "http://127.0.0.1/a",
      sourceId: "test-source",
    });
    assert.equal(first.ok, true);

    const second = await governor.request({
      url: "http://127.0.0.1/b",
      sourceId: "test-source",
    });
    assert.equal(second.ok, true);

    const left = productRequests(transport.sent);
    assert.equal(left.length, 2, "the control did not send two product requests");
    assert.equal(
      left[1].at - left[0].at >= BACKOFF_MS,
      true,
      "the back-pressure mechanism itself is broken, not just its boundary: " +
        `the second product request left ${left[1].at - left[0].at}ms after a ` +
        `429, inside the configured back-off of ${BACKOFF_MS}ms`,
    );
  });
});
