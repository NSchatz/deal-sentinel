/**
 * Acceptance criterion 2 of spec S0042-deal-sentinel-ops-5:
 *
 *   THE SYSTEM SHALL classify each recorded fetch into exactly one of four
 *   classes, which SHALL be distinguishable in every query and view over the
 *   record: `success` (a usable response arrived), `error` (the request left
 *   this process and no usable response came back), `blocked` (the far side
 *   refused it - a 429, or a status that source's terms document as
 *   limit-exceeded), and `refused` (this system declined to send it, and the
 *   governor's own refusal reason is the condition). A latency is recorded for
 *   all four, measured from when the request was offered to when its outcome
 *   was known.
 *
 * Graded in two halves, because the criterion has two halves. The
 * classification itself is a pure function and is asserted directly, including
 * the cases that are one status apart and mean opposite things. The LATENCY and
 * the "exactly one of four" are asserted against the real `Governor`, driven to
 * each of the four outcomes with nothing stubbed but the transport and the
 * clock - because "measured from when the request was offered" is a claim about
 * where the measurement is taken, and no pure function can be asked about that.
 *
 * Nothing here reaches a network: the transport is a stub, and the source's
 * only host is the vendor's real hostname precisely so no request could go
 * anywhere useful even if one escaped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Governor, classifyFetchOutcome } from "../src/index.ts";
import type {
  Clock,
  FetchOutcomeRecord,
  FetchTelemetry,
  GovernorConfig,
  HttpTransport,
  TransportResponse,
} from "../src/index.ts";
import { createMemoryAllowanceStore } from "../src/allowance-store-memory.ts";

/* -------------------------------------------------------------------------- */
/* The pure classification                                                     */
/* -------------------------------------------------------------------------- */

