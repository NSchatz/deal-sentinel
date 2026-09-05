/**
 * Acceptance criteria 14 and 15 of spec S0023-deal-sentinel-governor-2:
 *
 *   AC14 WHEN a host answers 429 with no `Retry-After` THE SYSTEM SHALL hold
 *        that host for at least its configured back-off interval before the
 *        next request to it.
 *   AC15 IF a `Retry-After` value parses as neither legal form, or names an
 *        instant already past, THEN THE SYSTEM SHALL still hold that host for
 *        at least its configured back-off interval and SHALL NOT retry
 *        immediately.
 *
 * RFC 6585 section 4 makes the header optional on a 429 ("MAY include a
 * Retry-After header"), so the common case is a 429 with nothing to read, and
 * the configured back-off is what the host gets instead.
 *
 * AC15 is a RULING, not a reading of the RFC (spec ruling R4). RFC 9110 would
 * permit retrying immediately on a date already past. That reading is refused
 * here: the host that sent the header is the host asking for less traffic, and
 * this repository's fail-safe rule is never a confident wrong answer in the
 * direction of more requests.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { LIVE_TRANSPORT, holdForResponse, readRetryAfter } from "@deal-sentinel/governor";

import { startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import {
  buildGovernor,
  productRequests,
  recordingTransport,
  testConfig,
} from "../support/governor-harness.ts";
import type { SentRequest } from "../support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../support/fake-clock.ts";

const START = Date.UTC(2026, 7, 25, 12, 0, 0);
const BACKOFF_MS = 240_000;

let server: LoopbackServer;
let script: Array<{ status: number; headers?: Record<string, string> }> = [];
let served = 0;

before(async () => {
  server = await startLoopbackServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      response.writeHead(404);
      response.end("no rules");
      return;
    }
    const next = script[Math.min(served, script.length - 1)];
    served += 1;
    response.writeHead(next.status, {
      "content-type": "text/plain",
      ...(next.headers ?? {}),
    });
    response.end(`answer ${served}`);
  });
});

after(async () => {
  await server.close();
});

function harness(clock: FakeClock) {
  return buildGovernor({
    transport: LIVE_TRANSPORT,
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
      },
      backPressure: { defaultBackoffMs: BACKOFF_MS },
      breaker: { minimumOutcomes: 1_000 },
    }),
  });
}

async function holdAfter(header: string | null, status = 429): Promise<number> {
  script = [
    { status, headers: header === null ? {} : { "retry-after": header } },
    { status: 200 },
  ];
  served = 0;

  const clock = new FakeClock(START);
  const { governor } = harness(clock);

  const first = await governor.request({
    url: `${server.origin}/listing/1`,
    sourceId: "test-source",
  });
  const second = await governor.request({
    url: `${server.origin}/listing/2`,
    sourceId: "test-source",
  });

  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("the stub refused a request");
  return second.release.at - first.release.at;
}

describe("a 429 with no Retry-After earns the configured back-off", () => {
  it("holds the host for at least the configured interval", async () => {
    const waited = await holdAfter(null);
    assert.ok(
      waited >= BACKOFF_MS,
      `the host was held ${waited}ms, less than the configured ${BACKOFF_MS}ms`,
    );
  });

  it("does not hold a host that answered normally", async () => {
    script = [{ status: 200 }];
    served = 0;
    const clock = new FakeClock(START);
    const { governor } = harness(clock);

    const first = await governor.request({
      url: `${server.origin}/a`,
      sourceId: "test-source",
    });
    const second = await governor.request({
      url: `${server.origin}/b`,
      sourceId: "test-source",
    });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.ok(second.release.at - first.release.at < 1_000);
  });
});

describe("a Retry-After nobody can read still holds the host", () => {
  const unreadable = [
    ["soon", "a word"],
    ["120s", "a number with a unit, which is neither legal form"],
    ["-30", "a negative, which delay-seconds cannot be"],
    ["", "an empty value"],
    ["Fri, 99 Zzz 1999 99:99:99 GMT", "something date-shaped that is not a date"],
  ] as const;

  for (const [value, why] of unreadable) {
    it(`falls back to the configured back-off for ${why}`, async () => {
      const waited = await holdAfter(value);
      assert.ok(
        waited >= BACKOFF_MS,
        `${JSON.stringify(value)} produced a hold of ${waited}ms, and the ` +
          "configured back-off is " +
          `${BACKOFF_MS}ms`,
      );
    });
  }

  it("falls back to the configured back-off for an instant already past", async () => {
    const waited = await holdAfter(new Date(START - 60_000).toUTCString());
    assert.ok(
      waited >= BACKOFF_MS,
      `a date already past produced a hold of ${waited}ms rather than the ` +
        `configured ${BACKOFF_MS}ms`,
    );
  });

  it("never retries immediately on any of them", async () => {
    for (const [value] of unreadable) {
      const waited = await holdAfter(value);
      assert.ok(waited > 1_000, `${JSON.stringify(value)} was retried after ${waited}ms`);
    }
  });
});

/**
 * Not AC14 and not AC15: `Retry-After: 0` parses perfectly well as
 * `delay-seconds`, and AC12's "at least that many seconds" is satisfied by
 * zero. It is here because ruling R4's principle is wider than the two cases
 * AC15 names, and because a 429 that names a value must never earn LESS of a
 * hold than the same 429 with no header at all.
 */
