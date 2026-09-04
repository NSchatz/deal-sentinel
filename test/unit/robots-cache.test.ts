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

import { LIVE_TRANSPORT, ROBOTS_CACHE_BOUND_CEILING_MS } from "@deal-sentinel/governor";

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
    transport: LIVE_TRANSPORT,
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

/**
 * The same criterion at the PROCESS boundary, which is the boundary AC10's
 * "before the next fetch to that host" names and the one the cases above do
 * not reach: each of them offers its requests one at a time, so the moment the
 * decision is taken and the moment the request leaves are the same moment.
 *
 * They are not the same moment when anything waits. The per-host queue
 * serialises every concurrent offer behind the ceiling and the randomised
 * delay, and a `Retry-After` can hold a host for hours, so a request admitted
 * under a cached decision can leave long after the bound that decision carries
 * has expired - and the configured bound is the governor's own statement of how
 * long its answer stays true. Both halves of the criterion are graded here:
 * expired means re-retrieve BEFORE the fetch, and inside the bound means do not.
 *
 * The transport is the recording stub and the clock is virtual, so nothing here
 * opens a socket at all and six hours of holding cost nothing.
 */
const ALLOW_EVERYTHING = "User-agent: *\nDisallow:\n";
const DISALLOW_EVERYTHING = "User-agent: *\nDisallow: /\n";

/** A host that allows everything, then disallows everything from its second answer. */
function changingHost(): (request: { url: string }) => { status: number; body: string } {
  let served = 0;
  return (request) => {
    if (new URL(request.url).pathname !== "/robots.txt") {
      return { status: 200, body: "a page would be here" };
    }
    served += 1;
    return { status: 200, body: served === 1 ? ALLOW_EVERYTHING : DISALLOW_EVERYTHING };
  };
}

function robotsRetrievals(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter((request) => new URL(request.url).pathname === "/robots.txt");
}

/**
 * For each request that left, how old the newest robots retrieval that preceded
 * it was at that instant. This is the quantity the criterion bounds, and it is
 * measured from the transport's own log rather than from the gate's opinion.
 */
function decisionAges(sent: readonly SentRequest[]): number[] {
  const retrievals = robotsRetrievals(sent);
  return productRequests(sent).map((request) => {
    const current = retrievals.filter((retrieval) => retrieval.at <= request.at).pop();
    assert.ok(current !== undefined, `${request.url} left before any robots retrieval`);
    return request.at - current.at;
  });
}

function queuedHostConfig(cacheBoundMs: number, minDelayMs: number) {
  return testConfig({
    hosts: {
      "127.0.0.1": { maxRequests: 1_000, intervalMs: 60_000, minDelayMs, jitterMs: 1 },
    },
    robots: { cacheBoundMs },
    // High enough that the breaker is never the reason for anything here.
    breaker: {
      windowMs: 6_000_000,
      minimumOutcomes: 10_000,
      failureRateThreshold: 0.5,
      pauseMs: 3_600_000,
    },
    sources: { "test-source": {} },
  });
}

describe("the cache bound holds where the request WAITS, not only where it is asked for", () => {
  it("re-retrieves before releasing a request that outlived the bound in the queue", async () => {
    const boundMs = 120_000;
    const clock = new FakeClock();
    const transport = recordingTransport(clock, changingHost());
    const { governor } = buildGovernor({
      transport,
      config: queuedHostConfig(boundMs, 60_000),
      clock,
      random: sequenceRandom([0]),
    });

    // Five pages of one host offered at once, which is what an adapter with a
    // page list does. All five decide robots at the same instant; the host
    // releases one a minute, so the last of them leaves four minutes later.
    const outcomes = await Promise.all(
      ["/a", "/b", "/c", "/d", "/e"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    for (const age of decisionAges(transport.sent)) {
      assert.ok(
        age < boundMs,
        `a request left ${age}ms after the robots decision it left under, and ` +
          `the configured bound is ${boundMs}ms`,
      );
    }

    // And the point of re-retrieving: the rule the host added is OBEYED, so the
    // queue empties into refusals rather than into requests.
    assert.ok(
      robotsRetrievals(transport.sent).length > 1,
      "robots.txt was never re-retrieved, so the bound was not applied at the release",
    );
    assert.equal(outcomes[0].ok, true);
    assert.deepEqual(
      outcomes.slice(1).map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
      ["robots-disallowed", "robots-disallowed", "robots-disallowed", "robots-disallowed"],
    );
  });

  it("re-retrieves before releasing one held past the bound by Retry-After", async () => {
    const clock = new FakeClock();
    const rules = changingHost();
    let held = false;
    const transport = recordingTransport(clock, (request) => {
      if (new URL(request.url).pathname === "/robots.txt") return rules(request);
      if (held) return { status: 200, body: "a page would be here" };
      held = true;
      // One header, asking for seven hours. The bound below is six, which is
      // what `config/governor.json` ships.
      return {
        status: 503,
        headers: { "retry-after": new Date(clock.now() + 7 * 3_600_000).toUTCString() },
        body: "",
      };
    });
    const { governor } = buildGovernor({
      transport,
      config: queuedHostConfig(CACHE_BOUND_MS, 1),
      clock,
      random: sequenceRandom([0]),
    });

    // No queue is needed for this one: a single hold outliving the bound is
    // enough, and it is the shape a real host produces without being slow.
    const [first, second] = await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    for (const age of decisionAges(transport.sent)) {
      assert.ok(
        age < CACHE_BOUND_MS,
        `a request left ${age}ms after its robots decision, past the ${CACHE_BOUND_MS}ms bound`,
      );
    }
    assert.equal(first.ok, true);
    assert.equal(second.ok, false, "the held request left under the expired decision");
    assert.equal(second.ok === false ? second.reason : "", "robots-disallowed");
  });

  it("does not re-retrieve at the release when the decision is still inside the bound", async () => {
    // The other half of the criterion, and the one a fix could trample: five
    // releases a minute apart, an hour-long bound, so every release is inside
    // it and re-reading the file at each one would be traffic the host never
    // asked for.
    const clock = new FakeClock();
    const transport = recordingTransport(clock, changingHost());
    const { governor } = buildGovernor({
      transport,
      config: queuedHostConfig(3_600_000, 60_000),
      clock,
      random: sequenceRandom([0]),
    });

    const outcomes = await Promise.all(
      ["/a", "/b", "/c", "/d", "/e"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    assert.equal(
      robotsRetrievals(transport.sent).length,
      1,
      "robots.txt was re-retrieved inside the configured cache bound",
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.ok),
      [true, true, true, true, true],
    );
  });
});
