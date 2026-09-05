/**
 * regress_0023_F15 - impl-gate ordinal 6, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F15: the SECOND per-host wait added by the F13 fix is itself a wait,
 * and nothing re-asks gate 5 on the far side of it. So a request can leave the
 * process under a robots decision the governor has itself already declared
 * stale - which is exactly what AC10 forbids, and exactly the defect F10 was
 * raised and reset for one gate earlier.
 *
 * Acceptance criterion violated (spec.md, verbatim):
 *
 *   AC10: WHEN a host's cached robots decision is older than the configured
 *   cache bound, which SHALL NOT be configurable above 24 hours, THE SYSTEM
 *   SHALL re-retrieve `robots.txt` before the next fetch to that host; within
 *   the bound it SHALL NOT re-retrieve it.
 *
 * Root cause, `packages/governor/src/governor.ts`, `#send`:
 *
 *     if (options.recheckRobots ?? true) {
 *       const landedBefore = this.#robots.landedRetrievals(origin);
 *       const robots = await this.#robotsGate(url, request.sourceId);   // gate 5
 *       if (robots !== null) return robots;
 *       if (landed changed || heldUntil(host) > now) {
 *         release = await this.#scheduler.release(host, ceiling);       // gate 6
 *       }
 *     }
 *     ... gates 3 and 4 ... await this.#transport.send(...)
 *
 * `HostScheduler.release` is the thing that waits out a `Retry-After` hold or a
 * 429's configured back-off, and that wait is measured in minutes or hours. When
 * the second release sleeps for longer than `robots.cacheBoundMs`, the request
 * then leaves under the decision taken before that sleep began. The governor
 * knows the decision has expired - `RobotsGate.#entryFor` would re-retrieve if
 * anything asked it again - and after the second release nothing asks it again.
 *
 * The direction of the error is a fetch this system is no longer entitled to
 * make: a host that adds a `Disallow` while it is holding us off is obeyed only
 * after the request it was trying to prevent has already left, from the
 * residential IP `cards/deal-sentinel.md` names as this repository's blast
 * radius.
 *
 * Reproduced below on the numbers `config/governor.json` actually ships
 * (`robots.cacheBoundMs` 21600000, `backPressure.defaultBackoffMs` 900000, the
 * committed `hosts["127.0.0.1"]` block) with two URLs offered for one host, and
 * again with no `Retry-After` header sent anywhere at all.
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

/** Read off config/governor.json, not invented here. */
const SHIPPED_CACHE_BOUND_MS = 21_600_000; // six hours
const SHIPPED_BACKOFF_MS = 900_000; // fifteen minutes
const SHIPPED_HOST = {
  maxRequests: 240,
  intervalMs: 60_000,
  minDelayMs: 1,
  jitterMs: 1,
};

/** Seven hours, in the delay-seconds form of RFC 9110 10.2.3. */
const SEVEN_HOURS_MS = 7 * 3_600_000;

const ALLOW_EVERYTHING = "User-agent: *\nAllow: /\n";
const DISALLOW_B = "User-agent: *\nDisallow: /b\n";

const NO_BREAKER = {
  windowMs: 600_000,
  minimumOutcomes: 1_000_000,
  failureRateThreshold: 1,
  pauseMs: 1,
};

