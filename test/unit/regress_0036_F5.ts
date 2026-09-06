/**
 * REGRESSION GUARD for acceptance criterion A14 of spec
 * S0036-deal-sentinel-alert-4. Its three cases came from the implementation
 * gate's ordinal-2 artifact
 * (`work/specs/S0036-deal-sentinel-alert-4/regress_0036_F5.ts`, finding F5) and
 * are unchanged from it, byte for byte, below this header. They failed when
 * they were written. Nothing here may be relaxed to keep them passing.
 *
 *   A14. WHEN a notification is delivered, stored or reported THE SYSTEM SHALL
 *        include no credential and no credential-bearing URL in its body, in
 *        any stored alert record, or in any reported failure detail.
 *
 * THE DEFECT THEY CAUGHT. `governedChannel` composes its `failed` detail as
 * `${describedAs} ... - ${outcome.detail}`, and the governor quotes `url.href`
 * verbatim inside its own detail - the whole endpoint, path and query included
 * (`packages/governor/src/governor.ts:304` for `unconfigured-host`, `:642` for
 * a transport error), which it is right to do, because it cannot know which of
 * its callers configured a secret into a URL. `run.ts` copies that string into
 * `AlertSourceReport.failures[].detail`, the exact surface A14 names. The scrub
 * it went through was three DENYLIST rules - the credential the redactor was
 * handed, the value of a query parameter on a seven-entry list, and the
 * userinfo - and a credential living in the PATH is on none of them. On the
 * channel this spec's manifest carries, the path IS the credential: the source
 * `work/specs/S0036-deal-sentinel-alert-4/sources/docs.ntfy.sh-publish` says
 * "Because there is no sign-up, the topic is essentially a password". Nor did
 * the list reach a parameter named one character off it, `auth_token`.
 *
 * WHAT MAKES THEM PASS. A fourth rule in `packages/alerts/src/redaction.ts`,
 * `redactEndpointUrls`, which does not filter the endpoint but REPLACES it:
 * every occurrence of the configured endpoint, and of any URL sharing its
 * origin, is cut back to that origin before a detail is composed. The property
 * is "the endpoint does not appear in a reported string", which needs nobody to
 * have guessed which component of it was the secret.
 *
 * Nothing here reaches anything: every case is refused by the governor's FIRST
 * gate, a host with no configured ceiling, and each asserts the recording
 * transport stayed empty.
 *
 * Run it:
 *
 *   cd deal-sentinel && node --test test/unit/regress_0036_F5.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { governedChannel } from "@deal-sentinel/alerts";
import type { AlertNotification } from "@deal-sentinel/alerts";

import { testAlertConfig } from "../support/alert-harness.ts";
import { FakeClock } from "../support/fake-clock.ts";
import {
  buildGovernor,
  recordingTransport,
  robotsAbsent,
  testConfig,
} from "../support/governor-harness.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** The ntfy topic shape the cited source calls "essentially a password". */
const TOPIC = "kitchen-deals-not-a-real-topic";
const TOPIC_ENDPOINT = `https://notify.example.invalid/${TOPIC}`;

/** A query credential under a name the seven-entry list does not carry. */
const QUERY_SECRET = "s3cr3t-not-a-real-token";
const QUERY_ENDPOINT = `https://notify.example.invalid/hook?auth_token=${QUERY_SECRET}`;

/** The exact shape the cited source documents: a topic plus `?auth=`. */
const LISTED_SECRET = "tk-not-a-real-access-token";
const NTFY_ENDPOINT = `https://notify.example.invalid/${TOPIC}?auth=${LISTED_SECRET}`;

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

/**
 * Deliver one notification through a governor that carries NO ceiling for the
 * channel's host, and hand back the failure detail the run would report. The
 * refusal is the governor's first gate, so nothing is sent.
 */
async function reportedFailureDetail(endpoint: string): Promise<string> {
  const clock = new FakeClock(NOW.getTime());
  const transport = recordingTransport(clock, robotsAbsent());
  const { governor } = buildGovernor({
    transport,
    clock,
    config: testConfig({
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

  const config = testAlertConfig({ channel: { endpoint } });
  const channel = governedChannel({
    governor,
    config: config.channel,
    sourceId: config.sourceId,
    credential: null,
  });

  const outcome = await channel.deliver(notification());

  assert.equal(outcome.delivered, false, "the delivery was not refused");
  if (outcome.delivered) throw new Error("unreachable");
  assert.deepEqual(transport.sent, [], "something left the process");
  return outcome.detail;
}

describe("A14 regression: the endpoint reaches a reported failure detail", () => {
  it("does not carry the channel's topic path", async () => {
    const detail = await reportedFailureDetail(TOPIC_ENDPOINT);

    assert.equal(
      detail.includes(TOPIC),
      false,
      "the channel's topic - which redaction.ts and the cited source both " +
        `call a password - was carried into a reported failure detail: ${detail}`,
    );
  });

  it("does not carry a query credential the parameter list does not name", async () => {
    const detail = await reportedFailureDetail(QUERY_ENDPOINT);

    assert.equal(
      detail.includes(QUERY_SECRET),
      false,
      "the operator's channel token was carried into a reported failure " +
        `detail: ${detail}`,
    );
  });

  it("does not carry the topic even when the query credential IS redacted", async () => {
    // The shape `alert-channel.test.ts` already covers, read the other way
    // round: that test asserts the detail MATCHES /auth=\[redacted\]/, which is
    // an assertion that the whole endpoint reached the report. The value is
    // gone; the topic beside it is not.
    const detail = await reportedFailureDetail(NTFY_ENDPOINT);

    assert.equal(detail.includes(LISTED_SECRET), false, "the query value leaked too");
    assert.equal(
      detail.includes(TOPIC),
      false,
      `the topic survived a scrub that redacted only the query value: ${detail}`,
    );
  });
});
