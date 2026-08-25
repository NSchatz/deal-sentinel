/**
 * Acceptance criterion 8 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN a host answers 404 or another 4xx for `robots.txt` THE SYSTEM SHALL
 *   treat that host as carrying no rules and SHALL allow the fetch, still under
 *   that host's configured ceiling and delay.
 *
 * RFC 9309 section 2.3.1.3: "If a server status code indicates that the
 * robots.txt file is unavailable to the crawler, then the crawler MAY access
 * any resources on the server."
 *
 * This is graded in a file of its own, separate from criterion 7, because the
 * standard treats the two oppositely: a 404 OPENS a host and a 500 CLOSES it.
 * A single "non-200" branch would satisfy neither.
 *
 * The second half of the criterion matters as much as the first. The standard
 * sets NO rate - its only Limits section is about parsing - so an absent
 * robots.txt is not permission to go fast, and this project's own ceiling still
 * applies.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createFetchTransport } from "@deal-sentinel/governor";

import { reply, routes, startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../support/fake-clock.ts";

function config(overrides: Partial<{ maxRequests: number; intervalMs: number }> = {}) {
  return testConfig({
    http: { requestTimeoutMs: 2_000, maxResponseBytes: 1_048_576 },
    hosts: {
      "127.0.0.1": {
        maxRequests: overrides.maxRequests ?? 100,
        intervalMs: overrides.intervalMs ?? 60_000,
        minDelayMs: 1_000,
        jitterMs: 500,
      },
    },
  });
}

describe("a host with no robots.txt carries no rules", () => {
  let server: LoopbackServer;

  before(async () => {
    server = await startLoopbackServer(
      routes({
        "/robots.txt": reply(404, "not found"),
        "/listing/1": reply(200, "a price would be here"),
        "/anything/at/all": reply(200, "another page"),
      }),
    );
  });

  after(async () => {
    await server.close();
  });

  it("allows the fetch after a 404", async () => {
    const { governor } = buildGovernor({
      transport: createFetchTransport(),
      clock: new FakeClock(),
      config: config(),
    });

    const outcome = await governor.request({
      url: `${server.origin}/listing/1`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.response.status, 200);
    assert.equal(outcome.response.body, "a price would be here");
    assert.equal(server.servedFor("/listing/1").length, 1);
  });

  it("still applies the host's ceiling and its randomised delay", async () => {
    const clock = new FakeClock(0);
    const { governor } = buildGovernor({
      transport: createFetchTransport(),
      clock,
      random: sequenceRandom([0.2, 0.8]),
      config: config(),
    });

    const outcome = await governor.request({
      url: `${server.origin}/anything/at/all`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    // The delay is the configured floor plus jitter drawn from the injected
    // randomness: 1000 + floor(0.8 * 501) = 1400 for the page, after the
    // robots fetch took 1000 + floor(0.2 * 501) = 1100.
    assert.equal(outcome.release.delayMs, 1_400);
    assert.equal(outcome.release.at, 2_500);
  });

  it("holds a second page behind the ceiling even with no rules to obey", async () => {
    const clock = new FakeClock(0);
    const { governor } = buildGovernor({
      transport: createFetchTransport(),
      clock,
      random: sequenceRandom([0]),
      // Two releases per ten seconds: robots and one page fill it.
      config: config({ maxRequests: 2, intervalMs: 10_000 }),
    });

    const first = await governor.request({
      url: `${server.origin}/listing/1`,
      sourceId: "test-source",
    });
    const second = await governor.request({
      url: `${server.origin}/anything/at/all`,
      sourceId: "test-source",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.ok(
      second.release.at - first.release.at >= 9_000,
      `the second page went out ${second.release.at - first.release.at}ms after ` +
        "the first, inside a ten-second ceiling window",
    );
  });
});

describe("the other 4xx answers are the same case", () => {
  for (const status of [401, 403, 410, 451]) {
    it(`treats ${status} on robots.txt as no rules rather than as disallow`, async () => {
      const server = await startLoopbackServer(
        routes({
          "/robots.txt": reply(status, "no robots file for you"),
          "/listing/1": reply(200, "a price would be here"),
        }),
      );
      try {
        const { governor } = buildGovernor({
          transport: createFetchTransport(),
          clock: new FakeClock(),
          config: config(),
        });

        const outcome = await governor.request({
          url: `${server.origin}/listing/1`,
          sourceId: "test-source",
        });

        assert.equal(outcome.ok, true, `a ${status} closed the host`);
        assert.equal(server.servedFor("/listing/1").length, 1);
      } finally {
        await server.close();
      }
    });
  }
});
