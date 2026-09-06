/**
 * Acceptance criterion 7 of spec S0042-deal-sentinel-ops-5:
 *
 *   THE SYSTEM SHALL record no credential, no query string carrying one, and no
 *   response body: WHEN a condition string derived from a URL or a vendor
 *   response is recorded THE SYSTEM SHALL record it with the same redaction the
 *   rest of this repository applies, so neither the secret nor the value of the
 *   parameter that carries it appears in the stored row.
 *
 * The credential travels in this vendor's query string - its own documented call
 * is `.../products/8880044.json?show=...&apiKey=YourAPIKey` - so the URL is
 * inside the request, inside the transport error message that quotes it, inside
 * the governor refusal that names it, and inside the vendor's own response body
 * as `canonicalUrl`. Every one of those is a source of a recorded condition.
 *
 * GRADED THROUGH THE REAL CHOKEPOINT with nothing stubbed but the transport, and
 * against the WRITE the sink was handed: asserting that a redactor redacts is
 * not the criterion. The criterion is that no path from an outcome to a stored
 * row can carry a key.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Governor, createMemoryAllowanceStore } from "@deal-sentinel/governor";
import type {
  Clock,
  GovernorConfig,
  HttpTransport,
  TransportResponse,
} from "@deal-sentinel/governor";
import { memoryBreakerPauses, memoryFetchOutcomes } from "@deal-sentinel/db";
import type { FetchOutcomeEntry } from "@deal-sentinel/db";

import { CREDENTIAL_PLACEHOLDER } from "../src/credential.ts";
import { validateSourceRegistry } from "../src/registry.ts";
import type { SourceRegistry } from "../src/registry.ts";
import { displayRedactor, redactedTelemetry } from "../src/telemetry.ts";

/** Conspicuous on purpose: a suite that searches for a key never in play asserts nothing. */
const SECRET = "fixture-api-key-do-not-use";
const CREDENTIAL_VARIABLE = "BESTBUY_API_KEY";
const HOST = "api.bestbuy.com";

function registry(): SourceRegistry {
  return validateSourceRegistry(
    {
      sources: {
        "bestbuy-api": {
          baseUrl: `https://${HOST}/v1`,
          currency: "USD",
          timeZone: "America/New_York",
          rawContextRetentionHours: 24,
          credentialVariable: CREDENTIAL_VARIABLE,
        },
      },
    },
    "the test source configuration",
  );
}

/**
 * Virtual time. `sleep` ADVANCES it, because the host scheduler waits on this
 * clock and a clock that never moves is a wait that never ends.
 */
function advancingClock(): Clock {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
}

