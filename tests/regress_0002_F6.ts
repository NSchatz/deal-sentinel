/**
 * regress_0002_F6 - impl-gate ordinal 2, spec S0002-deal-sentinel-history-1.
 *
 * F6 (ADVISORY): a microdata `itemprop="price"` element with no `content`
 * attribute has its value read as the text up to the NEXT `<`
 * (`textAfter` in `packages/extractor/src/offers.ts`), so markup splitting the
 * price across a child element yields a truncated price rather than a typed
 * failure. `<span itemprop="price">129<sup>99</sup></span>` reads "129", which
 * converts exactly to 12900 - a dollar short of the 129.99 the page states,
 * with no `no-price` and no gap. Superscripted cents are real retail
 * typography, and the microdata data model says the value is the element's
 * whole textContent, so neither "129" nor "12999" is the offer's price.
 *
 * Advisory rather than blocking: criterion 1 triggers on an extractor that
 * cannot resolve one price and one currency, and here both ARE resolved. No
 * committed fixture splits a price across a child element. Recorded so it is
 * checkable, and so SOURCE-3 inherits it rather than rediscovering it against
 * a live page.
 *
 * Run: pnpm exec node --test tests/regress_0002_F6.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOffer } from "@deal-sentinel/extractor";

/** Synthetic: one offer at $129.99, cents superscripted, no `content`. */
const SPLIT_PRICE_TEXT = `<!doctype html>
<html lang="en">
  <body>
    <div itemscope itemtype="https://schema.org/Offer">
      <meta itemprop="priceCurrency" content="USD" />
      <span itemprop="price">129<sup>99</sup></span>
      <link itemprop="availability" href="https://schema.org/InStock" />
    </div>
  </body>
</html>`;

describe("regress_0002_F6: a price split across a child element", () => {
  it("does not resolve a truncated price as if it were the offer's price", () => {
    const result = extractOffer(SPLIT_PRICE_TEXT);

    assert.equal(
      result.ok && result.amountMinorUnits === 12900n,
      false,
      "the extractor resolved 12900 (=$129.00) by reading only the text " +
        "before <sup>; the offer states $129.99, and a reader that cannot " +
        "tell 129.99 from 12999 here should answer a typed failure",
    );
  });
});
