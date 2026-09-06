/**
 * Acceptance criteria A1, A5 and A9 of spec S0036-deal-sentinel-alert-4:
 *
 *   A1. WHEN a rule fires for a listing THE SYSTEM SHALL deliver a notification
 *       carrying the identity of the rule that fired, the observed price with
 *       its ISO 4217 currency, the reference price that rule compared against
 *       with its currency, and a link that opens the listing the alert is about.
 *   A5. IF a price ending matches a retailer's community clearance pattern THEN
 *       THE SYSTEM SHALL carry it only as a corroborating tag on a notification
 *       some rule already fired, and SHALL send no notification for a listing
 *       whose only positive signal is that ending.
 *   A9. IF the listing a fired rule refers to has no link the owner can open
 *       THEN THE SYSTEM SHALL send no notification for it and SHALL report it
 *       as undeliverable naming the listing, rather than delivering an alert
 *       with a fabricated, absent or non-listing link.
 *
 * A5's second half is the one worth being careful about, and it is graded twice
 * here: once against the run, where a listing whose price ends in a configured
 * ending and whose rule did NOT fire produces no notification at all, and once
 * against the shape of the code - `composeNotification` takes a verdict that
 * fired, so there is no path from an ending to a notification to begin with.
 *
 * A9's refusal table is also where A14's "in its body" half is held down for the
 * listing link: a link carrying a credential, in its query string or in its
 * userinfo, is refused rather than printed into an alert. A14's own graded route
 * is `alert-channel.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeNotification,
  evaluateWindowLow,
  runAlertEvaluation,
} from "@deal-sentinel/alerts";
import type { AlertSubject, PricePoint, WindowLowRule } from "@deal-sentinel/alerts";
import {
  memoryAlertCooldowns,
  memoryAlertListings,
  memoryObservationHistory,
} from "@deal-sentinel/db";

import {
  DAY_MS,
  point,
  recordingChannel,
  testAlertConfig,
} from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const LINK = "https://www.example.invalid/site/cordless-drill-18v/8880044.p";

const RULE: WindowLowRule = {
  ruleId: "window-low-90d",
  kind: "window-low",
  windowMs: 30 * DAY_MS,
  minimumObservations: 3,
  improvementMinorUnits: 100n,
  cooldownMs: 7 * DAY_MS,
};

const SUBJECT: AlertSubject = {
  sourceId: "bestbuy-api",
  listingId: "8880044",
  listingUrl: LINK,
};

/** A series that a price of 8999 minor units beats by more than the margin. */
function history(currency = "USD"): PricePoint[] {
  return [
    point(12_999n, new Date(NOW.getTime() - 5 * DAY_MS), currency),
    point(10_999n, new Date(NOW.getTime() - 4 * DAY_MS), currency),
    point(11_999n, new Date(NOW.getTime() - 3 * DAY_MS), currency),
  ];
}

function firedVerdict(amountMinorUnits = 8_999n, currency = "USD") {
  const verdict = evaluateWindowLow(
    point(amountMinorUnits, NOW, currency),
    history(currency),
    RULE,
  );
  assert.equal(verdict.fired, true, "the fixture series should fire the rule");
  if (!verdict.fired) throw new Error("unreachable");
  return verdict;
}

