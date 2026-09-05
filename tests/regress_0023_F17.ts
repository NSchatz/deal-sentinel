/**
 * regress_0023_F17 - impl-gate ordinal 7, spec S0023-deal-sentinel-governor-2.
 *
 * Finding F17: a metered source's allowance is READ at the process boundary and
 * SPENT one `await` later, and nothing reconciles the two. Requests for the
 * SAME metered source on DIFFERENT hosts are serialised by nothing - the queue
 * in `HostScheduler` is per host by design, because AC4 requires one host at its
 * ceiling not to hold up another - so they all read the same consumption, all
 * pass gate 4, and all leave. The period's allowance is exceeded by the width of
 * the concurrency, and the durable counter records the overspend after the fact.
 *
 * Acceptance criterion violated (spec.md, verbatim):
 *
 *   AC19: WHEN a metered source's consumption reaches its configured allowance
 *   THE SYSTEM SHALL stop that source for the remainder of the period, refusing
 *   its requests rather than slowing them, SHALL emit exactly one stop
 *   notification, and SHALL leave every other source serving.
 *
 * And the spine assertion AC19 elaborates, also verbatim:
 *
 *   WHEN a metered source reaches its configured warn fraction THE SYSTEM SHALL
 *   warn once, and at its allowance THE SYSTEM SHALL stop that source for the
 *   period and notify once
 *
 * Root cause, `packages/governor/src/governor.ts`, `#send`:
 *
 *     const allowance = await this.#allowanceGate(request.sourceId);  // gate 4
 *     if (allowance !== null) return allowance;
 *     ...
 *     await this.#allowance.count(request.sourceId);                  // spend
 *     response = await this.#transport.send(...)                      // leaves
 *
 * `#allowanceGate` READS the store; `count` WRITES it and returns the new total,
 * which is discarded. Between the read and the write is an `await`, and a
 * request for another host is free to run there. The module header's claim that
 * "the instant the loop certified is the instant the request leaves under"
 * holds for the six gates it enumerates one at a time; it does not hold for
 * gate 4, whose answer is a statement about a counter another host's request
 * can move inside that gap - and the value that would prove it moved is thrown
 * away.
 *
 * The direction of the error is the one this phase exists to prevent. The
 * metered source the spec carries as its worked example answers an exceeded
 * allowance with a 403 (`sources/developer.bestbuy.com-legal`), and a free
 * allowance spent past its limit is, in the words of the spec's Objective,
 * something "no re-run undoes".
 *
 * The window is exactly one store round trip wide, so it is WIDEST in the
 * configuration this system actually runs: ruling R5 and AC22 put the counter
 * in PostgreSQL, and a query is milliseconds where the in-memory store is one
 * microtask. Case 4 is therefore the same offer against a real database, real
 * loopback servers, the real HTTP transport and the wall clock - no virtual
 * time anywhere. Case 3 is the control: offered one at a time, the same numbers
 * stay inside the allowance, so the setup is satisfiable and what fails is the
 * concurrency, not the configuration. Nothing here reaches a host outside
 * 127.0.0.0/8 or the local container (AC23).
 *
 * This file documents the behaviour. Fixing it is the implementer's job.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

import { createDatabase, initializeHistory } from "@deal-sentinel/db";
import {
  Governor,
  LIVE_TRANSPORT,
  createPostgresAllowanceStore,
  periodStartFor,
  systemClock,
  systemRandom,
} from "@deal-sentinel/governor";

import {
  buildGovernor,
  productRequests,
  recordingNotifier,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";
import { startLoopbackServer } from "../test/support/loopback-server.ts";
import type { LoopbackServer } from "../test/support/loopback-server.ts";
import {
  destroyPostgres,
  dockerCanRunContainers,
  startPostgres,
} from "../test/support/postgres-container.ts";
import type { PostgresContainer } from "../test/support/postgres-container.ts";
import { query } from "../test/support/seed.ts";

const PERIOD_MS = 3_600_000;

/** Loose enough that neither the ceiling nor the delay is what refuses anything. */
const HOST = {
  maxRequests: 1_000,
  intervalMs: 60_000,
  minDelayMs: 1,
  jitterMs: 1,
};

