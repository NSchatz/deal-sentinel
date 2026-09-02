/**
 * Acceptance criterion 7 of spec S0023-deal-sentinel-governor-2:
 *
 *   IF a host's `robots.txt` is unreachable through a server error or a network
 *   error THEN THE SYSTEM SHALL treat that host as fully disallowed and SHALL
 *   skip the fetch.
 *
 * RFC 9309 section 2.3.1.4: "If the robots.txt file is unreachable due to
 * server or network errors, this means the robots.txt file is undefined and the
 * crawler MUST assume complete disallow."
 *
 * Graded as three separate cases - a 5xx, a connection failure, and a timeout -
 * each asserting that the page fetch DID NOT HAPPEN, which the stub server can
 * answer for because it records every request it accepted. The natural
 * implementation (any non-200 means "no rules, proceed") is one line, is what a
 * careless HTTP wrapper does by default, inverts a MUST, and does it at exactly
 * the moment a site is under load.
 *
 * Everything here runs against a server on 127.0.0.1 through the real transport
 * (AC23): no third party is touched to prove a rule about third parties.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { LIVE_TRANSPORT } from "@deal-sentinel/governor";

import {
  closedLoopbackOrigin,
  reply,
  routes,
  startLoopbackServer,
} from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import {
  buildGovernor,
  productRequests,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";
import type { SentRequest } from "../support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../support/fake-clock.ts";

function config(timeoutMs = 2_000) {
  return testConfig({
    http: { requestTimeoutMs: timeoutMs, maxResponseBytes: 1_048_576 },
    hosts: {
      "127.0.0.1": {
        maxRequests: 100,
        intervalMs: 60_000,
        minDelayMs: 1,
        jitterMs: 1,
      },
    },
  });
}

describe("a 5xx on robots.txt disallows the host completely", () => {
  let server: LoopbackServer;

  before(async () => {
    server = await startLoopbackServer(
      routes({
        "/robots.txt": reply(500, "the robots file is not available right now"),
        "/listing/1": reply(200, "a price would be here"),
      }),
    );
  });

  after(async () => {
    await server.close();
  });

  it("refuses the fetch and never asks the server for the page", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(),
    });

    const outcome = await governor.request({
      url: `${server.origin}/listing/1`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "robots-unreachable");
    assert.match(outcome.detail, /2\.3\.1\.4/);
    assert.equal(server.servedFor("/robots.txt").length, 1);
    assert.equal(
      server.servedFor("/listing/1").length,
      0,
      "the page was fetched even though robots.txt was unreachable",
    );
  });

  it("keeps refusing while the decision is cached, without re-asking", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(),
    });

    const before = server.servedFor("/robots.txt").length;
    for (let index = 0; index < 3; index += 1) {
      const outcome = await governor.request({
        url: `${server.origin}/listing/1`,
        sourceId: "test-source",
      });
      assert.equal(outcome.ok, false);
    }
    // One retrieval for this governor, then the cached complete-disallow.
    assert.equal(server.servedFor("/robots.txt").length, before + 1);
    assert.equal(server.servedFor("/listing/1").length, 0);
  });
});

describe("a connection failure on robots.txt disallows the host completely", () => {
  it("refuses when nothing is listening at all", async () => {
    const origin = await closedLoopbackOrigin();
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      config: config(),
    });

    const outcome = await governor.request({
      url: `${origin}/listing/1`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "robots-unreachable");
    assert.match(outcome.detail, /could not be reached|status/);
  });
});

/**
 * The other side of AC7, which is a scope as much as a rule:
 *
 *   IF a host's `robots.txt` is unreachable through A SERVER ERROR OR A NETWORK
 *   ERROR THEN THE SYSTEM SHALL treat that host as fully disallowed.
 *
 * The governor's own `robots.txt` retrieval goes through the chokepoint like
 * everything else, so it can meet the governor's OWN gates on the far side of
 * the per-host wait: the source paused by its breaker (AC16), or its allowance
 * for the period spent (AC19). Neither is a server error and neither is a
 * network error. Nothing left the process, so nothing was learned about the
 * host, and there is no verdict to hold.
 *
 * Recording it as "unreachable" would be wrong in two ways that outlive the
 * cause. The cache is keyed by ORIGIN, so one source's spent allowance would
 * disallow that host for EVERY source, against AC19's "SHALL leave every other
 * source serving"; and the entry would stand for the whole
 * `robots.cacheBoundMs`, so a new allowance period would still meet the
 * previous period's exhaustion, against AC21.
 *
 * Graded against the recording transport, because these cases are about a
 * request that does NOT leave and about a retrieval that must happen LATER,
 * both of which the injected clock decides without a socket in the way.
 */
