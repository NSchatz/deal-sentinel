/**
 * Acceptance criterion 13 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN a response from a host carries `Retry-After` in the `HTTP-date` form
 *   THE SYSTEM SHALL issue no further request to that host until at least that
 *   instant.
 *
 * Its own file, deliberately. RFC 9110 section 10.2.3 makes both forms legal
 * and gives one example of each:
 *
 *     Retry-After: Fri, 31 Dec 1999 23:59:59 GMT
 *     Retry-After: 120
 *
 * A parser that reads only integers passes `retry-after-seconds.test.ts` and
 * fails here: it ignores the date, retries immediately, and turns a throttle
 * into a block. So the assertion below is not "some hold happened" but "the
 * hold reached the instant the host named", and one case asserts explicitly
 * that the wait was not the zero an integer-only parser would produce.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { LIVE_TRANSPORT, readRetryAfter } from "@deal-sentinel/governor";

import { startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

/** The instant every virtual clock in this file starts at. */
const START = Date.UTC(2026, 7, 25, 12, 0, 0);

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
      // Deliberately different from the date in the header, so a fallback to
      // the configured back-off cannot be mistaken for having read the date.
      backPressure: { defaultBackoffMs: 7_000 },
      breaker: { minimumOutcomes: 1_000 },
    }),
  });
}

describe("Retry-After in the HTTP-date form holds the host until that instant", () => {
  it("waits until the named instant, not until some default", async () => {
    const resumeAt = START + 300_000;
    script = [
      {
        status: 429,
        // IMF-fixdate, which is the form RFC 9110 requires senders to generate.
        headers: { "retry-after": new Date(resumeAt).toUTCString() },
      },
      { status: 200 },
    ];
    served = 0;

    const clock = new FakeClock(START);
    const { governor } = harness(clock);

    const throttled = await governor.request({
      url: `${server.origin}/listing/1`,
      sourceId: "test-source",
    });
    const next = await governor.request({
      url: `${server.origin}/listing/2`,
      sourceId: "test-source",
    });

    assert.equal(throttled.ok && next.ok, true);
    if (!throttled.ok || !next.ok) return;
    assert.equal(throttled.response.status, 429);

    assert.ok(
      next.release.at >= resumeAt,
      `the next request went out at ${new Date(next.release.at).toISOString()}, ` +
        `before the ${new Date(resumeAt).toISOString()} the host named`,
    );
    // An integer-only parser would have produced no hold at all, and a fallback
    // to the configured back-off would have produced 7000ms.
    const waited = next.release.at - throttled.release.at;
    assert.ok(waited > 7_000, `${waited}ms is the configured back-off, not the date`);
    assert.ok(waited >= 299_900 && waited <= 300_100, `${waited}ms is not the date's own interval`);
  });

  it("holds the whole host until that instant, whatever path is asked for", async () => {
    const resumeAt = START + 600_000;
    script = [
      { status: 503, headers: { "retry-after": new Date(resumeAt).toUTCString() } },
      { status: 200 },
    ];
    served = 0;

    const clock = new FakeClock(START);
    const { governor } = harness(clock);

    await governor.request({ url: `${server.origin}/a`, sourceId: "test-source" });
    const other = await governor.request({
      url: `${server.origin}/quite/another/path`,
      sourceId: "test-source",
    });

    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.ok(other.release.at >= resumeAt);
  });
});

describe("the HTTP-date reading itself", () => {
  it("reads an IMF-fixdate in the future as a hold until that instant", () => {
    const reading = readRetryAfter("Fri, 31 Dec 1999 23:59:59 GMT", Date.UTC(1999, 11, 31, 23, 59, 0));
    assert.equal(reading.form, "http-date");
    assert.equal(reading.holdMs, 59_000);
  });

  it("reads the RFC's own example the same way", () => {
    // RFC 9110 10.2.3's two examples, side by side, read by one parser.
    const at = Date.UTC(1999, 11, 31, 23, 0, 0);
    assert.equal(readRetryAfter("Fri, 31 Dec 1999 23:59:59 GMT", at).holdMs, 59 * 60_000 + 59_000);
    assert.equal(readRetryAfter("120", at).holdMs, 120_000);
  });

  it("calls a date already past what it is, rather than a hold of zero", () => {
    const reading = readRetryAfter("Fri, 31 Dec 1999 23:59:59 GMT", Date.UTC(2026, 0, 1));
    assert.equal(reading.form, "past-date");
    assert.equal(reading.holdMs, null);
  });
});
