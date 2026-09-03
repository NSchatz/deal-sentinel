/**
 * regress_0023_F10 - impl-gate ordinal 4, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F10: the robots decision is taken at the CALL boundary and never
 * re-asked at the PROCESS boundary, so a request that queued behind the host's
 * ceiling, or behind a back-pressure hold, leaves the process under a cached
 * robots decision older than the configured cache bound, with no re-retrieval.
 *
 * Acceptance criterion 10 (spec.md):
 *
 *   WHEN a host's cached robots decision is older than the configured cache
 *   bound, which SHALL NOT be configurable above 24 hours, THE SYSTEM SHALL
 *   re-retrieve `robots.txt` before the next fetch to that host; within the
 *   bound it SHALL NOT re-retrieve it.
 *
 * RFC 9309 2.4, quoted by `packages/governor/src/robots.ts` itself: "Crawlers
 * SHOULD NOT use the cached version for more than 24 hours". The bound is the
 * whole point of the criterion, and it is measured against the moment a fetch
 * happens, not against the moment somebody asked for one.
 *
 * Root cause, `packages/governor/src/governor.ts`. `request()` consults the
 * robots gate at gate 5, BEFORE the per-host wait, and `#send` - which runs on
 * the far side of that wait - re-asks gate 3 (the breaker) and gate 4 (the
 * allowance) and nothing else. The comment above those two re-asks states the
 * rule that gate 5 is then exempted from:
 *
 *   // Gates 3 and 4 are asked AGAIN here ... because the wait above is
 *   // unbounded: it can be the whole ceiling interval, and the per-host queue
 *   // serialises every concurrent offer behind it. A decision taken before
 *   // that wait is a decision about a moment that has passed.
 *
 * A cached robots decision is exactly such a decision about a moment: the
 * configured bound is the governor's own statement of how long it stays true.
 *
 * This is the shape impl gate 3 found for the breaker (F8), left standing for
 * the one gate whose bound a standard fixes. Direction of the error is MORE
 * requests: the host may have added a `disallow` that this process has decided
 * it does not have to look at yet, and the requests go out from the household's
 * residential IP that `cards/deal-sentinel.md` names as the blast radius.
 *
 * Reachability is not exotic, and the second case below uses the SHIPPED cache
 * bound (`config/governor.json`, `robots.cacheBoundMs` 21600000) rather than a
 * small test number: one `Retry-After` in the HTTP-date form naming an instant
 * further out than the bound puts every queued request behind a hold that
 * outlives the decision they were admitted under. A slow per-host ceiling with
 * a queue of offers, the first case, is the other way in and is what SOURCE-3
 * will configure for a real host.
 *
 * `## Readings taken` for this spec records no reading on this fork. Reading 25
 * settles the same question for the breaker and names the boundary it settles
 * it at ("before that request leaves the process"); gate 5 is not mentioned.
 *
 * This file documents the defect. Fixing it is the implementer's job.
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

/** Two minutes. Far below the 24-hour ceiling, so the configuration is legal. */
const CACHE_BOUND_MS = 120_000;
/** One release per minute to this host, so five offers span five minutes. */
const MIN_DELAY_MS = 60_000;
/** The bound `config/governor.json` actually ships: six hours. */
const SHIPPED_CACHE_BOUND_MS = 21_600_000;

const ALLOW_EVERYTHING = "User-agent: *\nDisallow:\n";
const DISALLOW_EVERYTHING = "User-agent: *\nDisallow: /\n";

/** High enough that the breaker never trips: this probe is about gate 5. */
const NO_BREAKER = {
  windowMs: 6_000_000,
  minimumOutcomes: 10_000,
  failureRateThreshold: 0.5,
  pauseMs: 3_600_000,
};

function queueConfig() {
  return testConfig({
    hosts: {
      "127.0.0.1": {
        maxRequests: 100,
        intervalMs: 60_000,
        minDelayMs: MIN_DELAY_MS,
        jitterMs: 1,
      },
    },
    robots: { cacheBoundMs: CACHE_BOUND_MS },
    breaker: NO_BREAKER,
    sources: { "test-source": {} },
  });
}

