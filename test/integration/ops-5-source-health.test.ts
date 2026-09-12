/**
 * Acceptance criteria AC-6 through AC-11 of spec S0066-deal-sentinel-ops-5: the
 * read layer over the request record and over the pause and allowance state the
 * governor already keeps.
 *
 * The pause half is graded from BOTH ends, because a pause has two origins and
 * they are visible from different places: a breaker that tripped lives in the
 * collecting process's memory and is read from a real `Governor` whose breaker
 * this suite actually trips, while a stop taken for the period lives in a table
 * and is read from the durable store. Nothing here reaches a third party.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { memoryRequestOutcomes, memorySourceStops } from "@deal-sentinel/db";
import type { RequestOutcome } from "@deal-sentinel/db";
import { createMemoryAllowanceStore, periodStartFor } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";
import {
  MissingStalenessCeilingError,
  StoreUnreadableError,
  breakerPauses,
  combinePauseReaders,
  periodStopPauses,
  readHealthReport,
  stopPeriodsFrom,
} from "@deal-sentinel/ops";
import type { HealthDependencies } from "@deal-sentinel/ops";

import { FakeClock } from "../support/fake-clock.ts";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NOW_MS,
  noPauses,
  testOpsConfig,
  unreadableOutcomeStore,
} from "../support/ops-5-harness.ts";
import {
  BESTBUY_BASE_URL,
  TEST_CREDENTIAL,
  bestBuyGovernorConfig,
  sourceHarness,
} from "../support/source-3-harness.ts";

const METERED = "bestbuy-api";
const UNMETERED = "second-source";

function governorConfig(): GovernorConfig {
  return bestBuyGovernorConfig({
    sources: {
      [METERED]: { allowance: { limit: 100, periodMs: DAY_MS, warnFraction: 0.8 } },
      [UNMETERED]: {},
    },
  });
}

/** A read layer over in-memory stores, at a fixed instant. */
function deps(overrides: Partial<HealthDependencies> = {}): HealthDependencies {
  return {
    config: testOpsConfig(),
    governorConfig: governorConfig(),
    outcomes: memoryRequestOutcomes(),
    allowance: createMemoryAllowanceStore(),
    pauses: noPauses,
    clock: new FakeClock(NOW_MS),
    ...overrides,
  };
}

function success(sourceId: string, at: number): RequestOutcome {
  return { sourceId, outcomeClass: "success", durationMs: 12, recordedAt: new Date(at) };
}

describe("AC-6 and AC-7: what a meter says, and what an unmetered source does not", () => {
  it("reports the consumed and remaining allowance with the period they belong to", async () => {
    const allowance = createMemoryAllowanceStore();
    const periodStart = periodStartFor(NOW_MS, DAY_MS);
    await allowance.reserve(METERED, periodStart, 7, 100);

    const report = await readHealthReport(
      deps({
        allowance,
        outcomes: memoryRequestOutcomes([success(METERED, NOW_MS - MINUTE_MS)]),
      }),
    );

    const metered = report.sources.find((source) => source.sourceId === METERED);
    assert.ok(metered !== undefined);
    assert.equal(metered.allowance.metered, true);
    assert.equal(metered.allowance.metered && metered.allowance.consumed, 7);
    assert.equal(metered.allowance.metered && metered.allowance.remaining, 93);
    assert.equal(
      metered.allowance.metered && metered.allowance.periodStart.getTime(),
      periodStart.getTime(),
    );
    assert.equal(
      metered.allowance.metered && metered.allowance.periodEnd.getTime(),
      periodStart.getTime() + DAY_MS,
    );
  });

  it("reports an unmetered source as unmetered, with no zero and no unlimited", async () => {
    const report = await readHealthReport(deps());
    const unmetered = report.sources.find((source) => source.sourceId === UNMETERED);

    assert.ok(unmetered !== undefined);
    assert.equal(unmetered.allowance.metered, false);
    assert.deepEqual(Object.keys(unmetered.allowance), ["metered"]);
    const serialised = JSON.stringify(unmetered.allowance);
    assert.doesNotMatch(serialised, /consumed/);
    assert.doesNotMatch(serialised, /remaining/);
    assert.doesNotMatch(serialised, /Infinity|unlimited/i);
  });
});

