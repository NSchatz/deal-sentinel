/**
 * Refuter artifact for S0066-deal-sentinel-ops-5, impl gate ordinal 1, finding
 * F1. This file DOCUMENTS a defect; it does not fix it.
 *
 * AC-3 fixes the window the system answers for: "at or after the window start
 * and strictly before the window end". The dashboard shows exactly one window
 * (`model.window`, printed in the header as "window <start> to <end>") and
 * AC-13 says the chart draws one mark per observation "in the shown window".
 *
 * `buildDashboardModel` hands that same window to `ObservationSeriesStore`,
 * which answers by the OPPOSITE convention (`after < observedAt <= until`). So
 * an observation recorded at exactly `window.start` is inside the window the
 * page prints and inside the window the counts answer for, and no mark is
 * drawn for it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  memoryObservationSeries,
  memoryRequestOutcomes,
  memoryWatchlist,
} from "@deal-sentinel/db";
import { createMemoryAllowanceStore } from "@deal-sentinel/governor";
import { buildDashboardModel } from "@deal-sentinel/ops";

import { FakeClock } from "../support/fake-clock.ts";
import {
  DAY_MS,
  NOW_MS,
  noPauses,
  testOpsConfig,
} from "../support/ops-5-harness.ts";
import { bestBuyGovernorConfig } from "../support/source-3-harness.ts";

const SOURCE = "bestbuy-api";
const LISTING = "8880044";
const WINDOW_START_MS = NOW_MS - 7 * DAY_MS;

describe("regress 0066 F1: the chart drops an observation the page says is in window", () => {
  it("draws a mark for an observation recorded at exactly the window start", async () => {
    const model = await buildDashboardModel({
      config: testOpsConfig(),
      governorConfig: bestBuyGovernorConfig({ sources: { [SOURCE]: {} } }),
      // The record convention AC-3 fixes: this success is AT the window start
      // and is counted, which is what makes the window the page prints closed
      // at that end.
      outcomes: memoryRequestOutcomes([
        {
          sourceId: SOURCE,
          outcomeClass: "success",
          durationMs: 12,
          recordedAt: new Date(WINDOW_START_MS),
        },
      ]),
      allowance: createMemoryAllowanceStore(),
      pauses: noPauses,
      clock: new FakeClock(NOW_MS),
      watchlist: memoryWatchlist([
        { sourceId: SOURCE, listingId: LISTING, enabled: true },
      ]),
      series: memoryObservationSeries({
        [LISTING]: [
          {
            amountMinorUnits: 12999n,
            currency: "USD",
            observedAt: new Date(WINDOW_START_MS),
            availability: "InStock",
          },
        ],
      }),
    });

    assert.equal(
      model.window.start.getTime(),
      WINDOW_START_MS,
      "the window this page prints does not begin where this test assumed",
    );

    const counted = model.sources.find((card) => card.sourceId === SOURCE);
    assert.ok(counted !== undefined);
    assert.ok(counted.counts.known, "the counts for this source were unavailable");
    assert.equal(
      counted.counts.known && counted.counts.value.counts.success,
      1,
      "the record at the window start is not counted, so AC-3's convention is " +
        "not what the page reports",
    );

    const listing = model.listings.find((entry) => entry.listingId === LISTING);
    assert.ok(listing !== undefined, "the tracked listing lost its section");
    assert.equal(
      listing.points.length,
      1,
      "AC-13: one observation sits inside the window the page prints, and the " +
        "chart is given none to draw",
    );
  });
});