describe("a Retry-After of zero is not a licence to retry at once", () => {
  const noWait = ["0", "00", " 0 "] as const;

  for (const value of noWait) {
    it(`falls back to the configured back-off for ${JSON.stringify(value)}`, async () => {
      const waited = await holdAfter(value);
      assert.ok(
        waited >= BACKOFF_MS,
        `${JSON.stringify(value)} produced a hold of ${waited}ms, which is less ` +
          `than the ${BACKOFF_MS}ms the same 429 would have earned carrying no ` +
          "header at all",
      );
    });
  }

  it("keeps the parser honest about what the header said", () => {
    // The reading stays faithful to RFC 9110 - zero IS a legal delay-seconds
    // value - and the refusal lives in the policy layer, where the ruling is.
    const reading = readRetryAfter("0", 0);
    assert.equal(reading.form, "delay-seconds");
    assert.equal(reading.holdMs, 0);

    const hold = holdForResponse(429, "0", 0, BACKOFF_MS);
    assert.ok(hold !== null);
    assert.equal(hold.holdMs, BACKOFF_MS);
    assert.match(hold.reason, /no wait at all/);
  });

  it("still honours a value that asks for a real wait", () => {
    const hold = holdForResponse(429, "30", 0, BACKOFF_MS);
    assert.ok(hold !== null);
    assert.equal(hold.holdMs, 30_000);
  });
});

/**
 * The back-pressure the governor earns FOR ITSELF, on the far side of the wait.
 *
 * Gate 5 is re-asked at the process boundary, because AC10 requires a robots
 * decision older than `robots.cacheBoundMs` to be re-retrieved before the next
 * fetch to that host. That re-ask can retrieve `/robots.txt`, and that
 * retrieval is a request to the very host whose release the waiting request
 * already holds. `HostScheduler.release` is the only reader of a hold, and it
 * has returned by then.
 *
 * Nothing in AC14, AC12 or AC1 carves out an exception for a hold the governor
 * earned by going to ask a host for its own rules, so gate 6 is taken again
 * whenever that re-ask landed a retrieval. These cases hold that shut. They use
 * the recording transport rather than the loopback server because what is under
 * test is WHEN a request leaves, on a virtual clock, over holds measured in
 * minutes.
 */