describe("the governor's own refusal is not an unreachable robots.txt", () => {
  const PERIOD_MS = 3_600_000;

  function twoHostConfig(limit: number) {
    return testConfig({
      hosts: {
        // The fast host reaches its releases while the slow host's robots.txt
        // retrieval is still waiting at its own gate. That is the whole
        // arrangement: it puts one of the governor's gates on the far side of
        // a wait that a robots retrieval is sitting in.
        "127.0.0.1": { maxRequests: 100, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        "127.0.0.2": {
          maxRequests: 100,
          intervalMs: 60_000,
          minDelayMs: 60_000,
          jitterMs: 1,
        },
      },
      // Six hours: long enough that a cached verdict would still be standing at
      // every assertion below, which is what makes "it was asked again" mean
      // "nothing was cached" rather than "the bound elapsed".
      robots: { cacheBoundMs: 21_600_000 },
      breaker: { minimumOutcomes: 10_000 },
      sources: {
        metered: { allowance: { limit, periodMs: PERIOD_MS, warnFraction: 0.9 } },
        other: {},
      },
    });
  }

  function robotsSentTo(sent: readonly SentRequest[], hostname: string): SentRequest[] {
    return sent.filter((request) => {
      const url = new URL(request.url);
      return url.hostname === hostname && url.pathname === "/robots.txt";
    });
  }

  it("does not disallow the host for every other source", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: twoHostConfig(1),
      random: sequenceRandom([0]),
    });

    // Offered together: the fast host spends the single unit of allowance while
    // the slow host's robots.txt retrieval is still queued behind its ceiling.
    const [, slow] = await Promise.all([
      governor.request({ url: "http://127.0.0.1/one", sourceId: "metered" }),
      governor.request({ url: "http://127.0.0.2/two", sourceId: "metered" }),
    ]);

    assert.equal(slow.ok, false);
    if (slow.ok) return;
    assert.equal(
      slow.reason,
      "allowance-exhausted",
      "the governor's own refusal was reported as a fact about the host",
    );
    assert.doesNotMatch(slow.detail, /2\.3\.1\.4/);
    assert.equal(
      robotsSentTo(transport.sent, "127.0.0.2").length,
      0,
      "the refused retrieval left the process after all",
    );

    // A different source, with no allowance of its own to have spent. The host
    // is asked for its rules for the first time, and is served.
    const other = await governor.request({
      url: "http://127.0.0.2/three",
      sourceId: "other",
    });

    assert.equal(
      other.ok,
      true,
      "one source's spent allowance held the host disallowed for every source",
    );
    assert.equal(robotsSentTo(transport.sent, "127.0.0.2").length, 1);
  });

  it("serves the host again in the next allowance period (AC21)", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: twoHostConfig(2),
      random: sequenceRandom([0]),
    });

    const [, slow] = await Promise.all([
      governor.request({ url: "http://127.0.0.1/one", sourceId: "metered" }),
      governor.request({ url: "http://127.0.0.2/two", sourceId: "metered" }),
    ]);
    assert.equal(slow.ok, false);
    if (slow.ok) return;
    assert.equal(slow.reason, "allowance-exhausted");

    await clock.advanceBy(PERIOD_MS);

    const afterRoll = await governor.request({
      url: "http://127.0.0.2/two",
      sourceId: "metered",
    });

    assert.equal(
      afterRoll.ok,
      true,
      "the new period met the previous period's exhaustion, cached as a robots verdict",
    );
    assert.equal(
      robotsSentTo(transport.sent, "127.0.0.2").length,
      1,
      "the host's rules were never actually retrieved",
    );
  });

  it("does not disallow the host because the breaker paused the source", async () => {
    const clock = new FakeClock();
    const transport = recordingTransport(
      clock,
      robotsAbsent((request) =>
        new URL(request.url).hostname === "127.0.0.1" ? { status: 500 } : { status: 200 },
      ),
    );
    const config = testConfig({
      hosts: {
        "127.0.0.1": { maxRequests: 100, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
        "127.0.0.2": {
          maxRequests: 100,
          intervalMs: 60_000,
          minDelayMs: 60_000,
          jitterMs: 1,
        },
      },
      robots: { cacheBoundMs: 21_600_000 },
      breaker: {
        windowMs: 6_000_000,
        minimumOutcomes: 2,
        failureRateThreshold: 0.5,
        pauseMs: 3_600_000,
      },
      sources: { flaky: {} },
    });
    const { governor } = buildGovernor({
      transport,
      clock,
      config,
      random: sequenceRandom([0]),
    });

    // The failing host trips the breaker while the other host's robots.txt
    // retrieval waits at its own gate.
    const outcomes = await Promise.all([
      ...["/a", "/b", "/c"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "flaky" }),
      ),
      governor.request({ url: "http://127.0.0.2/two", sourceId: "flaky" }),
    ]);

    const slow = outcomes[3];
    assert.equal(slow.ok, false);
    if (slow.ok) return;
    assert.equal(
      slow.reason,
      "source-paused",
      "a paused source's request left, or was disguised as a robots verdict",
    );
    assert.equal(robotsSentTo(transport.sent, "127.0.0.2").length, 0);
    assert.equal(
      productRequests(transport.sent).filter(
        (sent) => new URL(sent.url).hostname === "127.0.0.1",
      ).length,
      1,
      "requests kept leaving for a source the breaker had paused",
    );

    await clock.advanceBy(3_600_000);

    const afterPause = await governor.request({
      url: "http://127.0.0.2/two",
      sourceId: "flaky",
    });

    assert.equal(
      afterPause.ok,
      true,
      "the pause outlived itself as a cached complete-disallow for the host",
    );
    assert.equal(robotsSentTo(transport.sent, "127.0.0.2").length, 1);
  });
});

describe("a timeout on robots.txt disallows the host completely", () => {
  let server: LoopbackServer;

  before(async () => {
    server = await startLoopbackServer(
      routes({
        // Accepts the request and answers nothing, ever.
        "/robots.txt": () => undefined,
        "/listing/1": reply(200, "a price would be here"),
      }),
    );
  });

  after(async () => {
    await server.close();
  });

  it("refuses the fetch when robots.txt never answers", async () => {
    const { governor } = buildGovernor({
      transport: LIVE_TRANSPORT,
      clock: new FakeClock(),
      // A real timeout, in real milliseconds: this one is about the socket and
      // not about the governor's own virtual clock.
      config: config(250),
    });

    const outcome = await governor.request({
      url: `${server.origin}/listing/1`,
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "robots-unreachable");
    assert.equal(server.servedFor("/robots.txt").length, 1);
    assert.equal(
      server.servedFor("/listing/1").length,
      0,
      "the page was fetched even though robots.txt timed out",
    );
  });
});
