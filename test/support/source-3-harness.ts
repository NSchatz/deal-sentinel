/**
 * The fixtures every SOURCE-3 test is built from.
 *
 * NOTHING HERE REACHES A THIRD PARTY. The transport is the governor harness's
 * recording stub, which answers from a responder this file supplies, so every
 * criterion in spec S0033-deal-sentinel-source-3 is graded against saved
 * payloads and a virtual clock. The host in the test configuration is the
 * vendor's REAL hostname on purpose - it is what the shipped configuration
 * keys its ceiling by, and a test that used a different one would not be
 * exercising the same gate - and nothing is sent to it, because the governor
 * has been handed a stub and holds no client of its own.
 *
 * The credential below is a stand-in and is deliberately conspicuous. It exists
 * so the redaction criteria can be graded against a value a test can search
 * for: a suite that asserts "no credential appears" against a credential that
 * was never in play asserts nothing.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryAllowanceStore } from "@deal-sentinel/governor";
import type {
  AllowanceStore,
  FetchTelemetry,
  Governor,
  GovernorConfig,
  TransportRequest,
  TransportResponse,
} from "@deal-sentinel/governor";
import { validateSourceRegistry } from "@deal-sentinel/sources";
import type { SourceRegistry } from "@deal-sentinel/sources";

import { FakeClock } from "./fake-clock.ts";
import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "./governor-harness.ts";
import type {
  ConfigOverrides,
  RecordingNotifier,
  RecordingTransport,
} from "./governor-harness.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The stand-in credential. Not a key, and not a key shape anybody would issue. */
export const TEST_CREDENTIAL = "fixture-api-key-do-not-use";

/** The variable the test registry reads that credential from. */
export const TEST_CREDENTIAL_VARIABLE = "BESTBUY_API_KEY";

export const BESTBUY_HOST = "api.bestbuy.com";
export const BESTBUY_BASE_URL = "https://api.bestbuy.com/v1";

/** The shipped configuration, read as text so a test grades the committed file. */
export function readShippedConfig(name: string): string {
  return readFileSync(path.join(REPO_ROOT, "config", name), "utf8");
}

export function readVendorFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, "test/fixtures/bestbuy", name), "utf8");
}

/** A source-registry document a test can bend one value of. */
export type RegistryOverrides = {
  baseUrl?: unknown;
  currency?: unknown;
  timeZone?: unknown;
  rawContextRetentionHours?: unknown;
  credentialVariable?: unknown;
  attributionNotice?: unknown;
};

export function registryDocument(
  overrides: RegistryOverrides = {},
  sourceId = "bestbuy-api",
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    baseUrl: BESTBUY_BASE_URL,
    currency: "USD",
    timeZone: "America/New_York",
    rawContextRetentionHours: 24,
    credentialVariable: TEST_CREDENTIAL_VARIABLE,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete entry[key];
    else entry[key] = value;
  }
  return { sources: { [sourceId]: entry } };
}

export function testRegistry(
  overrides: RegistryOverrides = {},
  sourceId = "bestbuy-api",
): SourceRegistry {
  return validateSourceRegistry(
    registryDocument(overrides, sourceId),
    "the test source configuration",
  );
}

/** The id of the second source, for the criteria about one source among many. */
export const SECOND_SOURCE_ID = "second-source";

/** The loopback host the second source sits on, so the two are distinguishable. */
export const SECOND_SOURCE_BASE_URL = "http://127.0.0.1/v1";

/**
 * Two sources: the sanctioned API, and a second one this repository holds no
 * terms for. The second exists for the criteria that are about ONE source among
 * several - a stop that must not spread, a run that must keep going - and a
 * suite with one source could not grade either of them.
 */
export function twoSourceRegistry(
  overrides: RegistryOverrides = {},
): SourceRegistry {
  const first = registryDocument(overrides).sources as Record<string, unknown>;
  return validateSourceRegistry(
    {
      sources: {
        ...first,
        [SECOND_SOURCE_ID]: {
          baseUrl: SECOND_SOURCE_BASE_URL,
          currency: "USD",
          timeZone: "America/Chicago",
          credentialVariable: "SECOND_SOURCE_KEY",
        },
      },
    },
    "the test source configuration",
  );
}

