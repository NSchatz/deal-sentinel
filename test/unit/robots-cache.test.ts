/**
 * Acceptance criterion 10 of spec S0023-deal-sentinel-governor-2:
 *
 *   WHEN a host's cached robots decision is older than the configured cache
 *   bound, which SHALL NOT be configurable above 24 hours, THE SYSTEM SHALL
 *   re-retrieve `robots.txt` before the next fetch to that host; within the
 *   bound it SHALL NOT re-retrieve it.
 *
 * RFC 9309 section 2.4: "Crawlers SHOULD NOT use the cached version for more
 * than 24 hours, unless the robots.txt file is unreachable."
 *
 * Both halves matter and they pull in opposite directions. Re-reading the file
 * on every request would be traffic the host never asked for; never re-reading
 * it means a host that ADDS a disallow rule is ignored until the process
 * restarts. The stub server counts its own `/robots.txt` requests, so both
 * halves are counted rather than inferred, and the clock is virtual so a
 * six-hour bound costs nothing to cross.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { ROBOTS_CACHE_BOUND_CEILING_MS, createFetchTransport } from "@deal-sentinel/governor";

import { startLoopbackServer } from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const CACHE_BOUND_MS = 6 * 60 * 60 * 1000;

let server: LoopbackServer;
let robotsBody = "";

before(async () => {
  server = await startLoopbackServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(robotsBody);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`served ${path}`);
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
      robots: { cacheBoundMs: CACHE_BOUND_MS },
      hosts: {
        "127.0.0.1": {
          maxRequests: 5_000,
          intervalMs: 60_000,
          minDelayMs: 1,
          jitterMs: 1,
        },
      },
    }),
  });
}

describe("the robots decision is cached, and the cache is bounded", () => {
  it("retrieves once and then not again inside the bound", async () => {
    robotsBody = ["User-agent: *", "Disallow: /blocked"].join("\n");
    const clock = new FakeClock(0);
    const { governor } = harness(clock);
    const before = server.servedFor("/robots.txt").length;

    for (let index = 0; index < 5; index += 1) {
      const outcome = await governor.request({
        url: `${server.origin}/page/${index}`,
        sourceId: "test-source",
      });
      assert.equal(outcome.ok, true);
      await clock.advanceBy(CACHE_BOUND_MS / 10);
    }

    assert.equal(
      server.servedFor("/robots.txt").length - before,
      1,
      "robots.txt was re-retrieved inside the configured cache bound",
    );
  });

  it("does not re-retrieve one millisecond before the bound, and does at it", async () => {
    robotsBody = ["User-agent: *", "Disallow: /blocked"].join("\n");
    const clock = new FakeClock(0);
    const { governor } = harness(clock);
    const before = server.servedFor("/robots.txt").length;

    await governor.request({ url: `${server.origin}/a`, sourceId: "test-source" });
    const afterFirst = server.servedFor("/robots.txt").length;
    assert.equal(afterFirst - before, 1);

    // The decision was cached at the instant the retrieval completed; step to
    // one millisecond short of the bound from there.
    await clock.advanceBy(CACHE_BOUND_MS - clock.now() - 1);
    await governor.request({ url: `${server.origin}/b`, sourceId: "test-source" });
    assert.equal(
      server.servedFor("/robots.txt").length,
      afterFirst,
      "robots.txt was re-retrieved one millisecond before the bound",
    );

    await clock.advanceBy(10);
    await governor.request({ url: `${server.origin}/c`, sourceId: "test-source" });
    assert.equal(
      server.servedFor("/robots.txt").length,
      afterFirst + 1,
      "robots.txt was not re-retrieved after the bound elapsed",
    );
  });

  it("obeys a rule the host added after the bound elapsed", async () => {
    robotsBody = ["User-agent: *", "Allow: /"].join("\n");
    const clock = new FakeClock(0);
    const { governor } = harness(clock);

    const allowed = await governor.request({
      url: `${server.origin}/newly-private/item`,
      sourceId: "test-source",
    });
    assert.equal(allowed.ok, true);

    // The host changes its mind. Inside the bound the old decision stands.
    robotsBody = ["User-agent: *", "Disallow: /newly-private"].join("\n");
    const stillAllowed = await governor.request({
      url: `${server.origin}/newly-private/item`,
      sourceId: "test-source",
    });
    assert.equal(stillAllowed.ok, true);

    await clock.advanceBy(CACHE_BOUND_MS + 1);
    const refused = await governor.request({
      url: `${server.origin}/newly-private/item`,
      sourceId: "test-source",
    });
    assert.equal(refused.ok, false, "the re-retrieved rules were not applied");
    if (refused.ok) return;
    assert.equal(refused.reason, "robots-disallowed");
  });

  it("holds the 24-hour ceiling the standard sets on that bound", () => {
    assert.equal(ROBOTS_CACHE_BOUND_CEILING_MS, 24 * 60 * 60 * 1000);
    // The configuration loader refuses anything above it; that refusal is
    // graded in governor-config.test.ts.
    assert.ok(CACHE_BOUND_MS < ROBOTS_CACHE_BOUND_CEILING_MS);
  });
});
