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

import { createFetchTransport } from "@deal-sentinel/governor";

import {
  closedLoopbackOrigin,
  reply,
  routes,
  startLoopbackServer,
} from "../support/loopback-server.ts";
import type { LoopbackServer } from "../support/loopback-server.ts";
import { buildGovernor, testConfig } from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

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
      transport: createFetchTransport(),
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
      transport: createFetchTransport(),
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
      transport: createFetchTransport(),
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
      transport: createFetchTransport(),
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
