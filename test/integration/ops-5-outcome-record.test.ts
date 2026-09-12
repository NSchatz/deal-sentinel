/**
 * Acceptance criteria AC-1, AC-2, AC-3, AC-4 and AC-5 of spec
 * S0066-deal-sentinel-ops-5: what every governed request did, kept durably,
 * readable over an arbitrary window, carrying nothing a retention ceiling
 * governs, and never able to cost a request its result.
 *
 * The requests here are real governed requests through the real chokepoint,
 * with the stub transport `source-3-harness.ts` supplies: every gate runs, the
 * virtual clock advances through the per-host delay, and the record is written
 * by the same code the house runs. Nothing reaches a third party.
 *
 * The store is exercised from BOTH sides. The in-memory implementation answers
 * the behavioural questions - one row per request, the window's two ends - and
 * the Drizzle implementation is run against a capturing database so the SQL
 * that a house install actually sends is graded rather than assumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memoryRequestOutcomes, recordObservation } from "@deal-sentinel/db";
import type { RequestOutcome } from "@deal-sentinel/db";
import { drizzleRequestOutcomes, requestOutcomes } from "@deal-sentinel/db";
import { classifyRequestOutcome } from "@deal-sentinel/governor";
import { bestBuyAdapter } from "@deal-sentinel/sources";
import { REQUEST_OUTCOME_CLASSES } from "@deal-sentinel/shared";

import { FakeClock } from "../support/fake-clock.ts";
import { recordingOutcomeSink } from "../support/governor-harness.ts";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NOW_MS,
  capturingDatabase,
  memoryHistoryWriter,
} from "../support/ops-5-harness.ts";
import {
  BESTBUY_BASE_URL,
  TEST_CREDENTIAL,
  fixtureAnswer,
  limitExceededAnswer,
  readVendorFixture,
  sourceHarness,
} from "../support/source-3-harness.ts";

const SOURCE = "bestbuy-api";
const SKU = "8880044";

/** A governed request for one sku, through the harness's stub transport. */
function productUrl(sku: string): string {
  return `${BESTBUY_BASE_URL}/products/${sku}.json?apiKey=${TEST_CREDENTIAL}`;
}

describe("AC-1: every request through the chokepoint leaves exactly one record", () => {
  it("records the source, the class and a whole-millisecond duration, once per request", async () => {
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({
      clock,
      answers: { [SKU]: fixtureAnswer("product-on-sale.json") },
    });

    for (let index = 0; index < 3; index += 1) {
      const outcome = await harness.governor.request({
        url: productUrl(SKU),
        sourceId: SOURCE,
      });
      assert.equal(outcome.ok, true);
    }

    const recorded = harness.outcomes.recorded;
    assert.equal(recorded.length, 3, "one record per request, no sampling");
    for (const record of recorded) {
      assert.equal(record.sourceId, SOURCE);
      assert.equal(record.outcomeClass, "success");
      assert.ok(Number.isInteger(record.durationMs), "a duration that is not whole");
      assert.ok(record.durationMs >= 0);
      assert.ok(record.recordedAt instanceof Date);
    }
  });

  it("measures the duration across the gates, on the injected clock", async () => {
    // The host ceiling in the harness spaces requests by 200ms plus jitter, and
    // the governor fetches robots.txt through that same delay, so the first
    // request's elapsed time is the wait it actually took rather than zero.
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({
      clock,
      answers: { [SKU]: fixtureAnswer("product-on-sale.json") },
    });

    const before = clock.now();
    await harness.governor.request({ url: productUrl(SKU), sourceId: SOURCE });
    const elapsed = clock.now() - before;

    const record = harness.outcomes.recorded[0];
    assert.ok(elapsed > 0, "the harness no longer makes the governor wait at all");
    assert.equal(record.durationMs, elapsed);
    assert.equal(record.recordedAt.getTime(), clock.now());
  });

  it("aggregates nothing at write time: five classes, one row each, never a counter", async () => {
    const store = memoryRequestOutcomes();
    const at = new Date(NOW_MS);
    for (const outcomeClass of REQUEST_OUTCOME_CLASSES) {
      await store.record({ sourceId: SOURCE, outcomeClass, durationMs: 1, recordedAt: at });
      await store.record({ sourceId: SOURCE, outcomeClass, durationMs: 2, recordedAt: at });
    }

    assert.equal(store.rows.length, REQUEST_OUTCOME_CLASSES.length * 2);
    const report = await store.countsIn({
      start: new Date(NOW_MS - MINUTE_MS),
      end: new Date(NOW_MS + MINUTE_MS),
    });
    assert.equal(report.sources[0].total, REQUEST_OUTCOME_CLASSES.length * 2);
    for (const outcomeClass of REQUEST_OUTCOME_CLASSES) {
      assert.equal(report.sources[0].counts[outcomeClass], 2);
    }
  });

  it("keeps the record in a table, so it survives the process that wrote it", async () => {
    // Durability is a property of WHERE the row goes. The Drizzle store is what
    // a house install is wired to, and the statement it sends is an INSERT into
    // the committed table - not an upsert, not an update of a counter.
    const capturing = capturingDatabase();
    await drizzleRequestOutcomes(capturing.database).record({
      sourceId: SOURCE,
      outcomeClass: "success",
      durationMs: 12,
      recordedAt: new Date(NOW_MS),
    });

    const statements = capturing.against("request_outcomes");
    assert.equal(statements.length, 1);
    assert.match(statements[0].text, /^insert into "request_outcomes"/);
    assert.doesNotMatch(statements[0].text, /on conflict|update/i);
  });
});

