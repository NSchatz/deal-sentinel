/**
 * Acceptance criteria 5 and 6 of spec S0023-deal-sentinel-governor-2:
 *
 *   AC5 IF a request is offered for a host that has no configured ceiling THEN
 *       THE SYSTEM SHALL refuse that request and SHALL NOT fall back to an
 *       unbounded or default-permissive rate.
 *   AC6 IF the governor's configuration is absent, unparseable, or missing a
 *       required value THEN THE SYSTEM SHALL refuse to start, naming the
 *       missing or invalid key, rather than start on built-in defaults.
 *
 * CLAUDE.md rule 8 is the reason both exist: "Rate ceilings, thresholds and
 * cooldowns must exist, be conservative, and be configurable. The brief
 * deliberately fixes no numbers; do not invent one and then treat it as
 * decided." A built-in default is exactly an invented number treated as
 * decided, with the decision hidden.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  GovernorConfigError,
  ROBOTS_CACHE_BOUND_CEILING_MS,
  ROBOTS_PARSING_LIMIT_FLOOR_BYTES,
  loadGovernorConfig,
  parseGovernorConfig,
  validateGovernorConfig,
} from "@deal-sentinel/governor";

import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const COMMITTED_CONFIG = fileURLToPath(
  new URL("../../config/governor.json", import.meta.url),
);

/** A complete configuration document, as JSON, that a case can then break. */
function completeDocument(): Record<string, unknown> {
  return {
    userAgent: "deal-sentinel-test/0.0",
    http: { requestTimeoutMs: 15_000, maxResponseBytes: 1_048_576 },
    hosts: {
      "127.0.0.1": {
        maxRequests: 10,
        intervalMs: 60_000,
        minDelayMs: 1_000,
        jitterMs: 500,
      },
    },
    robots: {
      productToken: "deal-sentinel",
      cacheBoundMs: 3_600_000,
      parsingLimitBytes: ROBOTS_PARSING_LIMIT_FLOOR_BYTES,
    },
    backPressure: { defaultBackoffMs: 300_000 },
    breaker: {
      windowMs: 600_000,
      minimumOutcomes: 5,
      failureRateThreshold: 0.5,
      pauseMs: 1_800_000,
    },
    sources: { "test-source": {} },
  };
}