describe("A1: every notification carries the rule, both prices and the link", () => {
  it("names the rule that fired", () => {
    const composed = composeNotification(firedVerdict(), SUBJECT);
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    assert.match(composed.notification.body, /window-low-90d/);
    assert.equal(composed.notification.ruleId, "window-low-90d");
  });

  it("carries the observed price with its ISO 4217 currency", () => {
    const composed = composeNotification(firedVerdict(), SUBJECT);
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    assert.match(composed.notification.body, /USD 89\.99/);
    assert.equal(composed.notification.observedMinorUnits, 8_999n);
    assert.equal(composed.notification.currency, "USD");
  });

  it("carries the reference price it was compared against, with its currency", () => {
    const composed = composeNotification(firedVerdict(), SUBJECT);
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    // 10999 is the lowest of the window, and it is what the alert says it beat.
    assert.match(composed.notification.body, /USD 109\.99/);
    assert.equal(composed.notification.referenceMinorUnits, 10_999n);
  });

  it("carries a link that opens the listing the alert is about", () => {
    const composed = composeNotification(firedVerdict(), SUBJECT);
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    assert.match(composed.notification.body, /www\.example\.invalid/);
    assert.equal(composed.notification.listingUrl, LINK);
  });

  it("prints a currency with no subdivision without inventing one", () => {
    // JPY has an exponent of zero. A formatter that assumed cents would print
    // "JPY 89.99" for 8999 yen, which is a wrong number in front of the owner.
    const composed = composeNotification(firedVerdict(8_999n, "JPY"), SUBJECT);
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    assert.match(composed.notification.body, /JPY 8999/);
    assert.doesNotMatch(composed.notification.body, /JPY 89\.99/);
  });

  it("delivers it: the whole run hands that body to the channel", async () => {
    const channel = recordingChannel();
    await runAlertEvaluation({
      config: testAlertConfig(),
      listings: memoryAlertListings([SUBJECT]),
      history: memoryObservationHistory({ "8880044": [...history(), point(8_999n, NOW)] }),
      cooldowns: memoryAlertCooldowns(),
      channel,
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    assert.equal(channel.delivered.length, 1);
    const body = channel.delivered[0].body;
    assert.match(body, /window-low-test/);
    assert.match(body, /USD 89\.99/);
    assert.match(body, /USD 109\.99/);
    assert.match(body, /www\.example\.invalid/);
  });
});

describe("A5: a clearance ending corroborates and never triggers", () => {
  it("attaches the tag to a notification a rule already fired", () => {
    // 8997 minor units ends in 97, and it also beats the window low by more
    // than the margin, so the rule fires on its own merits.
    const composed = composeNotification(firedVerdict(8_997n), SUBJECT, {
      clearanceEndings: ["97"],
    });
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    assert.equal(composed.notification.clearance?.ending, "97");
    assert.match(composed.notification.body, /corroborating tag only/);
    assert.match(composed.notification.body, /did not trigger this alert/);
  });

  it("attaches nothing when the ending does not match", () => {
    const composed = composeNotification(firedVerdict(8_999n), SUBJECT, {
      clearanceEndings: ["97"],
    });
    assert.equal(composed.composed, true);
    if (!composed.composed) return;

    assert.equal(composed.notification.clearance, null);
    assert.doesNotMatch(composed.notification.body, /corroborating/);
  });

  it("sends nothing for a listing whose only positive signal is the ending", async () => {
    const channel = recordingChannel();
    const report = await runAlertEvaluation({
      config: testAlertConfig({ clearanceEndings: { "bestbuy-api": ["97"] } }),
      listings: memoryAlertListings([SUBJECT]),
      history: memoryObservationHistory({
        // The latest observation ends in 97 and is the HIGHEST price in the
        // window. Nothing about it is a deal.
        "8880044": [...history(), point(13_997n, NOW)],
      }),
      cooldowns: memoryAlertCooldowns(),
      channel,
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    assert.deepEqual(channel.asked, [], "a price ending triggered a notification on its own");
    assert.equal(report.sources[0].delivered.length, 0);
    assert.equal(report.sources[0].undeliverable.length, 0);
    assert.equal(report.sources[0].failures.length, 0);
  });

  it("matches the digits of the exact minor-unit amount, and no float", () => {
    // 12.97 in USD is 1297 minor units. A matcher that formatted the price and
    // read the last two characters would agree here and disagree in JPY, where
    // there is no decimal point at all.
    const usd = composeNotification(firedVerdict(1_297n), SUBJECT, {
      clearanceEndings: ["97"],
    });
    assert.equal(usd.composed, true);
    if (!usd.composed) return;
    assert.equal(usd.notification.clearance?.ending, "97");

    const jpy = composeNotification(firedVerdict(1_297n, "JPY"), SUBJECT, {
      clearanceEndings: ["97"],
    });
    assert.equal(jpy.composed, true);
    if (!jpy.composed) return;
    assert.equal(jpy.notification.clearance?.ending, "97");
  });

  it("matches nothing at all when no ending is configured, which is what ships", () => {
    const composed = composeNotification(firedVerdict(8_997n), SUBJECT);
    assert.equal(composed.composed, true);
    if (!composed.composed) return;
    assert.equal(composed.notification.clearance, null);
  });
});

describe("A9: no link the owner can open means no alert", () => {
  const unusable: [string, string | null][] = [
    ["no link at all", null],
    ["an empty link", "   "],
    ["a relative path", "/site/cordless-drill/8880044.p"],
    ["a scheme that opens no listing", "javascript:alert(1)"],
    ["a link longer than any listing URL", `https://example.invalid/${"x".repeat(2100)}`],
    [
      "the vendor API URL, credential and all",
      "https://api.example.invalid/v1/products/8880044.json?show=sku&apiKey=SECRET-KEY",
    ],
    [
      "a link with a credential in its userinfo",
      "https://shopper:SECRET-KEY@www.example.invalid/site/drill/8880044.p",
    ],
    [
      "a link whose userinfo is a bare token",
      "https://SECRET-KEY@www.example.invalid/site/drill/8880044.p",
    ],
  ];

  for (const [what, listingUrl] of unusable) {
    it(`refuses to compose one for ${what}`, () => {
      const composed = composeNotification(firedVerdict(), { ...SUBJECT, listingUrl });

      assert.equal(composed.composed, false);
      if (composed.composed) return;
      assert.equal(composed.reason, "undeliverable-link");
      assert.equal(composed.listingId, "8880044");
      assert.match(composed.detail, /8880044/);
      // The refusal never quotes the link: three of the cases above ARE a
      // credential, in the query string and in the userinfo, and a report is a
      // thing people paste into an issue.
      assert.doesNotMatch(composed.detail, /SECRET-KEY/);
    });
  }

  it("reports it as undeliverable naming the listing, and delivers nothing for it", async () => {
    const channel = recordingChannel();
    const report = await runAlertEvaluation({
      config: testAlertConfig(),
      listings: memoryAlertListings([
        { sourceId: "bestbuy-api", listingId: "8880044", listingUrl: null },
        { sourceId: "bestbuy-api", listingId: "8880045", listingUrl: LINK },
      ]),
      history: memoryObservationHistory({
        "8880044": [...history(), point(8_999n, NOW)],
        "8880045": [...history(), point(8_999n, NOW)],
      }),
      cooldowns: memoryAlertCooldowns(),
      channel,
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    const source = report.sources[0];
    assert.equal(source.undeliverable.length, 1);
    assert.equal(source.undeliverable[0].listingId, "8880044");
    assert.equal(source.undeliverable[0].ruleId, "window-low-test");
    assert.deepEqual(
      channel.asked.map((notification) => notification.listingId),
      ["8880045"],
      "an alert was offered for a listing with no link, or the next listing was skipped",
    );
  });

  it("records no cooldown for a listing it could not deliver", async () => {
    const cooldowns = memoryAlertCooldowns();
    await runAlertEvaluation({
      config: testAlertConfig(),
      listings: memoryAlertListings([
        { sourceId: "bestbuy-api", listingId: "8880044", listingUrl: null },
      ]),
      history: memoryObservationHistory({ "8880044": [...history(), point(8_999n, NOW)] }),
      cooldowns,
      channel: recordingChannel(),
      clock: new FakeClock(NOW.getTime()),
      sourceIds: ["bestbuy-api"],
    });

    assert.equal(
      await cooldowns.read("bestbuy-api", "8880044", "window-low-test"),
      null,
      "an undelivered alert went quiet for a week",
    );
  });
});