/** A breaker that can never trip, so the only gate under test is the allowance. */
const NO_BREAKER = {
  windowMs: 600_000,
  minimumOutcomes: 1_000_000,
  failureRateThreshold: 1,
  pauseMs: 1,
};

function config(hosts: string[], limit: number) {
  return testConfig({
    hosts: Object.fromEntries(hosts.map((host) => [host, HOST])),
    http: { requestTimeoutMs: 5_000 },
    robots: { cacheBoundMs: PERIOD_MS },
    breaker: NO_BREAKER,
    sources: {
      metered: {
        allowance: { limit, periodMs: PERIOD_MS, warnFraction: 1 },
      },
    },
  });
}

/** 127.0.0.0/8 is all loopback: a second address is a second host, same machine. */
function loopbackAddresses(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `127.0.0.${index + 1}`);
}

/**
 * One metered source, one request offered for each host at the same moment -
 * which is what an adapter with a page list does, and what AC4 says the governor
 * must serve rather than serialise.
 */
async function offerConcurrently(hosts: string[], limit: number) {
  const clock = new FakeClock();
  const transport = recordingTransport(clock, robotsAbsent(() => ({ status: 200 })));
  const { governor, allowanceStore, notifier } = buildGovernor({
    transport,
    config: config(hosts, limit),
    clock,
    random: sequenceRandom([0]),
  });

  const outcomes = await Promise.all(
    hosts.map((host) =>
      governor.request({ url: `http://${host}/listing`, sourceId: "metered" }),
    ),
  );

  const record = await allowanceStore.read(
    "metered",
    periodStartFor(clock.now(), PERIOD_MS),
  );

  return { transport, outcomes, record, notifier };
}

function describeSent(transport: {
  sent: readonly { url: string; at: number }[];
}): string[] {
  return transport.sent.map((request) => `${request.url}@${request.at}`);
}

describe("F17: the allowance is read at the boundary and spent one await later", () => {
  it("serves no more than the configured allowance for one period (AC19)", async () => {
    const limit = 3;
    const { transport, outcomes, record } = await offerConcurrently(
      ["127.0.0.1", "127.0.0.2"],
      limit,
    );

    console.log(
      "[two hosts, one metered source] allowance limit",
      limit,
      "; requests that left:",
      describeSent(transport),
      "; outcomes:",
      outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
      "; consumed recorded for the period:",
      record.consumed,
    );

    assert.equal(
      transport.sent.length <= limit,
      true,
      `${transport.sent.length} requests left the process for a metered source ` +
        `whose configured allowance for this period is ${limit}, and the ` +
        `durable counter now records ${record.consumed} against that limit. ` +
        "The last one left AFTER consumption had reached the allowance, which " +
        "AC19 says stops the source.",
    );
  });

  it("does not let the overspend grow with the number of hosts offered at once (AC19)", async () => {
    const limit = 2;
    const hosts = loopbackAddresses(5);
    const { transport, outcomes, record } = await offerConcurrently(hosts, limit);

    console.log(
      "[five hosts, one metered source] allowance limit",
      limit,
      "; requests that left:",
      describeSent(transport),
      "; outcomes:",
      outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
      "; consumed recorded for the period:",
      record.consumed,
    );

    assert.equal(
      transport.sent.length <= limit,
      true,
      `${transport.sent.length} requests left the process against an allowance ` +
        `of ${limit}: the overspend is bounded by how many hosts an adapter ` +
        "offers at once, not by the configured limit.",
    );
  });

  it("control: offered one after another, the same two hosts stay inside the allowance", async () => {
    const limit = 3;
    const clock = new FakeClock();
    const transport = recordingTransport(clock, robotsAbsent(() => ({ status: 200 })));
    const { governor } = buildGovernor({
      transport,
      config: config(["127.0.0.1", "127.0.0.2"], limit),
      clock,
      random: sequenceRandom([0]),
    });

    const first = await governor.request({
      url: "http://127.0.0.1/listing",
      sourceId: "metered",
    });
    const second = await governor.request({
      url: "http://127.0.0.2/listing",
      sourceId: "metered",
    });

    console.log(
      "[control: sequential] requests that left:",
      describeSent(transport),
      "; outcomes:",
      [first, second].map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
    );

    assert.equal(
      transport.sent.length <= limit,
      true,
      "the control itself is broken: the allowance was exceeded with no " +
        "concurrency at all, so these numbers are not a satisfiable setup",
    );
    assert.equal(
      productRequests(transport.sent).length,
      1,
      "the control expects the second host's page to be refused once the " +
        "allowance is reached",
    );
  });
});

