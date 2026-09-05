/**
 * regress_0023_probe_ordinal8_f15 - impl-gate ordinal 8, spec
 * S0023-deal-sentinel-governor-2. Written by the refuter.
 *
 * A PROBE, not a finding. `tests/regress_0023_F15.ts` cases 1 and 2 are RED at
 * `1c2d348`, and `gate-state.json` records F15 resolved at ordinal 7. Those two
 * facts have to be reconciled by evidence rather than by the implementer's
 * declaration, so this file re-runs F15's exact stub and configuration and asks
 * the criterion's own question instead of the artifact's setup guard:
 *
 *   AC10 (spec.md, verbatim): WHEN a host's cached robots decision is older
 *   than the configured cache bound, which SHALL NOT be configurable above 24
 *   hours, THE SYSTEM SHALL re-retrieve `robots.txt` before the next fetch to
 *   that host; within the bound it SHALL NOT re-retrieve it.
 *
 * F15's stub answers its THIRD and later `/robots.txt` with `Disallow: /b`. So
 * an implementation that obeys AC10 re-retrieves, reads that rule, and REFUSES
 * `/b` - which makes the artifact's own line 181 guard ("nothing refused these
 * before the send") unsatisfiable for any correct implementation, and makes its
 * line 252 message dereference a `/b` request that correctly does not exist.
 * The assertions BELOW are the criterion; nothing here is a setup guard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildGovernor,
  productRequests,
  recordingTransport,
  testConfig,
} from "../test/support/governor-harness.ts";
import type { SentRequest } from "../test/support/governor-harness.ts";
import { FakeClock, sequenceRandom } from "../test/support/fake-clock.ts";

/** Read off config/governor.json, exactly as F15 reads them. */
const SHIPPED_CACHE_BOUND_MS = 21_600_000;
const SHIPPED_BACKOFF_MS = 900_000;
const SHIPPED_HOST = { maxRequests: 240, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 };
const SEVEN_HOURS_MS = 7 * 3_600_000;

const ALLOW_EVERYTHING = "User-agent: *\nAllow: /\n";
const DISALLOW_B = "User-agent: *\nDisallow: /b\n";
const NO_BREAKER = {
  windowMs: 600_000,
  minimumOutcomes: 1_000_000,
  failureRateThreshold: 1,
  pauseMs: 1,
};

function robotsRequests(sent: readonly SentRequest[]): SentRequest[] {
  return sent.filter((request) => new URL(request.url).pathname === "/robots.txt");
}

function decisionAgeAt(sent: readonly SentRequest[], request: SentRequest): number | null {
  const asked = robotsRequests(sent).filter((robots) => robots.at <= request.at);
  if (asked.length === 0) return null;
  return request.at - asked[asked.length - 1].at;
}

/** F15's stub, character for character in behaviour. */
function hostThatHoldsThenAddsARule() {
  let robotsServed = 0;
  let pagesServed = 0;
  return {
    robotsServed: () => robotsServed,
    respond(request: { url: string }) {
      if (new URL(request.url).pathname === "/robots.txt") {
        robotsServed += 1;
        if (robotsServed === 1) return { status: 200, body: ALLOW_EVERYTHING };
        if (robotsServed === 2) {
          return {
            status: 429,
            headers: { "retry-after": String(SEVEN_HOURS_MS / 1000) },
            body: "still busy, come back in seven hours",
          };
        }
        return { status: 200, body: DISALLOW_B };
      }
      pagesServed += 1;
      if (pagesServed === 1) {
        return { status: 503, headers: { "retry-after": String(SEVEN_HOURS_MS / 1000) }, body: "" };
      }
      return { status: 200, body: "a price would be here" };
    },
  };
}

describe("probe G: F15's own scenario, asked AC10's question", () => {
  it("nothing leaves under a decision older than the shipped cache bound", async () => {
    const clock = new FakeClock();
    const host = hostThatHoldsThenAddsARule();
    const transport = recordingTransport(clock, (request) => host.respond(request));
    const { governor } = buildGovernor({
      transport,
      config: testConfig({
        hosts: { "127.0.0.1": SHIPPED_HOST },
        robots: { cacheBoundMs: SHIPPED_CACHE_BOUND_MS },
        backPressure: { defaultBackoffMs: SHIPPED_BACKOFF_MS },
        breaker: NO_BREAKER,
        sources: { "test-source": {} },
      }),
      clock,
      random: sequenceRandom([0]),
    });

    const outcomes = await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );

    const left = productRequests(transport.sent);
    const stale = left.filter((request) => {
      const age = decisionAgeAt(transport.sent, request);
      return age !== null && age > SHIPPED_CACHE_BOUND_MS;
    });
    const b = left.find((request) => new URL(request.url).pathname === "/b");

    console.log(
      "[G1] outcomes:", outcomes.map((outcome) => (outcome.ok ? "ok" : outcome.reason)),
      "; everything that left:", transport.sent.map((r) => `${new URL(r.url).pathname}@${r.at}`),
      "; robots retrievals:", host.robotsServed(),
      "; ages at the wire:",
      left.map((r) => `${new URL(r.url).pathname}=${decisionAgeAt(transport.sent, r)}ms`),
    );

    // THE CRITERION. Not "nothing was refused" - a refusal is a lawful way to
    // discharge AC10, and the artifact's guard forbidding one is what is wrong.
    assert.deepEqual(
      stale.map((r) => `${new URL(r.url).pathname}@${r.at}`),
      [],
      "a request left under a robots decision older than the configured bound",
    );

    // The rule the host added while it was holding us off was ASKED FOR, and
    // obeyed: /b is exactly what retrieval 3 disallows, and /b did not leave.
    assert.equal(
      host.robotsServed() >= 3,
      true,
      "the governor never went back for the host's current rules",
    );
    assert.equal(
      b,
      undefined,
      "/b left for a host whose current robots.txt disallows that path",
    );
    assert.equal(
      outcomes.some((outcome) => !outcome.ok && outcome.reason === "robots-disallowed"),
      true,
      "the disallow the host added was not the reason /b was withheld",
    );
  });

  it("the artifact's own line 181 guard is unsatisfiable for a correct implementation", async () => {
    // Stated as an executable claim rather than as prose: the stub disallows /b
    // from retrieval 3, and AC10 compels retrieval 3, so a conforming governor
    // MUST refuse - which is precisely what the guard forbids.
    const clock = new FakeClock();
    const host = hostThatHoldsThenAddsARule();
    const transport = recordingTransport(clock, (request) => host.respond(request));
    const { governor } = buildGovernor({
      transport,
      config: testConfig({
        hosts: { "127.0.0.1": SHIPPED_HOST },
        robots: { cacheBoundMs: SHIPPED_CACHE_BOUND_MS },
        backPressure: { defaultBackoffMs: SHIPPED_BACKOFF_MS },
        breaker: NO_BREAKER,
        sources: { "test-source": {} },
      }),
      clock,
      random: sequenceRandom([0]),
    });

    const outcomes = await Promise.all(
      ["/a", "/b"].map((path) =>
        governor.request({ url: `http://127.0.0.1${path}`, sourceId: "test-source" }),
      ),
    );
    const refusedFor = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));
    console.log("[G2] the guard expects [] and the criterion produces:", refusedFor);
    assert.deepEqual(refusedFor, ["robots-disallowed"]);
  });
});