describe("criterion 2: the four classes, and the boundaries between them", () => {
  it("calls a usable response a success, and gives it no condition", () => {
    for (const status of [200, 201, 204, 299]) {
      const classified = classifyFetchOutcome({ kind: "response", status });
      assert.equal(classified.outcomeClass, "success", `status ${status}`);
      assert.equal(classified.condition, null);
    }
  });

  it("calls a request that left with nothing usable back an error", () => {
    const classified = classifyFetchOutcome({
      kind: "transport-error",
      detail: "connection reset",
    });
    assert.equal(classified.outcomeClass, "error");
    assert.match(classified.condition ?? "", /connection reset/);
  });

  it("calls a 429 blocked for every source, terms or no terms", () => {
    // RFC 6585 section 4 defines 429 as too many requests in a given amount of
    // time. That is the far side refusing on rate whoever the far side is, so
    // no source has to have published anything for it to count.
    const classified = classifyFetchOutcome({ kind: "response", status: 429 }, []);
    assert.equal(classified.outcomeClass, "blocked");
    assert.match(classified.condition ?? "", /429/);
  });

  it("calls a status this source's OWN terms document as limit-exceeded blocked", () => {
    // The sanctioned API answers an exceeded limit with 403. 403 means
    // something else entirely at another vendor, which is why the statuses come
    // from the terms and not from a list in the governor.
    const withTerms = classifyFetchOutcome({ kind: "response", status: 403 }, [403]);
    assert.equal(withTerms.outcomeClass, "blocked");
    assert.match(withTerms.condition ?? "", /published terms/);
  });

  it("calls that SAME status an error for a source whose terms document nothing", () => {
    // The mutation that matters. If this returned `blocked`, the block rate -
    // which is the number this whole phase exists to make readable - would count
    // every ordinary forbidden response at every source as a rate limit, and an
    // operator tuning a politeness ceiling would be tuning against noise.
    const withoutTerms = classifyFetchOutcome({ kind: "response", status: 403 }, []);
    assert.equal(withoutTerms.outcomeClass, "error");
    assert.doesNotMatch(withoutTerms.condition ?? "", /limit was exceeded/);
  });

  it("calls anything this system declined to send refused, with the reason as the condition", () => {
    const classified = classifyFetchOutcome({
      kind: "refused",
      reason: "robots-disallowed",
      detail: "the host's robots.txt disallows this path",
    });
    assert.equal(classified.outcomeClass, "refused");
    assert.match(classified.condition ?? "", /^robots-disallowed:/);
    assert.match(classified.condition ?? "", /disallows this path/);
  });

  it("puts every outcome in exactly one of the four and never in none", () => {
    const outcomes = [
      { kind: "response", status: 200 } as const,
      { kind: "response", status: 404 } as const,
      { kind: "response", status: 429 } as const,
      { kind: "response", status: 500 } as const,
      { kind: "transport-error", detail: "timed out" } as const,
      { kind: "refused", reason: "source-paused", detail: "paused" } as const,
      { kind: "refused", reason: "allowance-exhausted", detail: "spent" } as const,
    ];
    const classes = new Set(
      outcomes.map((outcome) => classifyFetchOutcome(outcome, [403]).outcomeClass),
    );
    for (const outcomeClass of classes) {
      assert.ok(
        ["success", "error", "blocked", "refused"].includes(outcomeClass),
        `${outcomeClass} is not one of the four`,
      );
    }
    // And all four are reachable, which is what makes "distinguishable" mean
    // anything: a classifier that answered "error" to everything would satisfy
    // the sentence above and nothing else.
    assert.deepEqual(
      [...classes].sort(),
      ["blocked", "error", "refused", "success"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The latency, measured where the criterion says                              */
/* -------------------------------------------------------------------------- */

class SteppingClock implements Clock {
  #now: number;
  readonly #step: number;

  constructor(start: number, step: number) {
    this.#now = start;
    this.#step = step;
  }

  now(): number {
    const reading = this.#now;
    this.#now += this.#step;
    return reading;
  }

  async sleep(ms: number): Promise<void> {
    this.#now += ms;
  }
}

function config(overrides: Partial<GovernorConfig> = {}): GovernorConfig {
  return {
    userAgent: "deal-sentinel-test/0.0 (+nothing leaves)",
    http: { requestTimeoutMs: 2000, maxResponseBytes: 1_048_576 },
    hosts: {
      "api.bestbuy.com": {
        maxRequests: 100,
        intervalMs: 60_000,
        minDelayMs: 1,
        jitterMs: 1,
      },
    },
    robots: {
      productToken: "deal-sentinel",
      cacheBoundMs: 3_600_000,
      parsingLimitBytes: 512_000,
    },
    backPressure: { defaultBackoffMs: 300_000 },
    breaker: {
      windowMs: 600_000,
      minimumOutcomes: 4,
      failureRateThreshold: 0.5,
      pauseMs: 1_800_000,
    },
    sources: { "bestbuy-api": {} },
    ...overrides,
  };
}

function stubTransport(
  answer: (url: string) => Partial<TransportResponse> | Error,
): HttpTransport {
  return {
    async send(request) {
      const given = answer(request.url);
      if (given instanceof Error) throw given;
      return {
        status: given.status ?? 200,
        headers: given.headers ?? {},
        body: given.body ?? "",
        truncated: false,
      };
    },
  };
}

function recorder(): FetchTelemetry & { readonly rows: FetchOutcomeRecord[] } {
  const rows: FetchOutcomeRecord[] = [];
  return {
    rows,
    record(row) {
      rows.push(row);
    },
    limitExceededStatusesFor() {
      return [403];
    },
  };
}

async function offerOnce(
  answer: (url: string) => Partial<TransportResponse> | Error,
  overrides: Partial<GovernorConfig> = {},
): Promise<FetchOutcomeRecord[]> {
  const telemetry = recorder();
  const governor = new Governor({
    config: config(overrides),
    clock: new SteppingClock(1_700_000_000_000, 7),
    random: () => 0.5,
    transport: stubTransport(answer),
    notifier: { notify() {} },
    allowanceStore: createMemoryAllowanceStore(),
    telemetry,
  });

  await governor.request({
    url: "https://api.bestbuy.com/v1/products/8880044.json",
    sourceId: "bestbuy-api",
  });
  return telemetry.rows;
}

describe("criterion 2: a latency is recorded for all four classes", () => {
  it("records exactly one row per offered fetch, with a latency and an instant", async () => {
    const rows = await offerOnce((url) =>
      url.endsWith("/robots.txt") ? { status: 404 } : { status: 200, body: "{}" },
    );
    // ONE row for the offered fetch. The governor's own `/robots.txt`
    // retrieval is not an offered fetch: nobody asked for it, and counting it
    // would mean a source's success rate moved when a robots cache expired.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeClass, "success");
    assert.ok(Number.isInteger(rows[0].latencyMs));
    assert.ok(rows[0].latencyMs >= 0);
    assert.ok(rows[0].occurredAt instanceof Date);
  });

  it("records one for a blocked outcome", async () => {
    const rows = await offerOnce((url) =>
      url.endsWith("/robots.txt") ? { status: 404 } : { status: 403, body: "no" },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeClass, "blocked");
    assert.ok(Number.isInteger(rows[0].latencyMs));
  });

  it("records one for an error outcome, where the request left and nothing came back", async () => {
    const rows = await offerOnce((url) =>
      url.endsWith("/robots.txt")
        ? { status: 404 }
        : new Error("socket hang up"),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeClass, "error");
    assert.match(rows[0].condition ?? "", /socket hang up/);
    assert.ok(Number.isInteger(rows[0].latencyMs));
  });

  it("records one for a refusal, carrying the governor's own reason", async () => {
    // Gate 1: no configured ceiling for this host. Nothing leaves the process.
    const telemetry = recorder();
    const governor = new Governor({
      config: config(),
      clock: new SteppingClock(1_700_000_000_000, 11),
      random: () => 0.5,
      transport: stubTransport(() => ({ status: 200 })),
      notifier: { notify() {} },
      allowanceStore: createMemoryAllowanceStore(),
      telemetry,
    });

    const outcome = await governor.request({
      url: "https://nobody-configured-this.invalid/thing",
      sourceId: "bestbuy-api",
    });

    assert.equal(outcome.ok, false);
    assert.equal(telemetry.rows.length, 1);
    assert.equal(telemetry.rows[0].outcomeClass, "refused");
    assert.match(telemetry.rows[0].condition ?? "", /^unconfigured-host:/);
    assert.ok(Number.isInteger(telemetry.rows[0].latencyMs));
  });

  it("measures the latency from the OFFER and not from the send", async () => {
    // The clock advances on every reading, and gate 6's wait advances it
    // further. A latency measured at the send would be small and roughly
    // constant; one measured from the offer carries the whole wait. The
    // configuration below puts a full second of minimum delay in front of the
    // request, so the two answers cannot be confused.
    const rows = await offerOnce(
      (url) => (url.endsWith("/robots.txt") ? { status: 404 } : { status: 200 }),
      {
        hosts: {
          "api.bestbuy.com": {
            maxRequests: 100,
            intervalMs: 60_000,
            minDelayMs: 1_000,
            jitterMs: 1,
          },
        },
      },
    );
    assert.equal(rows.length, 1);
    assert.ok(
      rows[0].latencyMs >= 1_000,
      `latency was ${rows[0].latencyMs}ms, which is less than the configured ` +
        "minimum delay this request waited through - so it was measured after " +
        "the wait rather than from the offer",
    );
  });
});

describe("criterion 2: a governor with no telemetry behaves exactly as before", () => {
  it("records nothing and still answers", async () => {
    const governor = new Governor({
      config: config(),
      clock: new SteppingClock(1_700_000_000_000, 7),
      random: () => 0.5,
      transport: stubTransport((url) =>
        url.endsWith("/robots.txt") ? { status: 404 } : { status: 200, body: "{}" },
      ),
      notifier: { notify() {} },
      allowanceStore: createMemoryAllowanceStore(),
    });

    const outcome = await governor.request({
      url: "https://api.bestbuy.com/v1/products/8880044.json",
      sourceId: "bestbuy-api",
    });
    assert.equal(outcome.ok, true);
  });
});
