/**
 * Refuter artifact for S0066-deal-sentinel-ops-5, impl gate ordinal 2, finding
 * F6. This file DOCUMENTS a defect; it does not fix it.
 *
 * AC-2 fixes what a refusal the governor made itself is recorded as: "WHEN a
 * request is refused by the system's own governor ... THE SYSTEM SHALL record
 * it under an outcome class distinct from a third-party block and distinct from
 * a transport error".
 *
 * `classifyRequestOutcome` now files `robots-unreachable` as `transport-error`,
 * justified in `governor.ts` by "The /robots.txt retrieval really went out and
 * the transport really failed". An unreachable robots.txt IS CACHED - only a
 * `refused` retrieval is not (`robots.ts`, `#retrieveAndCache`) - so for the
 * whole of `robots.cacheBoundMs` every later request for that origin is refused
 * from the cached verdict with NOTHING on the wire, and is recorded as a
 * transport error all the same.
 *
 * Both halves of the harm are asserted below: the record is false about the
 * request it is a record OF (AC-1 is one record per request), and the operator
 * surface this spec exists to build reports a climbing `transport-error`
 * against a host nothing was sent to, beside `governor-refusal 0` while the
 * governor refuses every request.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { productRequests } from "../support/governor-harness.ts";
import type { TransportRequest, TransportResponse } from "@deal-sentinel/governor";
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

/**
 * A host whose `/robots.txt` answers 503 - RFC 9309 2.3.1.4 unreachable, so
 * complete disallow - and whose product path would answer perfectly well if the
 * governor ever asked it. It never does.
 */
function robotsUnreachable(
  request: TransportRequest,
): Partial<TransportResponse> | Error {
  if (new URL(request.url).pathname === "/robots.txt") {
    return { status: 503, body: "" };
  }
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: readVendorFixture("product-on-sale.json"),
  };
}

describe("regress 0066 F6: a refusal taken from the robots cache is recorded as a transport error", () => {
  it("does not call a request a transport error when nothing was sent for it", async () => {
    const harness = sourceHarness({ responder: robotsUnreachable });

    const first = await harness.governor.request({ url: productUrl(SKU), sourceId: SOURCE });
    const second = await harness.governor.request({ url: productUrl(SKU), sourceId: SOURCE });

    assert.equal(first.ok, false);
    assert.equal(
      first.ok === false && first.reason,
      "robots-unreachable",
      "this case is only about the unreachable-robots refusal",
    );
    assert.equal(
      second.ok === false && second.reason,
      "robots-unreachable",
      "the second refusal is the cached verdict, which is what this case is about",
    );

    // The wire, measured: ONE robots.txt retrieval for the first request and
    // nothing at all for the second, and no product request ever.
    const robotsSent = harness.transport.sent.filter(
      (sent) => new URL(sent.url).pathname === "/robots.txt",
    );
    assert.equal(robotsSent.length, 1, "the second request re-retrieved robots.txt");
    assert.equal(
      productRequests(harness.transport.sent).length,
      0,
      "a product request left, so this is no longer a pure refusal",
    );

    assert.equal(harness.outcomes.recorded.length, 2, "AC-1: one record per request");

    // AC-2, on the record for the SECOND request: it was refused by this
    // system's own governor, from a cached robots verdict, with nothing sent
    // for it. Its class must be distinct from a transport error.
    assert.notEqual(
      harness.outcomes.recorded[1].outcomeClass,
      "transport-error",
      "AC-2: a request refused from the cached robots verdict, with nothing on " +
        "the wire, is recorded as a transport error",
    );
  });

  it("shows the operator a transport error count for a host it sent nothing to", async () => {
    const harness = sourceHarness({ responder: robotsUnreachable });

    // Five requests inside one cache bound: one retrieval, four refusals taken
    // entirely from memory.
    for (let index = 0; index < 5; index += 1) {
      await harness.governor.request({ url: productUrl(SKU), sourceId: SOURCE });
    }

    const classes = harness.outcomes.recorded.map((record) => record.outcomeClass);
    const transportErrors = classes.filter((held) => held === "transport-error").length;
    const refusals = classes.filter((held) => held === "governor-refusal").length;
    const sent = harness.transport.sent.length;

    assert.ok(
      transportErrors <= sent,
      `the page would report ${transportErrors} transport errors for a source ` +
        `this system sent ${sent} requests for in total`,
    );
    assert.ok(
      refusals > 0,
      "the governor refused every one of these requests and the page reports " +
        "none of them as a refusal it made",
    );
  });
});