function config(): GovernorConfig {
  return {
    userAgent: "deal-sentinel-test/0.0 (+nothing leaves)",
    http: { requestTimeoutMs: 2000, maxResponseBytes: 1_048_576 },
    hosts: {
      [HOST]: { maxRequests: 100, intervalMs: 60_000, minDelayMs: 1, jitterMs: 1 },
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
  };
}

function transport(
  answer: (url: string) => Partial<TransportResponse> | Error,
): HttpTransport {
  return {
    async send(request) {
      const given = answer(request.url);
      if (given instanceof Error) throw given;
      return {
        status: given.status ?? 200,
        headers: {},
        body: given.body ?? "",
        truncated: false,
      };
    },
  };
}

/** The credentialled URL this adapter would really build. */
const CREDENTIALLED_URL =
  `https://${HOST}/v1/products/8880044.json` +
  `?show=sku,name,salePrice&apiKey=${SECRET}`;

async function recordThrough(
  answer: (url: string) => Partial<TransportResponse> | Error,
  url = CREDENTIALLED_URL,
): Promise<FetchOutcomeEntry[]> {
  const store = memoryFetchOutcomes();
  const governor = new Governor({
    config: config(),
    clock: advancingClock(),
    random: () => 0.5,
    transport: transport(answer),
    notifier: { notify() {} },
    allowanceStore: createMemoryAllowanceStore(),
    telemetry: redactedTelemetry({
      outcomes: store,
      pauses: memoryBreakerPauses(),
      registry: registry(),
      redactor: displayRedactor(registry(), { [CREDENTIAL_VARIABLE]: SECRET }),
    }),
  });

  await governor.request({ url, sourceId: "bestbuy-api" });
  return store.recorded;
}

function assertClean(condition: string | null, what: string): void {
  assert.ok(condition !== null, `${what} recorded no condition to check`);
  assert.ok(
    !condition.includes(SECRET),
    `${what} recorded the credential itself: ${condition}`,
  );
  assert.ok(
    !/apiKey=(?!\[redacted])/i.test(condition),
    `${what} recorded the value of the parameter carrying the credential: ${condition}`,
  );
}

describe("criterion 7: a recorded condition carries no credential", () => {
  it("redacts the URL a transport error quotes", async () => {
    // The governor's transport-error detail is `${url.href} could not be
    // reached: ...`, and that href carries the key.
    const rows = await recordThrough((url) =>
      url.endsWith("/robots.txt") ? { status: 404 } : new Error("socket hang up"),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeClass, "error");
    assertClean(rows[0].condition, "a transport error");
    assert.match(rows[0].condition ?? "", new RegExp(`apiKey=\\${"["}redacted]`));
  });

  it("redacts the URL a governor refusal names", async () => {
    // Gate 1 refuses an unconfigured host and quotes the URL it would not
    // fetch. Nothing left the process; the key was still in the sentence.
    const rows = await recordThrough(
      () => ({ status: 200 }),
      `https://not-configured.invalid/v1/products/1.json?apiKey=${SECRET}`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcomeClass, "refused");
    assertClean(rows[0].condition, "a governor refusal");
  });

  it("redacts a secret echoed back by any name at all", () => {
    // The rule that survives the vendor putting the key somewhere nobody
    // predicted: this one echoes the whole request URL back inside its own
    // response body as `canonicalUrl`, and a future vendor will pick a
    // different key. The secret itself is replaced wherever it appears.
    const redactor = displayRedactor(registry(), { [CREDENTIAL_VARIABLE]: SECRET });
    const echoed = `{"canonicalUrl":"/v1/products/1.json?apiKey=${SECRET}","note":"${SECRET}"}`;
    const scrubbed = redactor.scrub(echoed);
    assert.ok(!scrubbed.includes(SECRET), scrubbed);
    assert.equal(scrubbed.includes(CREDENTIAL_PLACEHOLDER), true);
  });

  it("still redacts the parameter when this process holds no credential at all", () => {
    // The half that matters for a read-only display process, which has no key
    // in its environment. A rotated key, a second key, or a row written by an
    // older build is still a row with a query string in it.
    const redactor = displayRedactor(registry(), {});
    const scrubbed = redactor.scrub(
      `https://${HOST}/v1/products/1.json?apiKey=some-other-key-entirely`,
    );
    assert.ok(!scrubbed.includes("some-other-key-entirely"), scrubbed);
  });

  it("would FAIL against a sink that skipped the redaction", async () => {
    // The mutation. `redactedTelemetry` is what stands between a condition and
    // a stored row; a sink that wrote the condition straight through records
    // the key, and this assertion is what would catch it.
    const store = memoryFetchOutcomes();
    const governor = new Governor({
      config: config(),
      clock: advancingClock(),
      random: () => 0.5,
      transport: transport((url) =>
        url.endsWith("/robots.txt") ? { status: 404 } : new Error("socket hang up"),
      ),
      notifier: { notify() {} },
      allowanceStore: createMemoryAllowanceStore(),
      // Deliberately NOT `redactedTelemetry`: the raw port, writing through.
      telemetry: { record: (row) => store.record(row) },
    });

    await governor.request({ url: CREDENTIALLED_URL, sourceId: "bestbuy-api" });

    assert.equal(store.recorded.length, 1);
    assert.ok(
      store.recorded[0].condition?.includes(SECRET),
      "the unredacted sink did NOT record the credential, so this suite is " +
        "not exercising the path the redaction protects",
    );
    assert.throws(() => {
      assertClean(store.recorded[0].condition, "the unredacted sink");
    });
  });
});

describe("criterion 7: a recorded pause condition carries no credential either", () => {
  it("scrubs the pause condition on its way to the store", async () => {
    const pauses = memoryBreakerPauses();
    const telemetry = redactedTelemetry({
      outcomes: memoryFetchOutcomes(),
      pauses,
      registry: registry(),
      redactor: displayRedactor(registry(), { [CREDENTIAL_VARIABLE]: SECRET }),
    });

    await telemetry.recordPause?.({
      sourceId: "bestbuy-api",
      pausedAt: new Date(1_700_000_000_000),
      expiresAt: new Date(1_700_000_060_000),
      failingCount: 3,
      windowOutcomes: 4,
      windowMs: 600_000,
      failureRateThreshold: "0.5",
      condition: `three of four failed, last was ${CREDENTIALLED_URL}`,
    });

    assert.equal(pauses.recorded.length, 1);
    assertClean(pauses.recorded[0].condition, "a pause condition");
  });
});
