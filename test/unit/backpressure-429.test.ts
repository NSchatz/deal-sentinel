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

import { createFetchTransport, holdForResponse, readRetryAfter } from "@deal-sentinel/governor";

import { startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

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
    transport: createFetchTransport(),
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
