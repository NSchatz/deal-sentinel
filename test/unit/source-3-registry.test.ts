/**
 * Acceptance criteria 12, 13, 23 and 24 of spec S0033-deal-sentinel-source-3:
 *
 *  12. WHEN the shipped configuration for the sanctioned API source is loaded
 *      THE SYSTEM SHALL carry a raw-content retention ceiling for it that is no
 *      greater than the seventy-two (72) hours its terms permit.
 *  13. IF a source whose terms declare a retention ceiling is configured
 *      without one THEN THE SYSTEM SHALL refuse to run that source and SHALL
 *      say which source and which setting.
 *  23. IF a source is configured without an ISO 4217 currency or without an
 *      IANA local time zone THEN THE SYSTEM SHALL refuse to run that source and
 *      say which setting is missing.
 *  24. WHEN the sanctioned source's governor configuration is loaded THE SYSTEM
 *      SHALL carry a request ceiling and a metered allowance for it that are no
 *      greater than the vendor's documented 5 calls per second and 50,000 calls
 *      per day.
 *
 * Criteria 12 and 24 are graded against the COMMITTED FILES and not against a
 * document built here: they are assertions about what this repository ships, so
 * a fixture would grade the fixture. Criteria 13 and 23 are graded by taking
 * the same document and removing exactly one setting, which is what a real
 * misconfiguration looks like.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGovernorConfig } from "@deal-sentinel/governor";
import {
  BESTBUY_API_SOURCE_ID,
  SourceConfigError,
  assertGovernorWithinDocumentedLimits,
  loadSourceRegistry,
  parseSourceRegistry,
  sourcesStartCheck,
  termsFor,
  validateSourceRegistry,
} from "@deal-sentinel/sources";

import {
  BESTBUY_HOST,
  readShippedConfig,
  registryDocument,
} from "../support/source-3-harness.ts";

const shippedSources = parseSourceRegistry(
  readShippedConfig("sources.json"),
  "config/sources.json",
);
const shippedGovernor = parseGovernorConfig(
  readShippedConfig("governor.json"),
  "config/governor.json",
);

function refusalFor(document: Record<string, unknown>): SourceConfigError {
  try {
    validateSourceRegistry(document, "the test source configuration");
  } catch (error) {
    assert.ok(
      error instanceof SourceConfigError,
      `expected a SourceConfigError, got ${String(error)}`,
    );
    return error;
  }
  throw new assert.AssertionError({
    message: "the configuration was accepted and it should have been refused",
  });
}

describe("criterion 12: the shipped ceiling is inside the one the terms permit", () => {
  const terms = termsFor(BESTBUY_API_SOURCE_ID);

  it("holds terms declaring the vendor's own 72 hours", () => {
    assert.ok(terms !== null, "no terms are held for the sanctioned source");
    assert.equal(terms.rawContentCeilingHours, 72);
  });

  it("carries a retention ceiling for the sanctioned source at all", () => {
    const entry = shippedSources.require(BESTBUY_API_SOURCE_ID);
    assert.equal(typeof entry.rawContextRetentionHours, "number");
    assert.ok(
      (entry.rawContextRetentionHours ?? 0) >= 1,
      "the shipped ceiling is not a whole number of hours of at least one",
    );
  });

  it("keeps it no greater than the seventy-two hours the terms permit", () => {
    const entry = shippedSources.require(BESTBUY_API_SOURCE_ID);
    assert.ok(
      (entry.rawContextRetentionHours ?? Number.POSITIVE_INFINITY) <= 72,
      `the shipped ceiling is ${entry.rawContextRetentionHours}, and the ` +
        "vendor's terms cap cached Content at 72 hours",
    );
  });

  it("loads the committed file from its default path", () => {
    // The path the running system uses, not one this test invented.
    const registry = loadSourceRegistry();
    assert.ok(
      (registry.require(BESTBUY_API_SOURCE_ID).rawContextRetentionHours ?? 999) <= 72,
    );
  });

  it("refuses a ceiling longer than the terms allow", () => {
    const refusal = refusalFor(registryDocument({ rawContextRetentionHours: 73 }));
    assert.equal(refusal.sourceId, BESTBUY_API_SOURCE_ID);
    assert.match(refusal.message, /72 hours/);
    assert.match(refusal.setting ?? "", /rawContextRetentionHours/);
  });
});

describe("criterion 13: a source whose terms declare a ceiling must carry one", () => {
  it("refuses the source and names it and the setting", () => {
    const refusal = refusalFor(
      registryDocument({ rawContextRetentionHours: undefined }),
    );

    assert.equal(refusal.sourceId, BESTBUY_API_SOURCE_ID);
    assert.equal(
      refusal.setting,
      `sources["${BESTBUY_API_SOURCE_ID}"].rawContextRetentionHours`,
    );
    assert.match(refusal.message, /bestbuy-api/);
    assert.match(refusal.message, /rawContextRetentionHours/);
    assert.match(refusal.message, /will not run/);
  });

  it("does not record content under no ceiling instead", () => {
    // The refusal is the whole behaviour: there is no registry to run from, so
    // no adapter exists, so nothing can be stored unbounded.
    assert.throws(
      () => validateSourceRegistry(registryDocument({ rawContextRetentionHours: undefined })),
      SourceConfigError,
    );
  });

  it("leaves a source whose terms declare no ceiling free of one", () => {
    // A source this repository holds no terms for. Nothing obliges a ceiling,
    // so an absent one is not a refusal - and the content is then retained,
    // which criterion 11 grades against a real database.
    const registry = validateSourceRegistry(
      registryDocument({ rawContextRetentionHours: undefined }, "no-terms-source"),
      "the test source configuration",
    );
    assert.equal(registry.require("no-terms-source").rawContextRetentionHours, null);
  });

  it("refuses a ceiling that is not a whole number of hours", () => {
    const refusal = refusalFor(registryDocument({ rawContextRetentionHours: 1.5 }));
    assert.match(refusal.setting ?? "", /rawContextRetentionHours/);
  });
});

describe("criterion 23: a source without a currency or a zone does not run", () => {
  it("refuses an absent currency and names the setting", () => {
    const refusal = refusalFor(registryDocument({ currency: undefined }));
    assert.equal(refusal.sourceId, BESTBUY_API_SOURCE_ID);
    assert.equal(refusal.setting, `sources["${BESTBUY_API_SOURCE_ID}"].currency`);
    assert.match(refusal.message, /currency/);
  });

  it("refuses a currency that is not a code this system resolves", () => {
    const refusal = refusalFor(registryDocument({ currency: "ZZZ" }));
    assert.equal(refusal.setting, `sources["${BESTBUY_API_SOURCE_ID}"].currency`);
    assert.match(refusal.message, /ISO 4217/);
    // The reason it matters, said in the message: an unresolved code is a
    // wrong NUMBER and not a wrong label.
    assert.match(refusal.message, /exponent/);
  });

  it("refuses an absent time zone and names the setting", () => {
    const refusal = refusalFor(registryDocument({ timeZone: undefined }));
    assert.equal(refusal.setting, `sources["${BESTBUY_API_SOURCE_ID}"].timeZone`);
  });

  it("refuses a time zone this runtime does not resolve", () => {
    const refusal = refusalFor(registryDocument({ timeZone: "Mars/Olympus_Mons" }));
    assert.equal(refusal.setting, `sources["${BESTBUY_API_SOURCE_ID}"].timeZone`);
    assert.match(refusal.message, /IANA/);
  });

  it("infers neither: the shipped file states both explicitly", () => {
    const entry = shippedSources.require(BESTBUY_API_SOURCE_ID);
    assert.equal(entry.currency, "USD");
    assert.match(entry.timeZone, /^[A-Za-z]+\/[A-Za-z_]+$/);
  });

  it("refuses a missing credential location too, before anything is sent", () => {
    const refusal = refusalFor(registryDocument({ credentialVariable: undefined }));
    assert.equal(
      refusal.setting,
      `sources["${BESTBUY_API_SOURCE_ID}"].credentialVariable`,
    );
  });

  it("refuses an unrecognised key rather than silently ignoring it", () => {
    const document = registryDocument();
    (document.sources as Record<string, Record<string, unknown>>)[
      BESTBUY_API_SOURCE_ID
    ].retentionHours = 12;
    const refusal = refusalFor(document);
    assert.match(refusal.message, /unrecognised key/);
  });
});

describe("criterion 24: the governor's numbers are inside the vendor's published ones", () => {
  const terms = termsFor(BESTBUY_API_SOURCE_ID);

  it("holds the vendor's published limits: 5 per second, 50,000 per day", () => {
    assert.ok(terms !== null);
    assert.equal(terms.documentedCallsPerSecond, 5);
    assert.equal(terms.documentedCallsPerDay, 50_000);
  });

  it("accepts the shipped governor configuration and reports the margin", () => {
    const checks = assertGovernorWithinDocumentedLimits(
      shippedSources,
      shippedGovernor,
      "config/governor.json",
    );
    const check = checks.find((entry) => entry.sourceId === BESTBUY_API_SOURCE_ID);
    assert.ok(check !== undefined, "the sanctioned source was not checked at all");
    assert.equal(check.host, BESTBUY_HOST);
    assert.ok(
      check.configuredCallsPerSecond <= 5,
      `the shipped ceiling permits ${check.configuredCallsPerSecond} calls per second`,
    );
    assert.ok(
      check.configuredCallsPerDay <= 50_000,
      `the shipped allowance permits ${check.configuredCallsPerDay} calls per day`,
    );
  });

  it("ships a host ceiling for the vendor's host, so the first gate does not refuse", () => {
    assert.ok(
      shippedGovernor.hosts[BESTBUY_HOST] !== undefined,
      "no ceiling for the vendor's host, so every request would be refused",
    );
  });

  it("ships a METERED allowance, so a crash loop cannot spend the free tier", () => {
    const allowance = shippedGovernor.sources[BESTBUY_API_SOURCE_ID]?.allowance;
    assert.ok(allowance !== undefined, "the sanctioned source is not metered");
    assert.ok(allowance.limit >= 1);
    assert.ok(allowance.periodMs >= 1);
  });

  it("refuses a ceiling faster than the published calls per second", () => {
    const overRate = {
      ...shippedGovernor,
      hosts: {
        ...shippedGovernor.hosts,
        [BESTBUY_HOST]: {
          maxRequests: 10,
          intervalMs: 1000,
          minDelayMs: 100,
          jitterMs: 10,
        },
      },
    };
    assert.throws(
      () => assertGovernorWithinDocumentedLimits(shippedSources, overRate),
      (error: unknown) =>
        error instanceof SourceConfigError && /calls per second/.test(error.message),
    );
  });

  it("refuses a burst the window would permit but the delay would not", () => {
    // 300 requests a minute is 5 per second averaged, and with a 1ms floor
    // between them it is a burst of 300 in a second. The vendor's limit is
    // about the second, so the delay is checked as well as the window.
    const bursty = {
      ...shippedGovernor,
      hosts: {
        ...shippedGovernor.hosts,
        [BESTBUY_HOST]: {
          maxRequests: 300,
          intervalMs: 60_000,
          minDelayMs: 1,
          jitterMs: 1,
        },
      },
    };
    assert.throws(
      () => assertGovernorWithinDocumentedLimits(shippedSources, bursty),
      SourceConfigError,
    );
  });

  it("refuses an allowance larger than the published calls per day", () => {
    const overAllowance = {
      ...shippedGovernor,
      sources: {
        ...shippedGovernor.sources,
        [BESTBUY_API_SOURCE_ID]: {
          allowance: { limit: 60_000, periodMs: 86_400_000, warnFraction: 0.8 },
        },
      },
    };
    assert.throws(
      () => assertGovernorWithinDocumentedLimits(shippedSources, overAllowance),
      (error: unknown) =>
        error instanceof SourceConfigError && /per day/.test(error.message),
    );
  });

  it("refuses an unmetered source whose vendor publishes a daily limit", () => {
    const unmetered = {
      ...shippedGovernor,
      sources: { ...shippedGovernor.sources, [BESTBUY_API_SOURCE_ID]: {} },
    };
    assert.throws(
      () => assertGovernorWithinDocumentedLimits(shippedSources, unmetered),
      (error: unknown) =>
        error instanceof SourceConfigError && /no allowance/.test(error.message),
    );
  });

  it("refuses a governor that carries no ceiling for the vendor's host", () => {
    const hosts = { ...shippedGovernor.hosts };
    delete hosts[BESTBUY_HOST];
    assert.throws(
      () => assertGovernorWithinDocumentedLimits(shippedSources, { ...shippedGovernor, hosts }),
      (error: unknown) =>
        error instanceof SourceConfigError &&
        /no request ceiling/.test(error.message),
    );
  });
});

describe("the start check runs criteria 12, 13, 23 and 24 in the system", () => {
  // The point of this block: the checks above are assertions about two
  // COMMITTED JSON FILES, and one that only ever ran inside a test suite would
  // pass in CI on CI's copy and say nothing about the file the homelab runs.
  // `pnpm sources:start-check` is the same three checks, at process start.
  it("accepts the committed pair and reports what they permit", () => {
    const report = sourcesStartCheck({ env: {} });
    const source = report.sources.find(
      (entry) => entry.sourceId === BESTBUY_API_SOURCE_ID,
    );
    assert.ok(source !== undefined);
    assert.equal(source.host, BESTBUY_HOST);
    assert.equal(source.ceilingHours, 72);
    assert.ok((source.retentionHours ?? 999) <= 72);
    assert.equal(source.attributionRequired, true);
    assert.equal(source.credentialVariable, "BESTBUY_API_KEY");
    assert.equal(source.credentialPresent, false, "an env with no key reads present");
  });

  it("reports a credential rather than refusing on it, so other sources still run", () => {
    const withKey = sourcesStartCheck({ env: { BESTBUY_API_KEY: "a-key" } });
    assert.equal(withKey.sources[0].credentialPresent, true);
    // And with none at all it still completes: one source that cannot run must
    // not stop the check, or the others.
    assert.equal(sourcesStartCheck({ env: {} }).sources.length, withKey.sources.length);
  });

  it("refuses at start when the governor exceeds a published limit", () => {
    assert.throws(
      () =>
        sourcesStartCheck({
          env: {},
          governorConfig: {
            ...shippedGovernor,
            sources: {
              ...shippedGovernor.sources,
              [BESTBUY_API_SOURCE_ID]: {
                allowance: { limit: 90_000, periodMs: 86_400_000, warnFraction: 0.8 },
              },
            },
          },
        }),
      SourceConfigError,
    );
  });
});

describe("the registry refuses a file it cannot make sense of", () => {
  it("refuses a document that is not JSON", () => {
    assert.throws(
      () => parseSourceRegistry("{not json", "the test source configuration"),
      SourceConfigError,
    );
  });

  it("refuses an empty source map", () => {
    assert.throws(
      () => validateSourceRegistry({ sources: {} }, "the test source configuration"),
      (error: unknown) =>
        error instanceof SourceConfigError && /no entries/.test(error.message),
    );
  });

  it("refuses a base URL that is not absolute", () => {
    const refusal = refusalFor(registryDocument({ baseUrl: "/v1" }));
    assert.match(refusal.setting ?? "", /baseUrl/);
  });

  it("names an unconfigured source rather than answering undefined for it", () => {
    assert.throws(
      () => shippedSources.require("a-source-nobody-configured"),
      (error: unknown) =>
        error instanceof SourceConfigError &&
        /a-source-nobody-configured/.test(error.message),
    );
  });
});