function shippedConfig() {
  return testConfig({
    hosts: { "127.0.0.1": SHIPPED_HOST },
    robots: { cacheBoundMs: SHIPPED_CACHE_BOUND_MS },
    backPressure: { defaultBackoffMs: SHIPPED_BACKOFF_MS },
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
 * The robots decision a product request left under: the last `/robots.txt` that
 * came back before it went out. `fetchedAt` in `RobotsGate` is taken the instant
 * the retrieval resolves, and this transport answers synchronously, so these are
 * the same instant on the virtual clock.
 */
function decisionAgeAt(sent: readonly SentRequest[], request: SentRequest): number | null {
  const asked = robotsRequests(sent).filter((robots) => robots.at <= request.at);
  if (asked.length === 0) return null;
  return request.at - asked[asked.length - 1].at;
}

/**
 * A host that:
 *   - answers its first `/robots.txt` with "allow everything";
 *   - answers the first page fetch with a seven-hour hold, so the second page
 *     waits long enough for the cache bound to expire under it;
 *   - answers the SECOND `/robots.txt` - the one gate 5's re-ask goes and gets -
 *     with a 429 asking for another seven hours;
 *   - would answer any LATER `/robots.txt` with `Disallow: /b`.
 *
 * A 429 on robots.txt is a 4xx, so RFC 9309 2.3.1.3 makes it "this host carries
 * no rules" and the robots gate keeps allowing. Nothing under test here turns on
 * that: what is under test is the AGE of the decision the page fetch leaves
 * under, and whether the host's later rules were ever asked for.
 */
function hostThatHoldsThenAddsARule() {
  let robotsServed = 0;
  let pagesServed = 0;
  return {
    robotsServed: () => robotsServed,
    respond(request: { url: string }) {
      if (new URL(request.url).pathname === "/robots.txt") {
        robotsServed += 1;
        if (robotsServed === 1) return { status: 200, body: ALLOW_EVERYTHING };
        if (robotsServed === 2) {
          return {
            status: 429,
            headers: { "retry-after": String(SEVEN_HOURS_MS / 1000) },
            body: "still busy, come back in seven hours",
          };
        }
        return { status: 200, body: DISALLOW_B };
      }
      pagesServed += 1;
      if (pagesServed === 1) {
        return {
          status: 503,
          headers: { "retry-after": String(SEVEN_HOURS_MS / 1000) },
          body: "",
        };
      }
      return { status: 200, body: "a price would be here" };
    },
  };
}

describe("F15: the second per-host wait outlives the robots decision it waits under", () => {
  it("re-retrieves robots.txt before a fetch that leaves past the cache bound (AC10)", async () => {
    const clock = new FakeClock();
    const host = hostThatHoldsThenAddsARule();
    const transport = recordingTransport(clock, (request) => host.respond(request));
    const { governor } = buildGovernor({
      transport,
      config: shippedConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    // Two URLs for one host, offered together, as an adapter with a page list
    // would offer them.
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

    const left = productRequests(transport.sent);
    const stale = left.filter((request) => {
      const age = decisionAgeAt(transport.sent, request);
      return age !== null && age > SHIPPED_CACHE_BOUND_MS;
    });

    console.log(
      "[stale after the hold] every request that left 127.0.0.1:",
      report(transport.sent),
      `; robots.cacheBoundMs ${SHIPPED_CACHE_BOUND_MS}; ages at the wire:`,
      left.map(
        (request) =>
          `${new URL(request.url).pathname}=${decisionAgeAt(transport.sent, request)}ms`,
      ),
    );

    assert.deepEqual(
      stale.map(
        (request) =>
          `${new URL(request.url).pathname}@${request.at} under a decision ` +
          `${decisionAgeAt(transport.sent, request)}ms old`,
      ),
      [],
      `${stale.length} request(s) left for 127.0.0.1 under a robots decision ` +
        `older than the configured cache bound of ${SHIPPED_CACHE_BOUND_MS}ms, ` +
        "without robots.txt being re-retrieved first",
    );
  });

  it("asks the host for its rules again before fetching the path it has since disallowed (AC10)", async () => {
    const clock = new FakeClock();
    const host = hostThatHoldsThenAddsARule();
    const transport = recordingTransport(clock, (request) => host.respond(request));
    const { governor } = buildGovernor({
      transport,
      config: shippedConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    // The stub's third and later answers carry `Disallow: /b`. The governor
    // never asks for them, so /b leaves anyway - seven hours after the decision
    // that permitted it expired.
    const b = productRequests(transport.sent).find(
      (request) => new URL(request.url).pathname === "/b",
    );

    console.log(
      "[unasked rule] robots.txt retrievals:",
      host.robotsServed(),
      "; the host would have answered `Disallow: /b` from retrieval 3 onward; " +
        "requests that left:",
      report(transport.sent),
    );

    assert.equal(
      b === undefined || (decisionAgeAt(transport.sent, b) ?? 0) <= SHIPPED_CACHE_BOUND_MS,
      true,
      "/b left for 127.0.0.1 under a robots decision the governor had already " +
        `declared stale (${decisionAgeAt(transport.sent, b as SentRequest)}ms old ` +
        `against a bound of ${SHIPPED_CACHE_BOUND_MS}ms), and the host's current ` +
        "robots.txt - which it was never asked for - disallows that path",
    );
  });

  it("no Retry-After anywhere: a bare 429 reaches it when the back-off outlasts the bound (AC10)", async () => {
    // Nothing exotic in this case. No `Retry-After` header is sent at all, so
    // every hold below is `backPressure.defaultBackoffMs` straight off
    // `config/governor.json` (900000ms). The only value moved is
    // `robots.cacheBoundMs`, set to ten minutes - far under RFC 9309 2.4's
    // twenty-four hours and under the shipped six, which is the direction
    // `config/governor.json`'s own comment recommends ("Six hours is chosen
    // below the ceiling so a host that ADDS a disallow rule is obeyed sooner").
    // Any configuration whose back-off outlasts its cache bound reaches this on
    // a bare 429.
    const shortBoundMs = 600_000;

    const clock = new FakeClock();
    let robotsServed = 0;
    let pagesServed = 0;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname === "/robots.txt") {
        robotsServed += 1;
        if (robotsServed === 1) return { status: 200, body: ALLOW_EVERYTHING };
        if (robotsServed === 2) return { status: 429, body: "slow down" };
        return { status: 200, body: DISALLOW_B };
      }
      pagesServed += 1;
      if (pagesServed === 1) return { status: 429, body: "slow down" };
      return { status: 200, body: "a price would be here" };
    });
    const { governor } = buildGovernor({
      transport,
      config: testConfig({
        hosts: { "127.0.0.1": SHIPPED_HOST },
        robots: { cacheBoundMs: shortBoundMs },
        backPressure: { defaultBackoffMs: SHIPPED_BACKOFF_MS },
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

    const left = productRequests(transport.sent);
    const stale = left.filter((request) => {
      const age = decisionAgeAt(transport.sent, request);
      return age !== null && age > shortBoundMs;
    });

    console.log(
      "[bare 429] every request that left 127.0.0.1:",
      report(transport.sent),
      `; robots.cacheBoundMs ${shortBoundMs}, defaultBackoffMs ` +
        `${SHIPPED_BACKOFF_MS}, no Retry-After header sent anywhere; ages at ` +
        "the wire:",
      left.map(
        (request) =>
          `${new URL(request.url).pathname}=${decisionAgeAt(transport.sent, request)}ms`,
      ),
    );

    assert.deepEqual(
      stale.map(
        (request) =>
          `${new URL(request.url).pathname}@${request.at} under a decision ` +
          `${decisionAgeAt(transport.sent, request)}ms old`,
      ),
      [],
      `${stale.length} request(s) left for 127.0.0.1 under a robots decision ` +
        `older than the configured cache bound of ${shortBoundMs}ms, with no ` +
        "Retry-After header involved anywhere",
    );
  });

  it("control: with no hold at all the same two URLs leave under a fresh decision", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname === "/robots.txt") {
        return { status: 200, body: ALLOW_EVERYTHING };
      }
      return { status: 200, body: "a price would be here" };
    });
    const { governor } = buildGovernor({
      transport,
      config: shippedConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const stale = productRequests(transport.sent).filter((request) => {
      const age = decisionAgeAt(transport.sent, request);
      return age !== null && age > SHIPPED_CACHE_BOUND_MS;
    });

    assert.deepEqual(
      report(stale),
      [],
      "the control itself is broken: with no back-pressure anywhere, a request " +
        "still left under an expired robots decision",
    );
  });
});
