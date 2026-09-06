/**
 * REGRESSION SUITE - spec S0036-deal-sentinel-alert-4, impl gate ordinal 1,
 * finding F1. The first case here is the refuter's own artifact, unchanged; the
 * rest close the other half of the same blind spot.
 *
 * Run on its own, exactly as the gate ran it:
 *
 *   node --test test/unit/regress_0036_F1.ts
 *
 * Acceptance criterion A14:
 *
 *   WHEN a notification is delivered, stored or reported THE SYSTEM SHALL
 *   include no credential and no credential-bearing URL in its body, in any
 *   stored alert record, or in any reported failure detail.
 *
 * THE DEFECT. A URL keeps a credential in three places - the userinfo, the
 * query, and the path when the path is a topic. `packages/alerts/src/redaction.ts`
 * scrubbed two of them (the secret it was handed, and the value of a
 * credential-bearing query parameter) and `usableLink` in
 * `packages/alerts/src/notification.ts` tested a listing link with that same
 * query-parameter rule alone. So `https://user:password@host/path` walked
 * through both: an endpoint quoted verbatim inside a governor refusal reached a
 * reported failure detail, and a listing link reached the notification BODY and
 * the link header.
 *
 * THE FIX, and what each case below holds down:
 *
 *   1. the redactor treats userinfo as credential-bearing, so any URL any other
 *      component quotes back at this package is scrubbed before it is reported;
 *   2. `usableLink` refuses a userinfo link on that same authority, so it is
 *      never printed into an alert;
 *   3. the channel does not send to a userinfo endpoint at all, so no request,
 *      no transport error and no governor refusal is ever composed around one.
 *
 * Nothing here reaches anything: the refusals under test all happen before a
 * byte leaves the process, and every case asserts the recording transport is
 * empty or is never given a chance to record.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  channelRedactor,
  composeNotification,
  evaluateWindowLow,
  governedChannel,
} from "@deal-sentinel/alerts";
import type {
  AlertNotification,
  AlertSubject,
  PricePoint,
  WindowLowRule,
} from "@deal-sentinel/alerts";

import { DAY_MS, point, testAlertConfig } from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";
import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const PASSWORD = "hunter2-not-a-real-password";
const ENDPOINT = `https://alerts:${PASSWORD}@notify.example.invalid/deals`;
const LINK_PASSWORD = "swordfish-not-a-real-password";
const CREDENTIAL_LINK = `https://shopper:${LINK_PASSWORD}@retailer.example.invalid/p/8880044`;

function notification(): AlertNotification {
  return {
    ruleId: "window-low-test",
    sourceId: "bestbuy-api",
    listingId: "8880044",
    title: "USD 89.99 on 8880044 (window-low-test)",
    body:
      "window-low-test fired for bestbuy-api/8880044.\nObserved USD 89.99.\n" +
      "It beats USD 109.99.\nhttps://www.example.invalid/site/drill/8880044.p",
    listingUrl: "https://www.example.invalid/site/drill/8880044.p",
    observedMinorUnits: 8_999n,
    referenceMinorUnits: 10_999n,
    currency: "USD",
    clearance: null,
  };
}

describe("A14 regression: a userinfo credential in the channel endpoint", () => {
  it("is not carried into a reported failure detail", async () => {
    const clock = new FakeClock(NOW.getTime());
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      config: testConfig({
        // No ceiling for the channel's host, so the governor's first gate
        // refuses before anything leaves the process.
        hosts: {
          "127.0.0.1": {
            maxRequests: 10,
            intervalMs: 60_000,
            minDelayMs: 1,
            jitterMs: 1,
          },
        },
        sources: { "alert-channel": {} },
      }),
    });

    const config = testAlertConfig({ channel: { endpoint: ENDPOINT } });
    // The loader accepted a URL with a password in it, without comment.
    assert.equal(config.channel.endpoint?.includes(PASSWORD), true);

    const channel = governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: null,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.deepEqual(transport.sent, [], "something left the process");

    assert.equal(
      outcome.detail.includes(PASSWORD),
      false,
      "the operator's channel password was carried into a reported failure " +
        `detail: ${outcome.detail}`,
    );
  });

  it("is refused before a request is spent, and the channel is named by origin", async () => {
    const clock = new FakeClock(NOW.getTime());
    const transport = recordingTransport(clock, robotsAbsent());
    const { governor } = buildGovernor({
      transport,
      clock,
      // A ceiling the channel's host DOES have, so the only thing that can
      // refuse this delivery is the endpoint's own userinfo.
      config: testConfig({
        hosts: {
          "notify.example.invalid": {
            maxRequests: 10,
            intervalMs: 60_000,
            minDelayMs: 1,
            jitterMs: 1,
          },
        },
        sources: { "alert-channel": {} },
      }),
    });

    const config = testAlertConfig({ channel: { endpoint: ENDPOINT } });
    const channel = governedChannel({
      governor,
      config: config.channel,
      sourceId: config.sourceId,
      credential: null,
    });

    const outcome = await channel.deliver(notification());

    assert.equal(outcome.delivered, false);
    if (outcome.delivered) return;
    assert.equal(outcome.kind, "unconfigured");
    assert.deepEqual(transport.sent, [], "a credential-bearing URL was sent");
    assert.equal(outcome.detail.includes(PASSWORD), false);
    assert.doesNotMatch(
      outcome.detail,
      /@notify\.example\.invalid/,
      "the refusal quoted the endpoint's userinfo",
    );
    assert.match(outcome.detail, /https:\/\/notify\.example\.invalid/);
    assert.equal(channel.describedAs, "https://notify.example.invalid");
  });
});

describe("A14 regression: the redactor treats userinfo as a credential", () => {
  it("scrubs the userinfo out of a URL quoted inside a sentence", () => {
    const scrubbed = channelRedactor(null).scrub(
      "notify.example.invalid carries no configured request ceiling, so the " +
        `request to ${ENDPOINT} is refused.`,
    );

    assert.equal(scrubbed.includes(PASSWORD), false);
    assert.equal(scrubbed.includes("alerts:"), false);
    assert.match(scrubbed, /https:\/\/\[redacted\]@notify\.example\.invalid\/deals/);
  });

  it("scrubs a user name with no password, which is a credential too", () => {
    const scrubbed = channelRedactor(null).scrub(
      "the request to https://tk-not-a-real-token@notify.example.invalid/deals failed",
    );

    assert.equal(scrubbed.includes("tk-not-a-real-token"), false);
  });

  it("leaves an @ that is not userinfo alone", () => {
    const text =
      "https://retailer.example.invalid/p/8880044?notify=owner@example.invalid " +
      "and https://retailer.example.invalid/user@handle/reviews";

    assert.equal(channelRedactor(null).scrub(text), text);
  });
});

const RULE: WindowLowRule = {
  ruleId: "window-low-test",
  kind: "window-low",
  windowMs: 30 * DAY_MS,
  minimumObservations: 3,
  improvementMinorUnits: 100n,
  cooldownMs: 7 * DAY_MS,
};

function history(): PricePoint[] {
  return [
    point(12_999n, new Date(NOW.getTime() - 5 * DAY_MS)),
    point(10_999n, new Date(NOW.getTime() - 4 * DAY_MS)),
    point(11_999n, new Date(NOW.getTime() - 3 * DAY_MS)),
  ];
}

function firedVerdict() {
  const verdict = evaluateWindowLow(point(8_999n, NOW), history(), RULE);
  assert.equal(verdict.fired, true, "the fixture series should fire the rule");
  if (!verdict.fired) throw new Error("unreachable");
  return verdict;
}

describe("A14 regression: a userinfo credential in the owner's listing link", () => {
  const subject: AlertSubject = {
    sourceId: "bestbuy-api",
    listingId: "8880044",
    listingUrl: CREDENTIAL_LINK,
  };

  it("is never printed into a notification body or a link header", () => {
    const composed = composeNotification(firedVerdict(), subject);

    assert.equal(
      composed.composed,
      false,
      "a link carrying a password was composed into an alert",
    );
    if (composed.composed) return;
    assert.equal(composed.reason, "undeliverable-link");
    assert.equal(composed.listingId, "8880044");
    assert.equal(
      composed.detail.includes(LINK_PASSWORD),
      false,
      `the refusal quoted the credential-bearing link: ${composed.detail}`,
    );
    assert.match(composed.detail, /8880044/);
  });

  it("still composes the same alert once the credential is out of the link", () => {
    const clean = "https://retailer.example.invalid/p/8880044";
    const composed = composeNotification(firedVerdict(), {
      ...subject,
      listingUrl: clean,
    });

    assert.equal(composed.composed, true);
    if (!composed.composed) return;
    assert.equal(composed.notification.listingUrl, clean);
    assert.match(composed.notification.body, /retailer\.example\.invalid/);
  });
});