describe("AC-2: a refusal this system made is never a third party blocking it", () => {
  it("records the governor's own refusals under one class, whichever gate refused", async () => {
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({ clock });

    // A host with no configured ceiling, and a source this governor has never
    // heard of: two refusals taken before anything could reach the wire.
    const unconfigured = await harness.governor.request({
      url: "https://unlisted.invalid/v1/products/1.json",
      sourceId: SOURCE,
    });
    const unknownSource = await harness.governor.request({
      url: productUrl(SKU),
      sourceId: "a-source-nobody-configured",
    });

    assert.equal(unconfigured.ok, false);
    assert.equal(unknownSource.ok, false);
    assert.deepEqual(
      harness.outcomes.recorded.map((record) => record.outcomeClass),
      ["governor-refusal", "governor-refusal"],
    );
    assert.equal(harness.transport.sent.length, 0, "a refusal reached the wire");
  });

  it("records a robots refusal as the governor's own, not as a block", async () => {
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({
      clock,
      responder: (request) => {
        if (new URL(request.url).pathname === "/robots.txt") {
          return { status: 200, body: "User-agent: *\nDisallow: /\n" };
        }
        return fixtureAnswer("product-on-sale.json") as { status: number };
      },
    });

    const outcome = await harness.governor.request({
      url: productUrl(SKU),
      sourceId: SOURCE,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "robots-disallowed");
    assert.deepEqual(
      harness.outcomes.recorded.map((record) => record.outcomeClass),
      ["governor-refusal"],
    );
  });

  it("records a spent allowance as the governor's own refusal", async () => {
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({
      clock,
      answers: { [SKU]: fixtureAnswer("product-on-sale.json") },
      config: {
        ...sourceHarness().config,
        sources: {
          // Two units: the governor's own robots.txt retrieval spends one, and
          // the first product request spends the other.
          [SOURCE]: { allowance: { limit: 2, periodMs: DAY_MS, warnFraction: 0.9 } },
        },
      },
    });

    // The first request spends the whole allowance; the second is refused by a
    // gate this system owns and nothing leaves for it.
    await harness.governor.request({ url: productUrl(SKU), sourceId: SOURCE });
    const spent = await harness.governor.request({ url: productUrl(SKU), sourceId: SOURCE });

    assert.equal(spent.ok, false);
    assert.equal(spent.ok === false && spent.reason, "allowance-exhausted");
    assert.deepEqual(
      harness.outcomes.recorded.map((record) => record.outcomeClass),
      ["success", "governor-refusal"],
    );
  });

  it("keeps a third-party block, a third-party error and a transport error apart", async () => {
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({
      clock,
      answers: {
        "1": limitExceededAnswer(),
        "2": { status: 500, body: "upstream is unwell" },
        "3": new Error("the connection was reset"),
      },
    });

    for (const sku of ["1", "2", "3"]) {
      await harness.governor.request({ url: productUrl(sku), sourceId: SOURCE });
    }

    assert.deepEqual(
      harness.outcomes.recorded.map((record) => record.outcomeClass),
      ["third-party-block", "third-party-error", "transport-error"],
    );
  });

  it("classifies every outcome shape, so the vocabulary has no silent default", () => {
    const response = (status: number) => ({
      ok: true as const,
      release: { host: "example.invalid", at: NOW_MS, delayMs: 1, waitedMs: 0 },
      response: {
        url: "https://example.invalid/",
        status,
        headers: {},
        body: "",
        truncated: false,
      },
    });

    assert.equal(classifyRequestOutcome(response(200)), "success");
    assert.equal(classifyRequestOutcome(response(301)), "success");
    assert.equal(classifyRequestOutcome(response(403)), "third-party-block");
    assert.equal(classifyRequestOutcome(response(429)), "third-party-block");
    assert.equal(classifyRequestOutcome(response(404)), "third-party-error");
    assert.equal(classifyRequestOutcome(response(500)), "third-party-error");
    for (const reason of [
      "unconfigured-host",
      "unknown-source",
      "source-paused",
      "allowance-exhausted",
      "robots-unreachable",
      "robots-disallowed",
      "robots-stale",
      "host-held",
    ] as const) {
      assert.equal(
        classifyRequestOutcome({ ok: false, reason, detail: "" }),
        "governor-refusal",
        `${reason} was not recorded as a refusal this system made`,
      );
    }
    assert.equal(
      classifyRequestOutcome({ ok: false, reason: "transport-error", detail: "" }),
      "transport-error",
    );
  });
});

describe("AC-3: counts per source per class, over the window asked for", () => {
  const rows: RequestOutcome[] = [
    { sourceId: SOURCE, outcomeClass: "success", durationMs: 5, recordedAt: new Date(NOW_MS - HOUR_MS) },
    { sourceId: SOURCE, outcomeClass: "success", durationMs: 6, recordedAt: new Date(NOW_MS) },
    { sourceId: SOURCE, outcomeClass: "third-party-block", durationMs: 7, recordedAt: new Date(NOW_MS + MINUTE_MS) },
    { sourceId: "second-source", outcomeClass: "governor-refusal", durationMs: 0, recordedAt: new Date(NOW_MS) },
  ];

  it("counts each class per source and reports the window beside the counts", async () => {
    const store = memoryRequestOutcomes(rows);
    const window = { start: new Date(NOW_MS - HOUR_MS), end: new Date(NOW_MS + HOUR_MS) };

    const report = await store.countsIn(window);

    assert.equal(report.window, window, "the window it answered for is not reported");
    assert.deepEqual(
      report.sources.map((source) => source.sourceId),
      ["bestbuy-api", "second-source"],
    );
    assert.equal(report.sources[0].counts.success, 2);
    assert.equal(report.sources[0].counts["third-party-block"], 1);
    assert.equal(report.sources[0].counts["transport-error"], 0);
    assert.equal(report.sources[0].total, 3);
    assert.equal(report.sources[1].counts["governor-refusal"], 1);
  });

  it("includes the instant at the window start and excludes the one at its end", async () => {
    const store = memoryRequestOutcomes(rows);

    const report = await store.countsIn({
      start: new Date(NOW_MS),
      end: new Date(NOW_MS + MINUTE_MS),
    });

    assert.equal(report.sources[0].counts.success, 1, "the row at the start was excluded");
    assert.equal(
      report.sources[0].counts["third-party-block"],
      0,
      "the row exactly at the end was counted, so two adjacent windows double-count",
    );
  });

  it("sends the same half-open window to the database", async () => {
    const capturing = capturingDatabase();
    await drizzleRequestOutcomes(capturing.database).countsIn({
      start: new Date(NOW_MS),
      end: new Date(NOW_MS + HOUR_MS),
    });

    const [statement] = capturing.against("request_outcomes");
    assert.match(statement.text, /"recorded_at" >= \$1/);
    assert.match(statement.text, /"recorded_at" < \$2/);
    assert.match(statement.text, /group by "request_outcomes"\."source_id", "request_outcomes"\."outcome_class"/);
  });

  it("answers the newest success for a source, and null where there has never been one", async () => {
    const store = memoryRequestOutcomes(rows);
    assert.equal(
      (await store.lastSuccessAt(SOURCE))?.getTime(),
      NOW_MS,
      "the newest success is not the one reported",
    );
    assert.equal(await store.lastSuccessAt("second-source"), null);
    assert.equal(await store.lastSuccessAt("a-source-with-no-rows"), null);
  });
});

describe("AC-4: the record carries nothing a retention ceiling governs", () => {
  it("keeps four fields and no url, credential or response content", async () => {
    const clock = new FakeClock(NOW_MS);
    const harness = sourceHarness({
      clock,
      answers: { [SKU]: fixtureAnswer("product-on-sale.json") },
    });

    const adapter = bestBuyAdapter({
      governor: harness.governor,
      entry: harness.registry.require(SOURCE),
      credential: TEST_CREDENTIAL,
    });
    const observed = await adapter.observe(SKU);
    assert.equal(observed.kind, "observed");

    const record = harness.outcomes.recorded[0];
    assert.deepEqual(Object.keys(record).sort(), [
      "durationMs",
      "outcomeClass",
      "recordedAt",
      "sourceId",
    ]);

    const serialised = JSON.stringify(record);
    assert.doesNotMatch(serialised, new RegExp(TEST_CREDENTIAL));
    assert.doesNotMatch(serialised, /apiKey/i);
    assert.doesNotMatch(serialised, /bestbuy\.com/);
    assert.doesNotMatch(serialised, /products\//);
    // Nothing the vendor sent back is in it either: the response body's own
    // product name is the thing a retention ceiling would govern.
    const body = readVendorFixture("product-on-sale.json");
    const name = (JSON.parse(body) as { name?: string }).name ?? "a name";
    assert.doesNotMatch(serialised, new RegExp(name.slice(0, 12)));
  });

  it("gives the table no column that could hold one", () => {
    assert.deepEqual(
      Object.keys(requestOutcomes).filter((key) => !key.startsWith("_")).sort(),
      ["durationMs", "enableRLS", "id", "outcomeClass", "recordedAt", "sourceId"],
      "a column was added to the request record; a url, a header or a body is " +
        "third-party content or a credential and belongs in neither",
    );
  });
});

describe("AC-5: a recorder that fails costs nothing but the record", () => {
  it("returns the request's result, writes the observation, and reports the failure", async () => {
    const clock = new FakeClock(NOW_MS);
    const broken = recordingOutcomeSink({ failWith: new Error("the store went away") });
    const harness = sourceHarness({
      clock,
      outcomes: broken,
      answers: { [SKU]: fixtureAnswer("product-on-sale.json") },
    });

    const adapter = bestBuyAdapter({
      governor: harness.governor,
      entry: harness.registry.require(SOURCE),
      credential: TEST_CREDENTIAL,
    });
    const observed = await adapter.observe(SKU);

    assert.equal(observed.kind, "observed", "a broken recorder cost the request its result");

    const writer = memoryHistoryWriter();
    const write =
      observed.kind === "observed"
        ? await recordObservation(
            writer,
            {
              ok: true,
              amountMinorUnits: observed.draft.amountMinorUnits,
              currency: observed.draft.currency,
              availability: observed.draft.availability,
            },
            {
              sourceId: SOURCE,
              listingId: observed.listingId,
              observedAt: new Date(clock.now()),
              sourceTimeZone: harness.registry.require(SOURCE).timeZone,
              rawContext: observed.draft.rawContext,
            },
          )
        : { written: false as const, reason: "no-offer" as const };

    assert.equal(write.written, true, "the observation write was lost to the recorder");
    assert.equal(writer.rows.length, 1);

    assert.equal(broken.recorded.length, 0);
    assert.equal(broken.failures.length, 1, "the failure was dropped silently");
    const failure = broken.failures[0];
    assert.equal(failure.outcome.sourceId, SOURCE);
    assert.equal(failure.outcome.outcomeClass, "success");
    assert.match(failure.detail, /request-outcome-not-recorded/);
    assert.match(failure.detail, /the store went away/);
    assert.doesNotMatch(failure.detail, new RegExp(TEST_CREDENTIAL));
  });

  it("keeps going when the recorder fails on every request in a run", async () => {
    const clock = new FakeClock(NOW_MS);
    const broken = recordingOutcomeSink({ failWith: new Error("still gone") });
    const harness = sourceHarness({
      clock,
      outcomes: broken,
      answers: { [SKU]: fixtureAnswer("product-on-sale.json") },
    });

    for (let index = 0; index < 3; index += 1) {
      const outcome = await harness.governor.request({
        url: productUrl(SKU),
        sourceId: SOURCE,
      });
      assert.equal(outcome.ok, true);
    }
    assert.equal(broken.failures.length, 3, "a failure after the first was swallowed");
  });
});