describe("AC-8: a paused source says so, with the condition and the instant", () => {
  it("reads a tripped breaker through the governor that tripped it", async () => {
    const clock = new FakeClock(NOW_MS);
    const config = governorConfig();
    const harness = sourceHarness({
      clock,
      config,
      // Every product call fails, which is what the breaker counts.
      answers: {
        "1": new Error("connection reset"),
        "2": new Error("connection reset"),
        "3": new Error("connection reset"),
        "4": new Error("connection reset"),
        "5": new Error("connection reset"),
      },
    });

    for (const sku of ["1", "2", "3", "4", "5"]) {
      await harness.governor.request({
        url: `${BESTBUY_BASE_URL}/products/${sku}.json?apiKey=${TEST_CREDENTIAL}`,
        sourceId: METERED,
      });
    }

    const status = harness.governor.pauseStatus(METERED);
    assert.equal(status.paused, true, "the harness no longer trips the breaker");

    const pause = await breakerPauses(harness.governor, config).pauseFor(METERED);
    assert.ok(pause !== null);
    assert.equal(pause.origin, "breaker");
    assert.match(pause.condition, /were an error or a block/);
    assert.equal(pause.until?.getTime(), status.paused === true ? status.until : 0);
    assert.equal(
      pause.at.getTime(),
      (status.paused === true ? status.until : 0) - config.breaker.pauseMs,
    );
  });

  it("reads a stop taken for the period out of the durable record", async () => {
    const clock = new FakeClock(NOW_MS);
    const config = governorConfig();
    const stops = memorySourceStops();
    const periodStart = periodStartFor(NOW_MS, DAY_MS);
    const stoppedAt = new Date(NOW_MS - HOUR_MS);
    await stops.stop(METERED, periodStart, stoppedAt, "the vendor answered 403");

    const pauses = periodStopPauses(stops, clock, stopPeriodsFrom(config));
    const pause = await pauses.pauseFor(METERED);

    assert.ok(pause !== null);
    assert.equal(pause.origin, "period-stop");
    assert.equal(pause.condition, "the vendor answered 403");
    assert.equal(pause.at.getTime(), stoppedAt.getTime());
    assert.equal(pause.until?.getTime(), periodStart.getTime() + DAY_MS);
    assert.equal(await pauses.pauseFor(UNMETERED), null);
  });

  it("reports a paused source as paused, and says what the pause was read from", async () => {
    const clock = new FakeClock(NOW_MS);
    const config = governorConfig();
    const stops = memorySourceStops();
    await stops.stop(
      METERED,
      periodStartFor(NOW_MS, DAY_MS),
      new Date(NOW_MS - HOUR_MS),
      "the vendor answered 403",
    );

    const report = await readHealthReport(
      deps({
        clock,
        outcomes: memoryRequestOutcomes([success(METERED, NOW_MS - MINUTE_MS)]),
        pauses: combinePauseReaders([
          periodStopPauses(stops, clock, stopPeriodsFrom(config)),
        ]),
      }),
    );

    const metered = report.sources.find((source) => source.sourceId === METERED);
    assert.ok(metered !== undefined);
    assert.equal(metered.state, "paused");
    assert.equal(metered.pause?.condition, "the vendor answered 403");
    assert.deepEqual(report.pauseEvidence, ["period-stop"]);
  });
});

describe("AC-9: silence is broken, never quiet", () => {
  it("reports a source whose newest success is past its ceiling as broken", async () => {
    const report = await readHealthReport(
      deps({
        outcomes: memoryRequestOutcomes([success(METERED, NOW_MS - 3 * DAY_MS)]),
      }),
    );

    const metered = report.sources.find((source) => source.sourceId === METERED);
    assert.equal(metered?.state, "broken");
    assert.equal(metered?.lastSuccessAgeMs, 3 * DAY_MS);
    assert.equal(metered?.stalenessCeilingMs, 2 * DAY_MS);
  });

  it("reports a source that has never had a success as broken, not as quiet", async () => {
    const report = await readHealthReport(deps());

    for (const source of report.sources) {
      assert.equal(source.state, "broken", `${source.sourceId} read as something else`);
      assert.equal(source.lastSuccessAt, null);
      assert.equal(source.lastSuccessAgeMs, null);
    }
    const states = report.sources.map((source) => source.state);
    assert.equal(states.includes("healthy"), false);
    assert.deepEqual(
      states.filter((state) => state === "paused"),
      [],
    );
  });

  it("reports a recent success as healthy, so broken is not the only answer", async () => {
    const report = await readHealthReport(
      deps({
        outcomes: memoryRequestOutcomes([success(METERED, NOW_MS - HOUR_MS)]),
      }),
    );
    assert.equal(
      report.sources.find((source) => source.sourceId === METERED)?.state,
      "healthy",
    );
  });

  it("keeps broken over paused when a source is both, and still reports the pause", async () => {
    const clock = new FakeClock(NOW_MS);
    const config = governorConfig();
    const stops = memorySourceStops();
    await stops.stop(
      METERED,
      periodStartFor(NOW_MS, DAY_MS),
      new Date(NOW_MS - HOUR_MS),
      "the vendor answered 403",
    );

    const report = await readHealthReport(
      deps({
        clock,
        outcomes: memoryRequestOutcomes([success(METERED, NOW_MS - 3 * DAY_MS)]),
        pauses: periodStopPauses(stops, clock, stopPeriodsFrom(config)),
      }),
    );

    const metered = report.sources.find((source) => source.sourceId === METERED);
    assert.equal(metered?.state, "broken");
    assert.equal(metered?.pause?.condition, "the vendor answered 403");
  });
});

