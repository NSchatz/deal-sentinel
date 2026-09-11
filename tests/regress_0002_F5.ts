/**
 * regress_0002_F5 - impl-gate ordinal 2, spec S0002-deal-sentinel-history-1.
 *
 * F5 (ADVISORY): the microdata reader matches an attribute by an UNANCHORED
 * name, so any attribute whose name merely ENDS with `content` or `href`
 * shadows the real one and donates its value to the offer.
 *
 * Root cause, `packages/extractor/src/offers.ts`: `attributeValue` builds a
 * pattern from `\b` plus the name, and `\b` matches between `-` and `c`, so
 * `data-content="99.00"` satisfies `\bcontent=` and `.exec` takes the FIRST
 * match in the attribute text. The same hole exists for `href` (`data-href`),
 * `itemprop` and `itemtype`. The offer's own stated price is then never read,
 * and a different number reaches the price history with no typed failure and no
 * visible gap.
 *
 * Advisory rather than blocking: criterion 1 triggers on an extractor that
 * cannot resolve one price and one currency, and here both ARE resolved. No
 * committed fixture carries a `data-content` attribute. Recorded so it is
 * checkable, and so SOURCE-3 or BREADTH-6 inherits it.
 *
 * Run: pnpm exec node --test tests/regress_0002_F5.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOffer } from "@deal-sentinel/extractor";

/** Synthetic: one offer at 129.99, its price element also carrying the
 * Bootstrap popover attribute `data-content`, a shape real templates emit. */
const DATA_CONTENT_SHADOWS_CONTENT = `<!doctype html>
<html lang="en">
  <body>
    <div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Framing Nailer</h1>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="priceCurrency" content="USD" />
        <span itemprop="price" data-content="99.00">$129.99</span>
        <link itemprop="availability" href="https://schema.org/InStock" />
      </div>
    </div>
  </body>
</html>`;

/** The same hole on `href`: a `data-href` written before the real one wins. */
const DATA_HREF_SHADOWS_HREF = `<!doctype html>
<html lang="en">
  <body>
    <div itemscope itemtype="https://schema.org/Offer">
      <meta itemprop="priceCurrency" content="USD" />
      <meta itemprop="price" content="129.99" />
      <a itemprop="availability" data-href="/help/stock" href="https://schema.org/InStock">In stock</a>
    </div>
  </body>
</html>`;

describe("regress_0002_F5: an attribute name is matched unanchored", () => {
  it("reads the offer's own price, not a data-* attribute that ends in 'content'", () => {
    const result = extractOffer(DATA_CONTENT_SHADOWS_CONTENT);

    assert.equal(
      result.ok && result.amountMinorUnits === 9900n,
      false,
      "the extractor stored 99.00 from `data-content`; the offer element " +
        "states 129.99 and nothing else",
    );
  });

  it("does not take a data-href in place of the availability token", () => {
    const result = extractOffer(DATA_HREF_SHADOWS_HREF);

    assert.equal(
      result.ok ? result.availability : null,
      "https://schema.org/InStock",
      "acceptance criterion 3 asks for the schema.org ItemAvailability token " +
        "as received; the reader took `/help/stock` from `data-href` instead",
    );
  });
});
