/**
 * Acceptance criterion 12 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN a response from a host carries `Retry-After` in the `delay-seconds`
 *   form THE SYSTEM SHALL issue no further request to that host until at least
 *   that many seconds have elapsed.
 *
 * RFC 9110 section 10.2.3: `Retry-After = HTTP-date / delay-seconds`, and "A
 * delay-seconds value is a non-negative decimal integer, representing time in
 * seconds". The date form is graded separately in `retry-after-date.test.ts`,
 * because a parser that reads only integers passes this file and fails that
 * one, and that is the parser that turns a throttle into a block.
 *
 * The hold is asserted on the injected clock: no test here sleeps. The stub
 * server is on 127.0.0.1 (AC23), and the breaker is configured out of the way
 * because it is graded in `breaker.test.ts`.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createFetchTransport, readRetryAfter } from "@deal-sentinel/governor";

import { startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

let server: LoopbackServer;
/** What the stub answers next, in order, for any non-robots path. */
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
    transport: createFetchTransport(),
    clock,
    config: testConfig({
      http: { requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576 },
      // The delay floor is 1ms so that the only thing worth measuring in this
      // file is the hold the host asked for.
      hosts: {
        "127.0.0.1": {
          maxRequests: 5_000,
          intervalMs: 60_000,
          minDelayMs: 1,
          jitterMs: 1,
        },
      },
      backPressure: { defaultBackoffMs: 30_000 },
      breaker: { minimumOutcomes: 1_000 },
    }),
  });
}

describe("Retry-After in the delay-seconds form holds the host", () => {
  it("waits at least the stated number of seconds before the next request", async () => {
    script = [{ status: 429, headers: { "retry-after": "120" } }, { status: 200 }];
    served = 0;

    const clock = new FakeClock(0);
    const { governor } = harness(clock);

    const throttled = await governor.request({
      url: `${server.origin}/listing/1`,
      sourceId: "test-source",
    });
    assert.equal(throttled.ok, true);
    if (!throttled.ok) return;
    assert.equal(throttled.response.status, 429);

    const next = await governor.request({
      url: `${server.origin}/listing/2`,
      sourceId: "test-source",
    });
    assert.equal(next.ok, true);
    if (!next.ok) return;

    const waited = next.release.at - throttled.release.at;
    assert.ok(
      waited >= 120_000,
      `the next request went out ${waited}ms after the 429, and the host asked ` +
        "for 120000ms",
    );
    // And not absurdly longer: the hold is what was asked for, not a punishment.
    assert.ok(waited <= 120_100, `the host was held ${waited}ms for a 120s ask`);
  });

  it("holds every path on that host, not only the one that was throttled", async () => {
    script = [{ status: 429, headers: { "retry-after": "60" } }, { status: 200 }];
    served = 0;

    const clock = new FakeClock(0);
    const { governor } = harness(clock);

    const throttled = await governor.request({
      url: `${server.origin}/a`,
      sourceId: "test-source",
    });
    const other = await governor.request({
      url: `${server.origin}/completely/different`,
      sourceId: "test-source",
    });

    assert.equal(throttled.ok && other.ok, true);
    if (!throttled.ok || !other.ok) return;
    assert.ok(other.release.at - throttled.release.at >= 60_000);
  });

  it("honours a Retry-After that arrives on something other than a 429", async () => {
    // RFC 9110 defines the field for 503 and for 3xx as well. A host asking for
    // less traffic is a host asking for less traffic.
    script = [
      { status: 503, headers: { "retry-after": "90" } },
      { status: 200 },
    ];
    served = 0;

    const clock = new FakeClock(0);
    const { governor } = harness(clock);

    const unavailable = await governor.request({
      url: `${server.origin}/a`,
      sourceId: "test-source",
    });
    const next = await governor.request({
      url: `${server.origin}/b`,
      sourceId: "test-source",
    });

    assert.equal(unavailable.ok && next.ok, true);
    if (!unavailable.ok || !next.ok) return;
    assert.ok(next.release.at - unavailable.release.at >= 90_000);
  });

  it("takes the longer of two holds rather than the more recent", async () => {
    script = [
      { status: 429, headers: { "retry-after": "600" } },
      { status: 429, headers: { "retry-after": "5" } },
      { status: 200 },
    ];
    served = 0;

    const clock = new FakeClock(0);
    const { governor } = harness(clock);

    const first = await governor.request({
      url: `${server.origin}/a`,
      sourceId: "test-source",
    });
    const second = await governor.request({
      url: `${server.origin}/b`,
      sourceId: "test-source",
    });
    const third = await governor.request({
      url: `${server.origin}/c`,
      sourceId: "test-source",
    });

    assert.equal(first.ok && second.ok && third.ok, true);
    if (!first.ok || !second.ok || !third.ok) return;
    assert.ok(second.release.at - first.release.at >= 600_000);
    // The short second ask does not shorten what is already in place, but it
    // is the later instant that counts once it is longer than what remains.
    assert.ok(third.release.at >= second.release.at + 5_000);
  });
});

describe("the delay-seconds reading itself", () => {
  it("reads a non-negative decimal integer as seconds", () => {
    assert.deepEqual(readRetryAfter("120", 0), { form: "delay-seconds", holdMs: 120_000 });
    assert.deepEqual(readRetryAfter("  0  ", 0), { form: "delay-seconds", holdMs: 0 });
  });

  it("does not invent a number the server did not send", () => {
    // "120s", "+120" and "1.5" are not the delay-seconds form. Reading them as
    // one is guessing, and guessing here guesses downwards.
    for (const value of ["120s", "+120", "1.5"]) {
      assert.notEqual(readRetryAfter(value, 0).form, "delay-seconds");
    }
  });
});