describe("AC-10: a missing ceiling is refused by name, never substituted", () => {
  it("refuses that source's health and names the source and the setting", async () => {
    const report = await readHealthReport(
      deps({
        config: testOpsConfig({ sources: { [UNMETERED]: { stalenessCeilingMs: DAY_MS } } }),
        outcomes: memoryRequestOutcomes([success(METERED, NOW_MS - MINUTE_MS)]),
      }),
    );

    assert.deepEqual(
      report.sources.map((source) => source.sourceId),
      [UNMETERED],
      "a source with no configured ceiling was measured against one anyway",
    );
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0].sourceId, METERED);
    assert.match(report.refused[0].detail, /bestbuy-api/);
    assert.match(report.refused[0].detail, /stalenessCeilingMs/);
  });

  it("throws that refusal when one source's health is asked for directly", async () => {
    const { readSourceHealth } = await import("@deal-sentinel/ops");
    await assert.rejects(
      () =>
        readSourceHealth(
          deps({ config: testOpsConfig({ sources: {} }) }),
          METERED,
          { sourceId: METERED, counts: { success: 0, "third-party-block": 0, "third-party-error": 0, "transport-error": 0, "governor-refusal": 0 }, total: 0 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof MissingStalenessCeilingError);
        assert.equal(error.sourceId, METERED);
        assert.match(error.setting, /stalenessCeilingMs/);
        return true;
      },
    );
  });
});

describe("AC-11: an unreadable store fails, and produces no report at all", () => {
  it("names the read that failed rather than answering with an empty one", async () => {
    await assert.rejects(
      () => readHealthReport(deps({ outcomes: unreadableOutcomeStore() })),
      (error: unknown) => {
        assert.ok(error instanceof StoreUnreadableError);
        assert.match(error.message, /the request outcome record/);
        assert.match(error.message, /connection refused/);
        assert.match(error.message, /indistinguishable/);
        return true;
      },
    );
  });

  it("fails when the last-success read is the one that breaks", async () => {
    const store = memoryRequestOutcomes();
    const broken = {
      ...store,
      lastSuccessAt() {
        return Promise.reject(new Error("the socket went away"));
      },
    };

    await assert.rejects(
      () => readHealthReport(deps({ outcomes: broken })),
      (error: unknown) => {
        assert.ok(error instanceof StoreUnreadableError);
        assert.match(error.message, /the last successful request for/);
        return true;
      },
    );
  });

  it("fails when the allowance counter cannot be read", async () => {
    const allowance = {
      ...createMemoryAllowanceStore(),
      read() {
        return Promise.reject(new Error("the counter is unreachable"));
      },
    };

    await assert.rejects(
      () => readHealthReport(deps({ allowance })),
      (error: unknown) => {
        assert.ok(error instanceof StoreUnreadableError);
        assert.match(error.message, /the allowance counter for/);
        return true;
      },
    );
  });
});

describe("AC-3, read through the health layer: counts over the window asked for", () => {
  it("carries the window and each source's counts onto the report", async () => {
    const clock = new FakeClock(NOW_MS);
    const report = await readHealthReport(
      deps({
        clock,
        outcomes: memoryRequestOutcomes([
          success(METERED, NOW_MS - MINUTE_MS),
          success(METERED, NOW_MS - 2 * MINUTE_MS),
          {
            sourceId: METERED,
            outcomeClass: "governor-refusal",
            durationMs: 0,
            recordedAt: new Date(NOW_MS - 8 * DAY_MS),
          },
        ]),
      }),
    );

    assert.equal(report.producedAt.getTime(), NOW_MS);
    assert.equal(report.window.end.getTime(), NOW_MS);
    assert.equal(report.window.start.getTime(), NOW_MS - 7 * DAY_MS);

    const metered = report.sources.find((source) => source.sourceId === METERED);
    assert.equal(metered?.counts.counts.success, 2);
    assert.equal(
      metered?.counts.counts["governor-refusal"],
      0,
      "a row older than the window was counted",
    );
    assert.equal(metered?.counts.total, 2);
  });
});