/**
 * A governor configuration carrying the vendor's real host, inside the limits
 * its terms publish. Small numbers so assertions about virtual time stay
 * readable; the SHIPPED numbers are graded separately, against the committed
 * file.
 */
export function bestBuyGovernorConfig(
  overrides: ConfigOverrides = {},
): GovernorConfig {
  return testConfig({
    hosts: {
      [BESTBUY_HOST]: {
        maxRequests: 5,
        intervalMs: 1000,
        minDelayMs: 200,
        jitterMs: 50,
      },
      "127.0.0.1": {
        maxRequests: 100,
        intervalMs: 60_000,
        minDelayMs: 1,
        jitterMs: 1,
      },
    },
    sources: {
      "bestbuy-api": {
        allowance: { limit: 100, periodMs: 86_400_000, warnFraction: 0.9 },
      },
      "second-source": {
        allowance: { limit: 100, periodMs: 86_400_000, warnFraction: 0.9 },
      },
    },
    ...overrides,
  });
}

export type VendorAnswer = Partial<TransportResponse> | Error;

/**
 * Answer product calls from a map of sku to payload, and every `/robots.txt`
 * with a 404, which RFC 9309 makes "no rules, this host may be accessed".
 *
 * A sku with no entry is answered 404, which is what the vendor documents for
 * "the requested item cannot be found".
 */
export function vendorResponder(
  answers: Readonly<Record<string, VendorAnswer>>,
): (request: TransportRequest, index: number) => Partial<TransportResponse> | Error {
  return robotsAbsent((request) => {
    const sku = skuOf(request.url);
    const answer = sku === null ? undefined : answers[sku];
    if (answer === undefined) {
      return { status: 404, body: JSON.stringify({ error: "not found" }) };
    }
    return answer;
  });
}

/** A 200 carrying one saved fixture payload. */
export function fixtureAnswer(name: string): VendorAnswer {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: readVendorFixture(name),
  };
}

/** The status the vendor documents as an exceeded limit, with its own body. */
export function limitExceededAnswer(): VendorAnswer {
  return {
    status: 403,
    headers: { "content-type": "application/json" },
    body: readVendorFixture("error-403.json"),
  };
}

/** The sku a product URL is about, or null when the URL is not one. */
export function skuOf(url: string): string | null {
  const match = /\/products\/([^/.]+)\.json/.exec(new URL(url).pathname);
  return match === null ? null : match[1];
}

export type SourceHarness = {
  governor: Governor;
  clock: FakeClock;
  notifier: RecordingNotifier;
  transport: RecordingTransport;
  allowanceStore: AllowanceStore;
  config: GovernorConfig;
  registry: SourceRegistry;
};

/**
 * A governor wired to a stub transport that answers from saved payloads, plus
 * the registry an adapter needs. The transport is the ONLY thing that could
 * reach a network and it reaches nothing at all.
 */
export function sourceHarness(options: {
  answers?: Readonly<Record<string, VendorAnswer>>;
  responder?: (
    request: TransportRequest,
    index: number,
  ) => Partial<TransportResponse> | Error;
  config?: GovernorConfig;
  registry?: SourceRegistry;
  clock?: FakeClock;
  allowanceStore?: AllowanceStore;
  /** Omitted, nothing is recorded. Supplied, every offered fetch is. */
  telemetry?: FetchTelemetry;
} = {}): SourceHarness {
  const clock = options.clock ?? new FakeClock();
  const transport = recordingTransport(
    clock,
    options.responder ?? vendorResponder(options.answers ?? {}),
  );
  const built = buildGovernor({
    transport,
    clock,
    config: options.config ?? bestBuyGovernorConfig(),
    allowanceStore: options.allowanceStore ?? createMemoryAllowanceStore(),
    telemetry: options.telemetry,
  });

  return {
    governor: built.governor,
    clock,
    notifier: built.notifier,
    transport,
    allowanceStore: built.allowanceStore,
    config: built.config,
    registry: options.registry ?? testRegistry(),
  };
}

/** The environment an adapter reads its credential from, with nothing else in it. */
export function credentialEnv(
  value: string | undefined = TEST_CREDENTIAL,
): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [TEST_CREDENTIAL_VARIABLE]: value };
}