/**
 * The same offer in the configuration this system ships: the durable counter in
 * PostgreSQL (ruling R5), the real HTTP transport, the wall clock, and stub
 * servers on four loopback addresses. Nothing is mocked and no virtual time is
 * involved, so what this case shows is not a property of the test harness.
 */
const DURABLE_LIMIT = 4;
const DURABLE_ADDRESSES = loopbackAddresses(6);

const dockerUsable = await dockerCanRunContainers();
const skip = dockerUsable
  ? false
  : "this machine's Docker cannot start a container, so the durable allowance " +
    "counter cannot be exercised against real PostgreSQL here";

let container: PostgresContainer;
const servers: LoopbackServer[] = [];

before(async () => {
  if (!dockerUsable) return;
  container = await startPostgres("governor-f17");
  const pool = new pg.Pool({ connectionString: container.url });
  try {
    await initializeHistory(pool, { note: "F17 allowance concurrency probe" });
  } finally {
    await pool.end();
  }

  for (const address of DURABLE_ADDRESSES) {
    servers.push(
      await startLoopbackServer((request, response) => {
        if ((request.url ?? "/").split("?")[0] === "/robots.txt") {
          response.writeHead(404);
          response.end("no rules");
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("a price would be here");
      }, address),
    );
  }
}, { timeout: 300_000 });

after(async () => {
  for (const server of servers) await server.close();
  if (container) await destroyPostgres(container);
}, { timeout: 120_000 });

describe("F17, against the durable store this system actually runs", { skip }, () => {
  it("spends no more than the configured allowance under a real database (AC19)", { timeout: 300_000 }, async () => {
    const pool = new pg.Pool({ connectionString: container.url });
    try {
      const governor = new Governor({
        config: config(DURABLE_ADDRESSES, DURABLE_LIMIT),
        clock: systemClock,
        random: systemRandom,
        // The real HTTP client, pointed at loopback like every other request in
        // this suite: through the ceiling, the delay and all six gates.
        transport: LIVE_TRANSPORT,
        notifier: recordingNotifier(),
        allowanceStore: createPostgresAllowanceStore(createDatabase(pool)),
      });

      const outcomes = await Promise.all(
        servers.map((server) =>
          governor.request({ url: `${server.origin}/listing`, sourceId: "metered" }),
        ),
      );

      const served = servers.flatMap((server, index) =>
        server.served.map((request) => `${DURABLE_ADDRESSES[index]}${request.path}`),
      );
      const rows = await query(
        container.url,
        "select consumed::text as consumed from governor_allowance_usage " +
          "where source_id = $1",
        ["metered"],
      );

      console.log(
        "[real database, real servers, real clock] allowance limit",
        DURABLE_LIMIT,
        "; requests the servers actually received:",
        served,
        "; outcomes:",
        outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
        "; consumed recorded in governor_allowance_usage:",
        rows.map((row) => row.consumed),
      );

      assert.equal(
        served.length <= DURABLE_LIMIT,
        true,
        `${served.length} requests reached a server for a metered source whose ` +
          `configured allowance is ${DURABLE_LIMIT}; the row in ` +
          `governor_allowance_usage records ${rows.map((row) => row.consumed).join(", ")}. ` +
          "No virtual clock and no in-memory store are involved in this case.",
      );
    } finally {
      await pool.end();
    }
  });
});
