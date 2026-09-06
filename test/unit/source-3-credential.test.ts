/**
 * Acceptance criteria 16 and 17 of spec S0033-deal-sentinel-source-3:
 *
 *  16. WHEN the vendor credential is used for a request THE SYSTEM SHALL keep
 *      it out of stored raw content, out of every notification body, and out of
 *      every log line the system writes, including the ones written on failure.
 *  17. IF the vendor credential is absent or empty where the system reads it
 *      from THEN THE SYSTEM SHALL refuse to run that source and say so, rather
 *      than issue an unauthenticated request.
 *
 * The credential is the one thing in this repository that no re-run undoes. So
 * criterion 16 is graded on the paths where a secret actually escapes, and each
 * of those is exercised with a credential the assertions can search the whole
 * output for:
 *
 *   - the STORED raw content, against a payload that echoes the request URL
 *     back inside itself, which is what this vendor really does
 *     (`canonicalUrl`);
 *   - every NOTIFICATION body the run emits, including the one a 403 emits;
 *   - every FAILURE path's message - a transport error quoting the URL, a
 *     non-200 quoting the body, a governor refusal quoting the URL - because
 *     the error path is where a redaction that was applied "at the end" is
 *     always missing.
 *
 * Criterion 17 is graded on the refusal AND on the transport: an absent
 * credential must produce zero requests, not one that comes back 403.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memorySourceStops, memoryWatchlist } from "@deal-sentinel/db";
import type { HistoryWriter, NewPriceObservationRow } from "@deal-sentinel/db";
import {
  CREDENTIAL_PLACEHOLDER,
  MissingCredentialError,
  bestBuyAdapter,
  buildProductUrl,
  createBestBuyAdapter,
  credentialRedactor,
  readCredential,
  redactCredentialParameters,
  runCollection,
  stopPeriodsFromGovernorConfig,
} from "@deal-sentinel/sources";

import {
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_VARIABLE,
  credentialEnv,
  fixtureAnswer,
  limitExceededAnswer,
  sourceHarness,
} from "../support/source-3-harness.ts";

function recordingWriter(): HistoryWriter & { rows: NewPriceObservationRow[] } {
  const rows: NewPriceObservationRow[] = [];
  return {
    rows,
    async insertObservation(row) {
      rows.push(row);
      return BigInt(rows.length);
    },
  };
}

/** Every string reachable from a value, however deeply nested. */
function everyString(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) everyString(item, found);
  else if (value instanceof Date) found.push(value.toISOString());
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) everyString(item, found);
  } else if (value !== undefined && value !== null) found.push(String(value));
  return found;
}

function assertNoCredential(value: unknown, where: string): void {
  for (const text of everyString(value)) {
    assert.ok(
      !text.includes(TEST_CREDENTIAL),
      `the credential appears in ${where}: ${text}`,
    );
  }
}

