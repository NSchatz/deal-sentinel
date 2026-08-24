/**
 * regress_0002_F1 - impl-gate ordinal 1, spec S0002-deal-sentinel-history-1.
 *
 * Finding F1: the microdata reader cannot see a second offer, so a multi-offer
 * page expressed as schema.org microdata resolves to the FIRST price in
 * document order instead of a typed `ambiguous-offer` failure.
 *
 * Acceptance criterion 1 (spec.md, inherited verbatim from
 * `deal-sentinel#HISTORY-1`):
 *
 *   WHEN an extractor cannot resolve exactly one offer price and its ISO 4217
 *   currency from a fixture THE SYSTEM SHALL record a typed extraction failure
 *   and SHALL NOT write a price observation
 *
 * The JSON-LD reader honours this: `two-variant-offers.html` (two variants at
 * 219.00 and 329.00) answers `ambiguous-offer`. The microdata reader does not.
 *
 * Root cause, in `packages/extractor/src/offers.ts`:
 * `findMicrodataOffers` scans EVERY `itemprop` in the whole document into ONE
 * shared candidate (`if (prop === "price" && price === null) price = value`
 * keeps only the first), then emits N identical copies of that single
 * candidate, one per offer element. `extractOffer`'s `dedupe` keys candidates
 * on `[price, currency, availability, priceIsRange]`, so N identical copies
 * collapse back to exactly one and the `distinct.length > 1` ambiguity guard
 * never fires.
 *
 * The reader's own doc comment states the opposite is true:
 *   "a page with several microdata offers yields several identical candidates
 *    and resolves to `ambiguous-offer` - the safe direction."
 *
 * This test documents the bug. It is expected to FAIL against commit 6594e64.
 *
 * Run: node --test tests/regress_0002_F1.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOffer } from "@deal-sentinel/extractor";
import { recordObservation } from "@deal-sentinel/db";
import type { HistoryWriter } from "@deal-sentinel/db";

/**
 * Two variants of one product, at two different prices, expressed as
 * microdata. This is the same page `two-variant-offers.html` describes, in the
 * other markup dialect the extractor claims to read.
 *
 * Synthetic markup. No review body, no reviewer name, no account identifier.
 */
const TWO_MICRODATA_OFFERS = `<!doctype html>
<html lang="en">
  <head>
    <title>Framing Nailer</title>
  </head>
  <body itemscope itemtype="https://schema.org/Product">
    <h1 itemprop="name">Framing Nailer</h1>
    <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
      <meta itemprop="priceCurrency" content="USD" />
      <span itemprop="price" content="219.00">$219.00</span>
      <link itemprop="availability" href="https://schema.org/InStock" />
    </div>
    <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
      <meta itemprop="priceCurrency" content="USD" />
      <span itemprop="price" content="329.00">$329.00</span>
      <link itemprop="availability" href="https://schema.org/InStock" />
    </div>
  </body>
</html>`;

/**
 * The same root cause with ONE offer on the page. The `price` itemprop the
 * reader keeps is the first one in the WHOLE document, not the one inside the
 * offer element, so an unrelated priced item above the offer supplies the
 * price that gets stored against this listing.
 *
 * Synthetic markup. No review body, no reviewer name, no account identifier.
 */
const PRICE_FROM_OUTSIDE_THE_OFFER = `<!doctype html>
<html lang="en">
  <body>
    <aside itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Frequently bought together: nail strips</span>
      <span itemprop="price" content="8.99">$8.99</span>
      <meta itemprop="priceCurrency" content="USD" />
    </aside>
    <div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Framing Nailer</h1>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="priceCurrency" content="USD" />
        <span itemprop="price" content="329.00">$329.00</span>
        <link itemprop="availability" href="https://schema.org/InStock" />
      </div>
    </div>
  </body>
</html>`;

/** A writer that records every call instead of touching a database. */
function recordingWriter(): HistoryWriter & { rows: unknown[] } {
  const rows: unknown[] = [];
  return {
    rows,
    async insertObservation(row) {
      rows.push(row);
      return BigInt(rows.length);
    },
  };
}

describe("regress_0002_F1: a multi-offer microdata page must not resolve", () => {
  it("answers ambiguous-offer, exactly as the JSON-LD reader does", () => {
    const result = extractOffer(TWO_MICRODATA_OFFERS);

    assert.deepEqual(
      result,
      { ok: false, reason: "ambiguous-offer" },
      "two microdata offers at 219.00 and 329.00 are not one resolvable offer " +
        "price, so acceptance criterion 1 requires a typed extraction failure",
    );
  });

  it("does not silently pick the first price in document order", () => {
    const result = extractOffer(TWO_MICRODATA_OFFERS);

    assert.equal(
      result.ok && result.amountMinorUnits === 21900n,
      false,
      "the extractor returned the FIRST offer's price (219.00) for a page " +
        "carrying two different offer prices - the roadmap's own fail-safe " +
        "says ambiguity always produces a typed failure",
    );
  });

  it("writes no price observation for that page", async () => {
    const writer = recordingWriter();
    const result = extractOffer(TWO_MICRODATA_OFFERS);

    const outcome = await recordObservation(writer, result, {
      sourceId: "regress-0002-f1",
      listingId: "https://example.invalid/tools/framing-nailer",
      observedAt: new Date("2026-08-24T16:00:00.000Z"),
      sourceTimeZone: "America/New_York",
      rawContext: TWO_MICRODATA_OFFERS,
    });

    assert.equal(
      outcome.written,
      false,
      "a page the extractor cannot honestly resolve reached the write path " +
        "and produced a row",
    );
    assert.deepEqual(writer.rows, [], "no row may be written for this page");
  });
});

describe("regress_0002_F1b: microdata itemprops are read unscoped", () => {
  it("does not attribute an unrelated item's price to this offer", () => {
    const result = extractOffer(PRICE_FROM_OUTSIDE_THE_OFFER);

    assert.equal(
      result.ok && result.amountMinorUnits === 899n,
      false,
      "the extractor stored 8.99 (an accessory listed above the offer) as " +
        "this offer's price; the offer element itself says 329.00",
    );
  });
});