function holdConfig() {
  return testConfig({
    // The shipped loopback ceiling: 240 a minute, one millisecond apart.
    hosts: {
      "127.0.0.1": {
        maxRequests: 240,
        intervalMs: 60_000,
        minDelayMs: 1,
        jitterMs: 1,
      },
    },
    robots: { cacheBoundMs: SHIPPED_CACHE_BOUND_MS },
    backPressure: { defaultBackoffMs: 900_000 },
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
 * A host that starts by allowing everything and then, from its second answer
 * onwards, disallows everything. The change is only ever visible to a governor
 * that goes back and asks.
 */
function changingHost(): (request: { url: string }) => {
  status: number;
  body: string;
} {
  let served = 0;
  return (request) => {
    if (new URL(request.url).pathname !== "/robots.txt") {
      return { status: 200, body: "a price would be here" };
    }
    served += 1;
    return {
      status: 200,
      body: served === 1 ? ALLOW_EVERYTHING : DISALLOW_EVERYTHING,
    };
  };
}

describe("F10: a queued request leaves under an expired robots decision", () => {
  it("re-retrieves robots.txt before a fetch that outlived the cache bound", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, changingHost());
    const { governor } = buildGovernor({
      transport,
      config: queueConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    // Five URLs for one host, offered together, exactly as an adapter with a
    // page list would. Each decides robots at ~t0 and then waits its turn.
    const outcomes = await Promise.all(
      ["/a", "/b", "/c", "/d", "/e"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );
    assert.equal(
      outcomes.every((outcome) => outcome.ok),
      true,
      "the probe is not set up: something other than robots refused these",
    );

    const asked = robotsRequests(transport.sent);
    assert.equal(asked.length >= 1, true, "robots.txt was never retrieved at all");
    const decidedAt = asked[0].at;

    const left = productRequests(transport.sent);
    const stale = left.filter((request) => request.at - decidedAt >= CACHE_BOUND_MS);

    console.log(
      `[ceiling queue] robots.txt retrieved ${asked.length} time(s), first at ` +
        `${decidedAt}; cache bound ${CACHE_BOUND_MS}ms; requests that left:`,
      report(left),
    );

    assert.deepEqual(
      report(stale),
      [],
      `${stale.length} request(s) left the process under a robots decision ` +
        `retrieved at ${decidedAt}, which the configured bound of ` +
        `${CACHE_BOUND_MS}ms had already expired, and robots.txt was retrieved ` +
        `${asked.length} time(s) in total`,
    );
  });

  it("re-retrieves it after a Retry-After hold longer than the shipped bound", async () => {
    const clock = new FakeClock();
    const rules = changingHost();
    let held = false;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname === "/robots.txt") return rules(request);
      if (held) return { status: 200, body: "a price would be here" };
      held = true;
      // One host, one header, asking for seven hours. The shipped robots cache
      // bound is six.
      return {
        status: 503,
        headers: {
          "retry-after": new Date(clock.now() + 7 * 3_600_000).toUTCString(),
        },
        body: "",
      };
    });
    const { governor } = buildGovernor({
      transport,
      config: holdConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const asked = robotsRequests(transport.sent);
    const decidedAt = asked[0].at;
    const left = productRequests(transport.sent);
    const stale = left.filter(
      (request) => request.at - decidedAt >= SHIPPED_CACHE_BOUND_MS,
    );

    console.log(
      `[Retry-After hold] robots.txt retrieved ${asked.length} time(s), first ` +
        `at ${decidedAt}; shipped cache bound ${SHIPPED_CACHE_BOUND_MS}ms; ` +
        "requests that left:",
      report(left),
    );

    assert.deepEqual(
      report(stale),
      [],
      `${stale.length} request(s) left the process under a robots decision ` +
        `retrieved at ${decidedAt} and expired by the shipped bound of ` +
        `${SHIPPED_CACHE_BOUND_MS}ms, after a single Retry-After held the host`,
    );
  });

  it("control: offered after the bound, the same fetch is refused, so the gate works", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, changingHost());
    const { governor } = buildGovernor({
      transport,
      config: queueConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    const first = await governor.request({
      url: "http://127.0.0.1/a",
      sourceId: "test-source",
    });
    assert.equal(first.ok, true);

    await clock.advanceBy(CACHE_BOUND_MS + 1);

    const second = await governor.request({
      url: "http://127.0.0.1/b",
      sourceId: "test-source",
    });

    assert.equal(second.ok, false, "the expired decision was reused at the call boundary too");
    assert.equal(
      second.ok === false ? second.reason : "",
      "robots-disallowed",
      "the sequential path is correct: an expired decision is re-retrieved",
    );
    assert.equal(robotsRequests(transport.sent).length, 2);
  });
});