/** Run something that must refuse, and hand back the refusal it made. */
function caught(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof GovernorConfigError,
      `expected a GovernorConfigError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected a refusal, and nothing was thrown");
}

function refusal(mutate: (document: Record<string, unknown>) => void): Error {
  const document = completeDocument();
  mutate(document);
  return caught(() => validateGovernorConfig(document, "the test configuration"));
}

describe("a request for a host with no configured ceiling is refused", () => {
  it("refuses rather than falling back to any rate at all", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: testConfig({
        hosts: {
          "127.0.0.1": {
            maxRequests: 10,
            intervalMs: 60_000,
            minDelayMs: 1_000,
            jitterMs: 500,
          },
        },
      }),
    });

    const outcome = await governor.request({
      url: "http://127.0.0.9:8080/listing/1",
      sourceId: "test-source",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "unconfigured-host");
    assert.match(outcome.detail, /no configured request ceiling/);
    assert.match(outcome.detail, /there is no default rate to fall back to/);
    // Refused, not slowed: nothing left and no time passed waiting to send it.
    assert.equal(transport.sent.length, 0);
    assert.equal(clock.now(), 0);
  });

  it("refuses a source the configuration has never heard of", async () => {
    const clock = new FakeClock(0);
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({ transport, clock, config: testConfig() });

    const outcome = await governor.request({
      url: "http://127.0.0.1:8080/listing/1",
      sourceId: "a-source-nobody-configured",
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "unknown-source");
    assert.equal(transport.sent.length, 0);
  });
});

describe("an incomplete configuration refuses to start and says which key", () => {
  it("refuses when the file is absent, naming the path", () => {
    const error = caught(() => loadGovernorConfig("/nonexistent/governor.json"));
    assert.match(error.message, /\/nonexistent\/governor\.json/);
    assert.match(error.message, /refuses to start/);
  });

  it("refuses when the file is not parseable, naming the file", () => {
    const error = caught(() =>
      parseGovernorConfig("{ this is not json", "config/governor.json"),
    );
    assert.match(error.message, /config\/governor\.json is not parseable as JSON/);
  });

  for (const key of [
    "userAgent",
    "http",
    "hosts",
    "robots",
    "backPressure",
    "breaker",
    "sources",
  ]) {
    it(`refuses when "${key}" is missing, naming it`, () => {
      const error = refusal((document) => {
        delete document[key];
      });
      assert.match(error.message, new RegExp(`"${key}"`));
    });
  }

  it("names a nested key, not just the section it is in", () => {
    const error = refusal((document) => {
      delete (document.hosts as Record<string, Record<string, unknown>>)["127.0.0.1"]
        .minDelayMs;
    });
    assert.match(error.message, /minDelayMs/);
  });

  it("names a key whose value is the wrong type", () => {
    const error = refusal((document) => {
      (document.http as Record<string, unknown>).requestTimeoutMs = "fifteen seconds";
    });
    assert.match(error.message, /http\.requestTimeoutMs must be a whole number/);
  });

  it("refuses a key nothing reads, because a typo that changes nothing is a silent default", () => {
    const error = refusal((document) => {
      (document.breaker as Record<string, unknown>).pauseMinutes = 30;
    });
    assert.match(error.message, /breaker\.pauseMinutes/);
  });

  it("refuses an empty host map, which would refuse every request", () => {
    const error = refusal((document) => {
      document.hosts = {};
    });
    assert.match(error.message, /no entries under "hosts"/);
  });

  it("refuses an empty source map", () => {
    const error = refusal((document) => {
      document.sources = {};
    });
    assert.match(error.message, /no entries under "sources"/);
  });

  it("refuses a delay or a jitter of zero: a constant delay is not a randomised one", () => {
    for (const key of ["minDelayMs", "jitterMs"]) {
      const error = refusal((document) => {
        (document.hosts as Record<string, Record<string, unknown>>)["127.0.0.1"][key] = 0;
      });
      assert.match(error.message, new RegExp(`${key} must be at least 1`));
    }
  });

  it("refuses a warn fraction or a failure rate outside (0, 1]", () => {
    const error = refusal((document) => {
      (document.breaker as Record<string, unknown>).failureRateThreshold = 1.5;
    });
    assert.match(error.message, /failureRateThreshold must be a fraction/);
  });
});

describe("two bounds a standard fixes, which configuration may not cross", () => {
  it("refuses a robots cache bound above 24 hours (RFC 9309 2.4)", () => {
    const error = refusal((document) => {
      (document.robots as Record<string, unknown>).cacheBoundMs =
        ROBOTS_CACHE_BOUND_CEILING_MS + 1;
    });
    assert.match(error.message, /must be at most 86400000/);
    assert.match(error.message, /24 hours/);
  });

  it("accepts exactly 24 hours", () => {
    const document = completeDocument();
    (document.robots as Record<string, unknown>).cacheBoundMs =
      ROBOTS_CACHE_BOUND_CEILING_MS;
    const config = validateGovernorConfig(document, "the test configuration");
    assert.equal(config.robots.cacheBoundMs, ROBOTS_CACHE_BOUND_CEILING_MS);
  });

  it("refuses a parsing limit below 500 kibibytes (RFC 9309 2.5)", () => {
    const error = refusal((document) => {
      (document.robots as Record<string, unknown>).parsingLimitBytes =
        ROBOTS_PARSING_LIMIT_FLOOR_BYTES - 1;
    });
    assert.match(error.message, /must be at least 512000/);
    assert.match(error.message, /500 kibibytes/);
  });

  it("knows 500 kibibytes is 512000 bytes", () => {
    assert.equal(ROBOTS_PARSING_LIMIT_FLOOR_BYTES, 512_000);
    assert.equal(ROBOTS_CACHE_BOUND_CEILING_MS, 86_400_000);
  });
});

/**
 * A relationship between two values rather than a bound on either, and it is
 * enforced for the same reason every other refusal here is: a governor that
 * cannot obey its own rules must say so at start rather than discover it at the
 * wire.
 *
 * The governor fetches a host's `robots.txt` through that host's own minimum
 * delay - the file that says how polite to be is fetched politely - so the page
 * behind a retrieval leaves at least `minDelayMs` after the decision that
 * permitted it. Where `minDelayMs` is already at least `robots.cacheBoundMs`,
 * EVERY fetch to that host would leave under a decision this system has already
 * declared expired, and no ordering of the gates rescues it.
 */
describe("a delay that outlives the robots decision it waits under is refused", () => {
  it("refuses a host whose minDelayMs is not less than robots.cacheBoundMs", () => {
    const error = refusal((document) => {
      (document.robots as Record<string, unknown>).cacheBoundMs = 2_000;
      (
        (document.hosts as Record<string, Record<string, unknown>>)["127.0.0.1"]
      ).minDelayMs = 5_000;
    });
    assert.match(error.message, /hosts\["127\.0\.0\.1"\]\.minDelayMs is 5000/);
    assert.match(error.message, /robots\.cacheBoundMs \(2000\)/);
  });

  it("refuses the two being exactly equal, because equal is already too long", () => {
    const error = refusal((document) => {
      (document.robots as Record<string, unknown>).cacheBoundMs = 5_000;
      (
        (document.hosts as Record<string, Record<string, unknown>>)["127.0.0.1"]
      ).minDelayMs = 5_000;
    });
    assert.match(error.message, /not less than robots\.cacheBoundMs/);
  });

  it("accepts a delay one millisecond inside the bound", () => {
    const document = completeDocument();
    (document.robots as Record<string, unknown>).cacheBoundMs = 5_000;
    ((document.hosts as Record<string, Record<string, unknown>>)["127.0.0.1"]).minDelayMs =
      4_999;
    const config = validateGovernorConfig(document, "the test configuration");
    assert.equal(config.hosts["127.0.0.1"].minDelayMs, 4_999);
  });

  it("holds on the committed file, whose delay is one millisecond", () => {
    const config = loadGovernorConfig(COMMITTED_CONFIG);
    for (const [name, ceiling] of Object.entries(config.hosts)) {
      assert.ok(
        ceiling.minDelayMs < config.robots.cacheBoundMs,
        `hosts["${name}"] would fetch under an expired robots decision`,
      );
    }
  });
});

describe("the committed default configuration", () => {
  it("loads, so the file this repository ships is not the one that refuses", () => {
    const config = loadGovernorConfig(COMMITTED_CONFIG);
    assert.ok(Object.keys(config.hosts).length >= 1);
    assert.ok(Object.keys(config.sources).length >= 1);
    assert.ok(config.robots.cacheBoundMs <= ROBOTS_CACHE_BOUND_CEILING_MS);
    assert.ok(config.robots.parsingLimitBytes >= ROBOTS_PARSING_LIMIT_FLOOR_BYTES);
  });

  it("says in the file that its numbers are unvalidated (CLAUDE.md rule 8)", () => {
    const text = readFileSync(COMMITTED_CONFIG, "utf8");
    assert.match(text, /CONSERVATIVE AND UNVALIDATED/);
    assert.match(text, /BRIEF\.md deliberately fixes no rate ceiling/);
  });

  it("hard-codes no metered allowance for a source this phase cannot measure", () => {
    // The spec's manifest carries a real vendor's published allowance as a
    // worked example and says no number from it is hard-coded by this phase.
    const config = loadGovernorConfig(COMMITTED_CONFIG);
    const metered = Object.entries(config.sources).filter(
      ([, settings]) => settings.allowance !== undefined,
    );
    assert.deepEqual(metered, []);
  });
});