describe("a hold the robots re-ask earns past the wait binds the request behind it", () => {
  const MIN_DELAY_MS = 5_000;
  /** Short enough that a request queued behind another outlives it. */
  const CACHE_BOUND_MS = 2_000;
  const ALLOW_EVERYTHING = "User-agent: *\nAllow: /\n";

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
      breaker: { minimumOutcomes: 1_000_000, failureRateThreshold: 1, pauseMs: 1 },
      sources: { "test-source": {} },
    });
  }

  /**
   * Offer two paths on one host at once. The second waits behind the first and
   * outlives the robots cache bound while it waits, so the re-ask at the
   * process boundary retrieves `/robots.txt` again - and `answerRobots` decides
   * what the host says when it does.
   */
  async function offerTwo(
    answerRobots: (served: number) => {
      status: number;
      headers?: Record<string, string>;
      body: string;
    },
  ): Promise<SentRequest[]> {
    const clock = new FakeClock(START);
    let robotsServed = 0;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname !== "/robots.txt") {
        return { status: 200, body: "a price would be here" };
      }
      robotsServed += 1;
      return answerRobots(robotsServed);
    });
    const { governor } = buildGovernor({
      transport,
      config: probeConfig(),
      clock,
      random: sequenceRandom([0]),
    });

    const outcomes = await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );
    assert.deepEqual(
      outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason])),
      [],
      "the probe is not set up: something refused these before the send",
    );

    const robots = transport.sent.filter(
      (request) => new URL(request.url).pathname === "/robots.txt",
    );
    assert.ok(
      robots.length >= 2 && robots[1].at !== robots[0].at,
      "the probe is not set up: robots.txt was retrieved once, so the host " +
        "never got the chance to answer the re-ask",
    );
    return transport.sent;
  }

  it("issues no request inside a back-off a 429 on that re-ask earned (AC14)", async () => {
    const sent = await offerTwo((served) =>
      served >= 2
        ? { status: 429, body: "slow down" }
        : { status: 200, body: ALLOW_EVERYTHING },
    );

    const stoppedAt = sent.filter(
      (request) => new URL(request.url).pathname === "/robots.txt",
    )[1].at;
    const inside = productRequests(sent).filter(
      (request) => request.at >= stoppedAt && request.at < stoppedAt + BACKOFF_MS,
    );
    assert.deepEqual(
      inside.map((request) => `${new URL(request.url).pathname}@${request.at}`),
      [],
      `a request left 127.0.0.1 inside the ${BACKOFF_MS}ms back-off the host ` +
        `earned at ${stoppedAt} by answering 429 to the governor's own robots fetch`,
    );
  });

  it("respects a Retry-After that re-ask earned, in the delay-seconds form (AC12)", async () => {
    const askedFor = 7_200_000;
    const sent = await offerTwo((served) =>
      served >= 2
        ? { status: 429, headers: { "retry-after": "7200" }, body: "" }
        : { status: 200, body: ALLOW_EVERYTHING },
    );

    const stoppedAt = sent.filter(
      (request) => new URL(request.url).pathname === "/robots.txt",
    )[1].at;
    const inside = productRequests(sent).filter(
      (request) => request.at >= stoppedAt && request.at < stoppedAt + askedFor,
    );
    assert.deepEqual(
      inside.map((request) => `${new URL(request.url).pathname}@${request.at}`),
      [],
      `a request left 127.0.0.1 inside the ${askedFor}ms this host asked for ` +
        `at ${stoppedAt}`,
    );
  });

  it("keeps the configured minimum delay between that re-ask and the page (AC1, AC3)", async () => {
    // No hold at all here: the host answers the re-ask normally. The page must
    // STILL be spaced from it, because a robots retrieval is a request to this
    // host like any other and the delay is measured over what actually leaves.
    const sent = await offerTwo(() => ({ status: 200, body: ALLOW_EVERYTHING }));

    const tooClose: string[] = [];
    for (let index = 1; index < sent.length; index += 1) {
      const gap = sent[index].at - sent[index - 1].at;
      if (gap < MIN_DELAY_MS) {
        tooClose.push(
          `${new URL(sent[index - 1].url).pathname}@${sent[index - 1].at} -> ` +
            `${new URL(sent[index].url).pathname}@${sent[index].at} (${gap}ms)`,
        );
      }
    }
    assert.deepEqual(
      tooClose,
      [],
      `consecutive requests left 127.0.0.1 closer together than the configured ` +
        `${MIN_DELAY_MS}ms`,
    );
  });
});

describe("the fallback decision itself", () => {
  it("classifies each unreadable form rather than guessing a number", () => {
    assert.equal(readRetryAfter("soon", 0).form, "unparseable");
    assert.equal(readRetryAfter("-30", 0).form, "unparseable");
    assert.equal(readRetryAfter("", 0).form, "unparseable");
    assert.equal(readRetryAfter(new Date(0).toUTCString(), 1_000).form, "past-date");
  });

  it("returns the configured back-off, and says why, for each of them", () => {
    for (const value of ["soon", "120s", new Date(0).toUTCString()]) {
      const hold = holdForResponse(429, value, 1_000, BACKOFF_MS);
      assert.ok(hold !== null);
      assert.equal(hold.holdMs, BACKOFF_MS);
      assert.match(hold.reason, /configured back-off/);
    }
  });

  it("returns the configured back-off for a 429 carrying nothing", () => {
    const hold = holdForResponse(429, undefined, 0, BACKOFF_MS);
    assert.ok(hold !== null);
    assert.equal(hold.holdMs, BACKOFF_MS);
  });

  it("holds nothing for an ordinary response", () => {
    assert.equal(holdForResponse(200, undefined, 0, BACKOFF_MS), null);
    assert.equal(holdForResponse(404, undefined, 0, BACKOFF_MS), null);
  });
});