describe("criterion 16: the credential is in the request and nowhere else", () => {
  it("is in the URL the vendor requires it in", () => {
    // The premise. A test that asserted absence everywhere without this one
    // would pass against an adapter that never authenticated at all.
    const url = buildProductUrl("https://api.bestbuy.com/v1", "8880044", TEST_CREDENTIAL);
    assert.match(url, /apiKey=/);
    assert.ok(url.includes(TEST_CREDENTIAL));
    assert.match(url, /\/v1\/products\/8880044\.json/);
  });

  it("escapes a credential that would otherwise end the parameter", () => {
    const url = buildProductUrl("https://api.bestbuy.com/v1", "1", "a&b=c#d");
    assert.equal(new URL(url).searchParams.get("apiKey"), "a&b=c#d");
  });

  it("is kept out of the stored raw content, even when the vendor echoes it", async () => {
    const harness = sourceHarness({
      answers: { "8880044": fixtureAnswer("product-on-sale.json") },
    });
    const adapter = bestBuyAdapter({
      governor: harness.governor,
      entry: harness.registry.require("bestbuy-api"),
      credential: TEST_CREDENTIAL,
    });

    const outcome = await adapter.observe("8880044");
    assert.equal(outcome.kind, "observed");
    assert.ok(outcome.kind === "observed");

    // The fixture really does carry it, so the assertion below has something
    // to catch. This is the vendor's own `canonicalUrl` behaviour.
    assert.ok(
      fixtureBody().includes(TEST_CREDENTIAL),
      "the fixture does not echo the credential, so this test proves nothing",
    );
    assert.ok(!outcome.draft.rawContext.includes(TEST_CREDENTIAL));
    assert.ok(outcome.draft.rawContext.includes(CREDENTIAL_PLACEHOLDER));
    // The rest of the document survives: redaction is not deletion.
    assert.ok(outcome.draft.rawContext.includes("Batman Begins"));
  });

  it("keeps it out of every failure path's message", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["a non-200 status", { "8880044": { status: 500, body: bodyEchoingTheKey() } }],
      ["an unparseable body", { "8880044": { status: 200, body: "not json at all" } }],
      ["the documented 403", { "8880044": limitExceededAnswer() }],
      [
        "a transport error",
        { "8880044": new Error(`connection reset for ?apiKey=${TEST_CREDENTIAL}`) },
      ],
      [
        "a payload about another listing",
        { "8880044": fixtureAnswer("product-wrong-sku.json") },
      ],
    ];

    for (const [what, answers] of cases) {
      const harness = sourceHarness({ answers: answers as never });
      const adapter = bestBuyAdapter({
        governor: harness.governor,
        entry: harness.registry.require("bestbuy-api"),
        credential: TEST_CREDENTIAL,
      });
      const outcome = await adapter.observe("8880044");
      assertNoCredential(outcome, `the outcome of ${what}`);
    }
  });

  it("keeps it out of a governor refusal, which quotes the URL", async () => {
    // An unconfigured host is refused by the governor's first gate, and its
    // refusal detail quotes the full URL - credential and all - because the
    // governor knows nothing about credentials.
    const harness = sourceHarness({
      registry: undefined,
      answers: {},
    });
    const entry = harness.registry.require("bestbuy-api");
    const adapter = bestBuyAdapter({
      governor: harness.governor,
      entry: { ...entry, baseUrl: "https://unconfigured.invalid/v1" },
      credential: TEST_CREDENTIAL,
    });

    const outcome = await adapter.observe("8880044");
    assert.ok(outcome.kind === "governor-refused");
    assert.equal(outcome.reason, "unconfigured-host");
    assertNoCredential(outcome, "a governor refusal");
    assert.ok(outcome.detail.includes(CREDENTIAL_PLACEHOLDER));
  });

  it("keeps it out of the notification body a 403 emits", async () => {
    const harness = sourceHarness({
      answers: { "8880044": limitExceededAnswer() },
    });
    const adapter = bestBuyAdapter({
      governor: harness.governor,
      entry: harness.registry.require("bestbuy-api"),
      credential: TEST_CREDENTIAL,
    });

    const report = await runCollection({
      adapters: [adapter],
      registry: harness.registry,
      watchlist: memoryWatchlist([
        { sourceId: "bestbuy-api", listingId: "8880044", enabled: true },
      ]),
      writer: recordingWriter(),
      stops: memorySourceStops(),
      notifier: harness.notifier,
      clock: harness.clock,
      stopPeriodMsFor: stopPeriodsFromGovernorConfig(harness.config),
    });

    assert.equal(harness.notifier.sent.length, 1);
    assertNoCredential(harness.notifier.sent, "a notification body");
    assertNoCredential(report, "the run report");
  });

  it("redacts a credential-bearing parameter whatever its value is", () => {
    // The rule that still works when the credential in hand is not the one
    // that produced the text: a rotated key, or a fixture from another run.
    const line = "GET https://api.bestbuy.com/v1/products/1.json?show=sku&apiKey=SOMEONE_ELSES_KEY";
    const redacted = redactCredentialParameters(line);
    assert.ok(!redacted.includes("SOMEONE_ELSES_KEY"));
    assert.ok(redacted.includes(`apiKey=${CREDENTIAL_PLACEHOLDER}`));
    // Everything that is not the value is untouched.
    assert.ok(redacted.includes("show=sku"));
  });

  it("redacts a credential that carries regular-expression metacharacters", () => {
    const secret = "a.*b+c(d)[e]";
    const redactor = credentialRedactor(secret);
    assert.equal(redactor.scrub(`key=${secret} end`), `key=${CREDENTIAL_PLACEHOLDER} end`);
    // And does not eat text that merely LOOKS like the pattern would match it.
    assert.equal(redactor.scrub("aXXbbbcd end"), "aXXbbbcd end");
  });

  it("redacts every occurrence, not the first", () => {
    const redactor = credentialRedactor(TEST_CREDENTIAL);
    const scrubbed = redactor.scrub(
      `${TEST_CREDENTIAL} middle ${TEST_CREDENTIAL} end ${TEST_CREDENTIAL}`,
    );
    assert.ok(!scrubbed.includes(TEST_CREDENTIAL));
    assert.equal(scrubbed.split(CREDENTIAL_PLACEHOLDER).length - 1, 3);
  });

  it("hands out no way to read the secret back off a redactor", () => {
    const redactor = credentialRedactor(TEST_CREDENTIAL);
    assertNoCredential(redactor, "the redactor object itself");
    assert.deepEqual(Object.keys(redactor), ["scrub"]);
  });
});

