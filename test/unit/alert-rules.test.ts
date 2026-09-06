/**
 * Acceptance criteria A2, A4, A6, A7 and A8 of spec
 * S0036-deal-sentinel-alert-4:
 *
 *   A2. IF a listing holds fewer observations inside a rule's configured window
 *       than that rule's configured minimum THEN THE SYSTEM SHALL NOT evaluate
 *       that rule against that listing and SHALL send no notification for it.
 *   A4. WHEN a rule is evaluated against a synthetic series THE SYSTEM SHALL
 *       return the same verdict on every run, taking no input but the
 *       observation, the history window and the rule configuration, and reading
 *       no wall clock, no randomness, no database and no environment of its own.
 *   A6. WHEN a listing has no stored observation at all inside a rule's window
 *       THE SYSTEM SHALL evaluate that rule against nothing, send no
 *       notification, and report the listing as skipped rather than failing the
 *       evaluation run.
 *   A7. IF an observation's currency differs from the currency of an
 *       observation it would be compared against THEN THE SYSTEM SHALL evaluate
 *       no rule across that pair and SHALL report the mismatch naming the
 *       listing, rather than comparing the two numbers.
 *   A8. WHEN prices are compared or carried into a notification THE SYSTEM
 *       SHALL use exact integer minor units throughout and SHALL introduce no
 *       floating-point value on the path from a stored observation to a
 *       delivered notification.
 *
 * A4 is graded by DENYING THE FUNCTION the things it must not read: the wall
 * clock and the randomness source are replaced with throwing stubs for the
 * duration of the call, so a verdict that comes back at all is a verdict that
 * touched neither. The database and the environment are denied structurally -
 * the function's three arguments are its only inputs - and the run-level halves
 * of A2, A6 and A7 are graded here too, against in-memory stores, because
 * "sends no notification" and "reports the listing" are statements about the
 * run and not about the pure decision.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateWindowLow, runAlertEvaluation } from "@deal-sentinel/alerts";
import type { WindowLowRule } from "@deal-sentinel/alerts";
import {
  memoryAlertCooldowns,
  memoryAlertListings,
  memoryObservationHistory,
} from "@deal-sentinel/db";

import {
  DAY_MS,
  flatSeries,
  point,
  recordingChannel,
  testAlertConfig,
} from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");

const RULE: WindowLowRule = {
  ruleId: "window-low-test",
  kind: "window-low",
  windowMs: 30 * DAY_MS,
  minimumObservations: 3,
  improvementMinorUnits: 100n,
  cooldownMs: 7 * DAY_MS,
};

function rule(overrides: Partial<WindowLowRule> = {}): WindowLowRule {
  return { ...RULE, ...overrides };
}

describe("A2: a rule is not evaluated against a listing with too little history", () => {
  it("refuses below the configured minimum, naming the count and the rule", () => {
    const history = flatSeries({
      count: 2,
      amountMinorUnits: 10_000n,
      endingAt: new Date(NOW.getTime() - DAY_MS),
    });

    const verdict = evaluateWindowLow(point(1n, NOW), history, rule({ minimumObservations: 3 }));

    assert.equal(verdict.fired, false);
    if (verdict.fired) return;
    assert.equal(verdict.reason, "insufficient-history");
    assert.match(verdict.detail, /2 observation\(s\) inside the window/);
    assert.match(verdict.detail, /requires 3/);
  });

  it("evaluates the same series once the minimum is met", () => {
    const history = flatSeries({
      count: 3,
      amountMinorUnits: 10_000n,
      endingAt: new Date(NOW.getTime() - DAY_MS),
    });

    const verdict = evaluateWindowLow(point(1n, NOW), history, rule({ minimumObservations: 3 }));

    assert.equal(verdict.fired, true, "three observations should be enough for a minimum of three");
  });

  it("counts only what is INSIDE the window, not the listing's whole history", () => {
    // Five observations, but three of them are older than the window. A count
    // taken over everything stored would evaluate a listing that has been
    // watched for two days, which is exactly what this criterion forbids.
    const history = [
      ...flatSeries({
        count: 3,
        amountMinorUnits: 10_000n,
        endingAt: new Date(NOW.getTime() - 40 * DAY_MS),
      }),
      ...flatSeries({
        count: 2,
        amountMinorUnits: 10_000n,
        endingAt: new Date(NOW.getTime() - DAY_MS),
      }),
    ];

    const verdict = evaluateWindowLow(point(1n, NOW), history, rule({ minimumObservations: 3 }));

    assert.equal(verdict.fired, false);
    if (verdict.fired) return;
    assert.equal(verdict.reason, "insufficient-history");
    assert.equal(verdict.windowCount, 2);
  });

  it("sends no notification for it, and the run reports the skip", async () => {
    const channel = recordingChannel();
    const report = await runAlertEvaluation({
      config: testAlertConfig(),
      listings: memoryAlertListings([
        {
          sourceId: "bestbuy-api",
          listingId: "8880044",
          listingUrl: "https://example.invalid/tools/drill",
        },
      ]),
      history: memoryObservationHistory({
        // One observation only: it is the observation under test, and there is
        // nothing behind it.
        "8880044": [point(1_000n, NOW)],
      }),
      cooldowns: memoryAlertCooldowns(),
      channel,
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    assert.deepEqual(channel.asked, [], "a notification was offered for a listing with no history");
    const source = report.sources[0];
    assert.deepEqual(source.considered, ["8880044"]);
    assert.equal(source.skipped.length, 1);
    assert.equal(source.skipped[0].listingId, "8880044");
    assert.equal(source.skipped[0].reason, "empty-window");
  });
});

describe("A6: a listing with no observation inside the window is skipped, not failed", () => {
  it("reports an empty window rather than throwing", () => {
    const verdict = evaluateWindowLow(point(1n, NOW), [], rule());

    assert.equal(verdict.fired, false);
    if (verdict.fired) return;
    assert.equal(verdict.reason, "empty-window");
    assert.equal(verdict.windowCount, 0);
  });

  it("treats history that all falls outside the window as an empty one", () => {
    const history = flatSeries({
      count: 10,
      amountMinorUnits: 10_000n,
      endingAt: new Date(NOW.getTime() - 60 * DAY_MS),
    });

    const verdict = evaluateWindowLow(point(1n, NOW), history, rule());

    assert.equal(verdict.fired, false);
    if (verdict.fired) return;
    assert.equal(verdict.reason, "empty-window");
  });

  it("completes the run, reports the listing, and still evaluates the next one", async () => {
    const channel = recordingChannel();
    const report = await runAlertEvaluation({
      config: testAlertConfig(),
      listings: memoryAlertListings([
        { sourceId: "bestbuy-api", listingId: "nothing-stored", listingUrl: "https://example.invalid/a" },
        { sourceId: "bestbuy-api", listingId: "has-history", listingUrl: "https://example.invalid/b" },
      ]),
      history: memoryObservationHistory({
        "has-history": [
          ...flatSeries({
            count: 4,
            amountMinorUnits: 10_000n,
            endingAt: new Date(NOW.getTime() - DAY_MS),
          }),
          point(5_000n, NOW),
        ],
      }),
      cooldowns: memoryAlertCooldowns(),
      channel,
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    const source = report.sources[0];
    assert.deepEqual(source.considered, ["nothing-stored", "has-history"]);
    assert.equal(source.skipped.length, 1);
    assert.equal(source.skipped[0].listingId, "nothing-stored");
    assert.equal(source.skipped[0].reason, "no-observation");
    assert.equal(
      source.delivered.length,
      1,
      "one listing having no history stopped the next one being evaluated",
    );
    assert.equal(source.delivered[0].listingId, "has-history");
  });
});

describe("A7: two currencies are never compared", () => {
  it("refuses the pair and names both currencies", () => {
    const history = [
      point(10_000n, new Date(NOW.getTime() - 3 * DAY_MS)),
      point(9_000n, new Date(NOW.getTime() - 2 * DAY_MS), "JPY"),
      point(10_000n, new Date(NOW.getTime() - DAY_MS)),
    ];

    const verdict = evaluateWindowLow(point(1n, NOW), history, rule());

    assert.equal(verdict.fired, false);
    if (verdict.fired) return;
    assert.equal(verdict.reason, "currency-mismatch");
    assert.match(verdict.detail, /USD/);
    assert.match(verdict.detail, /JPY/);
  });

  it("refuses even when the mismatched number would have made it fire", () => {
    // 1 JPY is a smaller INTEGER than 10000 USD minor units and a larger amount
    // of money. This is the case that produces a confident all-time low that is
    // arithmetic about nothing.
    const history = [
      point(10_000n, new Date(NOW.getTime() - 3 * DAY_MS)),
      point(10_000n, new Date(NOW.getTime() - 2 * DAY_MS)),
      point(1n, new Date(NOW.getTime() - DAY_MS), "JPY"),
    ];

    const verdict = evaluateWindowLow(point(5_000n, NOW), history, rule());

    assert.equal(verdict.fired, false);
    if (verdict.fired) return;
    assert.equal(verdict.reason, "currency-mismatch");
  });

  it("the run reports the mismatch naming the listing, and sends nothing", async () => {
    const channel = recordingChannel();
    const report = await runAlertEvaluation({
      config: testAlertConfig(),
      listings: memoryAlertListings([
        {
          sourceId: "bestbuy-api",
          listingId: "mixed-currency",
          listingUrl: "https://example.invalid/tools/drill",
        },
      ]),
      history: memoryObservationHistory({
        "mixed-currency": [
          point(10_000n, new Date(NOW.getTime() - 3 * DAY_MS)),
          point(10_000n, new Date(NOW.getTime() - 2 * DAY_MS)),
          point(9_000n, new Date(NOW.getTime() - DAY_MS), "JPY"),
          point(1_000n, NOW),
        ],
      }),
      cooldowns: memoryAlertCooldowns(),
      channel,
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    assert.deepEqual(channel.asked, []);
    const source = report.sources[0];
    assert.equal(source.mismatches.length, 1);
    assert.equal(source.mismatches[0].listingId, "mixed-currency");
    assert.equal(source.mismatches[0].ruleId, "window-low-test");
    assert.equal(source.delivered.length, 0);
  });
});

describe("A8: exact integer minor units, and no float anywhere on the path", () => {
  it("compares amounts a double could not tell apart", () => {
    // 2^53 and 2^53 + 1 are the same IEEE-754 double. As bigints they are one
    // minor unit apart, and the margin below is exactly that unit.
    const justOver = 9_007_199_254_740_993n;
    const justUnder = 9_007_199_254_740_992n;

    const history = flatSeries({
      count: 3,
      amountMinorUnits: justOver,
      endingAt: new Date(NOW.getTime() - DAY_MS),
    });

    const fires = evaluateWindowLow(
      point(justUnder, NOW),
      history,
      rule({ improvementMinorUnits: 1n }),
    );
    assert.equal(fires.fired, true, "a one-minor-unit improvement at 2^53 was lost");

    const quiet = evaluateWindowLow(
      point(justOver, NOW),
      history,
      rule({ improvementMinorUnits: 1n }),
    );
    assert.equal(quiet.fired, false, "an equal price fired a rule that needs an improvement");
  });

  it("treats the margin as an exact boundary: meeting it fires, one short does not", () => {
    const history = flatSeries({
      count: 3,
      amountMinorUnits: 10_000n,
      endingAt: new Date(NOW.getTime() - DAY_MS),
    });

    const exactly = evaluateWindowLow(point(9_900n, NOW), history, rule());
    assert.equal(exactly.fired, true, "a price exactly at the margin did not fire");

    const oneShort = evaluateWindowLow(point(9_901n, NOW), history, rule());
    assert.equal(oneShort.fired, false, "a price one minor unit short of the margin fired");
  });

  it("hands back bigints, so nothing downstream can be handed a rounded price", () => {
    const history = flatSeries({
      count: 3,
      amountMinorUnits: 10_000n,
      endingAt: new Date(NOW.getTime() - DAY_MS),
    });
    const verdict = evaluateWindowLow(point(5_000n, NOW), history, rule());

    assert.equal(verdict.fired, true);
    if (!verdict.fired) return;
    assert.equal(typeof verdict.observed.amountMinorUnits, "bigint");
    assert.equal(typeof verdict.reference.amountMinorUnits, "bigint");
    assert.equal(verdict.reference.amountMinorUnits, 10_000n);
  });
});

describe("A4: the same verdict on every run, from the arguments alone", () => {
  /**
   * Run `body` with the wall clock and the randomness source replaced by stubs
   * that throw. Anything that reads either one fails loudly instead of quietly
   * producing a verdict nobody can reproduce.
   */
  function withoutClockOrRandomness<T>(body: () => T): T {
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => {
      throw new Error("the rule read the wall clock");
    };
    Math.random = () => {
      throw new Error("the rule read a randomness source");
    };
    try {
      return body();
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  }

  const history = [
    point(12_000n, new Date(NOW.getTime() - 5 * DAY_MS)),
    point(11_000n, new Date(NOW.getTime() - 4 * DAY_MS)),
    point(10_500n, new Date(NOW.getTime() - 3 * DAY_MS)),
    point(11_500n, new Date(NOW.getTime() - 2 * DAY_MS)),
  ];

  it("reads neither the wall clock nor a randomness source", () => {
    const verdict = withoutClockOrRandomness(() =>
      evaluateWindowLow(point(9_000n, NOW), history, rule()),
    );

    assert.equal(verdict.fired, true);
    if (!verdict.fired) return;
    assert.equal(verdict.reference.amountMinorUnits, 10_500n);
  });

  it("returns an identical verdict on a hundred runs", () => {
    const first = JSON.stringify(
      evaluateWindowLow(point(9_000n, NOW), history, rule()),
      replacer,
    );
    for (let run = 0; run < 100; run += 1) {
      assert.equal(
        JSON.stringify(evaluateWindowLow(point(9_000n, NOW), history, rule()), replacer),
        first,
        `run ${run} disagreed with run 0`,
      );
    }
  });

  it("does not depend on the order the history came back in", () => {
    const forwards = evaluateWindowLow(point(9_000n, NOW), history, rule());
    const backwards = evaluateWindowLow(point(9_000n, NOW), [...history].reverse(), rule());

    assert.equal(
      JSON.stringify(forwards, replacer),
      JSON.stringify(backwards, replacer),
      "the verdict depends on row order, so it depends on the query and not the data",
    );
  });

  it("breaks a tie on the earlier instant, so the reference is not row order either", () => {
    const earlier = point(10_000n, new Date(NOW.getTime() - 4 * DAY_MS));
    const later = point(10_000n, new Date(NOW.getTime() - 2 * DAY_MS));
    const filler = point(12_000n, new Date(NOW.getTime() - 3 * DAY_MS));

    for (const order of [
      [earlier, filler, later],
      [later, filler, earlier],
    ]) {
      const verdict = evaluateWindowLow(point(5_000n, NOW), order, rule());
      assert.equal(verdict.fired, true);
      if (!verdict.fired) return;
      assert.equal(verdict.reference.observedAt.toISOString(), earlier.observedAt.toISOString());
    }
  });

  it("anchors the window on the observation's own instant, not on any later one", () => {
    // The same series and the same price, observed a year later. Every stored
    // point is then outside the window, and the answer changes for that reason
    // and for no other - which is what makes the verdict a fact about the
    // observation rather than about when somebody ran the evaluation.
    const inSeason = evaluateWindowLow(point(9_000n, NOW), history, rule());
    assert.equal(inSeason.fired, true);

    const aYearLater = evaluateWindowLow(
      point(9_000n, new Date(NOW.getTime() + 365 * DAY_MS)),
      history,
      rule(),
    );
    assert.equal(aYearLater.fired, false);
    if (aYearLater.fired) return;
    assert.equal(aYearLater.reason, "empty-window");
  });
});

/** `JSON.stringify` cannot serialise a bigint; the verdicts carry several. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}
