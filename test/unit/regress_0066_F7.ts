/**
 * Refuter artifact for S0066-deal-sentinel-ops-5, impl gate ordinal 3, finding
 * F7. This file DOCUMENTS a defect; it does not fix it.
 *
 * NOT the cached-replay case. That one was carved out of this spec by the
 * conductor ruling of 2026-09-13 and belongs to
 * S0140-deal-sentinel-cached-robots-refusal-class. This case is the request
 * whose OWN `/robots.txt` retrieval left and failed - the one the narrowing
 * explicitly KEPT inside AC-2, in AC-2's own words.
 *
 * AC-2 as narrowed:
 *
 *   WHEN a request is refused by the system's own governor on a decision taken
 *   for THAT request, whether by a robots retrieval made for it, the breaker or
 *   an exhausted allowance, THE SYSTEM SHALL record it under an outcome class
 *   distinct from a third-party block and distinct from a transport error
 *
 * A `/robots.txt` retrieval made FOR this request answered 503. RFC 9309
 * 2.3.1.4 makes the host completely disallowed, gate 5 applies that rule and
 * `#robotsGate` refuses the request with `robots-unreachable`. That is a
 * refusal by this system's own governor, on a decision taken for that request,
 * by a robots retrieval made for it: every element of AC-2's antecedent, met by
 * the route AC-2 names first. `classifyRequestOutcome` records it as
 * `transport-error`, which is the one class AC-2's consequent names as
 * forbidden alongside a third-party block.
 *
 * The wire is measured before the record is read, so nothing here can be
 * confused with the cached replay: exactly one retrieval left, for this very
 * request, and there is only one request.
 *
 * THIS FILE PROVES IT CAN PASS. The third case below runs the SAME harness, the
 * SAME wire measurement and the SAME two AC-2 assertions over the sibling
 * refusal - a retrieval that landed and returned a Disallow - and is green. The
 * assertions are therefore not vacuous and the harness is not the reason the
 * first two are red: only the reason word differs between them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TransportRequest, TransportResponse } from "@deal-sentinel/governor";

import { productRequests } from "../support/governor-harness.ts";
import {
  BESTBUY_BASE_URL,
  TEST_CREDENTIAL,
  readVendorFixture,
  sourceHarness,
} from "../support/source-3-harness.ts";

const SOURCE = "bestbuy-api";
const SKU = "8880044";

function productUrl(sku: string): string {
  return `${BESTBUY_BASE_URL}/products/${sku}.json?apiKey=${TEST_CREDENTIAL}`;
}

/** The product path always answers; only the robots answer differs per case. */
function respondWith(
  robots: Partial<TransportResponse>,
): (request: TransportRequest) => Partial<TransportResponse> | Error {
  return (request) => {
    if (new URL(request.url).pathname === "/robots.txt") return robots;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: readVendorFixture("product-on-sale.json"),
    };
  };
}

/** 503: RFC 9309 2.3.1.4 unreachable, so this host is completely disallowed. */
const ROBOTS_UNREACHABLE = { status: 503, body: "" };

/** 200 with a rule that disallows everything: the same verdict, retrieved. */
const ROBOTS_DISALLOWED = {
  status: 200,
  headers: { "content-type": "text/plain" },
  body: "User-agent: *\nDisallow: /\n",
};

/**
 * One governed request against a robots answer, with the wire measured: exactly
 * one retrieval, made FOR this request, and no product request. One request in
 * total, so no verdict here was replayed from the cache - the case this item
 * does not grade.
 */
async function refusedRequest(robots: Partial<TransportResponse>): Promise<{
  reason: string;
  outcomeClass: string;
  refusals: number;
}> {
  const harness = sourceHarness({ responder: respondWith(robots) });

  const outcome = await harness.governor.request({
    url: productUrl(SKU),
    sourceId: SOURCE,
  });

  assert.equal(outcome.ok, false, "the governor did not refuse this request");

  const robotsSent = harness.transport.sent.filter(
    (sent) => new URL(sent.url).pathname === "/robots.txt",
  );
  assert.equal(robotsSent.length, 1, "the retrieval was not made for this request");
  assert.equal(
    productRequests(harness.transport.sent).length,
    0,
    "a product request left, so this is no longer a pure governor refusal",
  );
  assert.equal(harness.outcomes.recorded.length, 1, "AC-1: one record per request");

  const classes = harness.outcomes.recorded.map((record) => record.outcomeClass);
  return {
    reason: outcome.ok === false ? outcome.reason : "",
    outcomeClass: classes[0],
    refusals: classes.filter((held) => held === "governor-refusal").length,
  };
}

describe("regress 0066 F7: the governor's own robots decision for THIS request is recorded as a transport error", () => {
  it("records a refusal AC-2 names by route under a class AC-2 forbids", async () => {
    const refused = await refusedRequest(ROBOTS_UNREACHABLE);

    assert.equal(
      refused.reason,
      "robots-unreachable",
      "this case is only about the unreachable-robots refusal",
    );

    // AC-2's consequent, both halves, on the record for that one request.
    assert.notEqual(
      refused.outcomeClass,
      "third-party-block",
      "AC-2: a refusal this governor decided is recorded as a third-party block",
    );
    assert.notEqual(
      refused.outcomeClass,
      "transport-error",
      "AC-2: a request refused by this governor's own robots decision, taken " +
        "for that request by a retrieval made for it, is recorded as a " +
        "transport error",
    );
  });

  it("reports the operator no refusal for a source whose one request this governor refused", async () => {
    const refused = await refusedRequest(ROBOTS_UNREACHABLE);

    // The surface AC-2 exists for. One request, refused by this system, and the
    // counts the page draws carry no refusal at all.
    assert.equal(
      refused.refusals,
      1,
      "the governor refused this request and the page reports it as " +
        refused.outcomeClass,
    );
  });

  it("PROOF THE CASE CAN PASS: the sibling refusal, same harness, same assertions", async () => {
    const refused = await refusedRequest(ROBOTS_DISALLOWED);

    assert.equal(refused.reason, "robots-disallowed");
    assert.notEqual(refused.outcomeClass, "third-party-block");
    assert.notEqual(refused.outcomeClass, "transport-error");
    assert.equal(refused.refusals, 1);
  });
});