describe("criterion 17: an absent credential refuses, and sends nothing", () => {
  it("refuses and names the source and the variable, never a value", () => {
    const harness = sourceHarness();
    assert.throws(
      () =>
        createBestBuyAdapter(harness.governor, harness.registry.require("bestbuy-api"), {}),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialError);
        assert.equal(error.sourceId, "bestbuy-api");
        assert.equal(error.variable, TEST_CREDENTIAL_VARIABLE);
        assert.match(error.message, /BESTBUY_API_KEY/);
        assert.match(error.message, /will not run/);
        return true;
      },
    );
  });

  it("refuses an empty and a whitespace-only credential too", () => {
    for (const value of ["", "   ", "\t\n"]) {
      assert.throws(
        () => readCredential("bestbuy-api", TEST_CREDENTIAL_VARIABLE, {
          [TEST_CREDENTIAL_VARIABLE]: value,
        }),
        MissingCredentialError,
        `${JSON.stringify(value)} was accepted as a credential`,
      );
    }
  });

  it("issues NO request at all rather than an unauthenticated one", () => {
    const harness = sourceHarness({
      answers: { "8880044": fixtureAnswer("product-on-sale.json") },
    });
    assert.throws(
      () =>
        createBestBuyAdapter(harness.governor, harness.registry.require("bestbuy-api"), {}),
      MissingCredentialError,
    );
    assert.deepEqual(
      harness.transport.sent,
      [],
      "something left the process without a credential; this vendor answers " +
        "that with the same 403 it uses for an exceeded limit",
    );
  });

  it("accepts a present credential, and trims it", () => {
    assert.equal(
      readCredential("bestbuy-api", TEST_CREDENTIAL_VARIABLE, {
        [TEST_CREDENTIAL_VARIABLE]: `  ${TEST_CREDENTIAL}  `,
      }),
      TEST_CREDENTIAL,
    );
    assert.equal(
      readCredential("bestbuy-api", TEST_CREDENTIAL_VARIABLE, credentialEnv()),
      TEST_CREDENTIAL,
    );
  });
});

function fixtureBody(): string {
  const answer = fixtureAnswer("product-on-sale.json");
  return answer instanceof Error ? "" : (answer.body ?? "");
}

function bodyEchoingTheKey(): string {
  return JSON.stringify({
    error: "server error",
    requestedUrl: `https://api.bestbuy.com/v1/products/8880044.json?apiKey=${TEST_CREDENTIAL}`,
  });
}
