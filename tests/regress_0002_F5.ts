/**
 * regress_0002_F5 - impl-gate ordinal 2, spec S0002-deal-sentinel-history-1.
 *
 * Finding F5 (ADVISORY): the microdata reader matches an attribute by an
 * UNANCHORED name, so any attribute whose name merely ENDS with `content` or
 * `href` shadows the real one and donates its value to the offer.
 *
 * Root cause, `packages/extractor/src/offers.ts`:
 *
 *     function attributeValue(attributes: string, name: string): string | null {
 *       const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(
 *         attributes,
 *       );
 *
 * `\b` matches between `-` and `c`, so `data-content="99.00"` satisfies
 * `\bcontent=`, and `.exec` takes the FIRST match in the attribute text. The
 * same hole exists for `href` (`data-href`), `itemprop` (`data-itemprop`) and
 * `itemtype` (`data-itemtype`).
 *
 * Consequence, and why it is the same SHAPE as the F1 defect this branch fixed:
 * the offer's own stated price is never read, and a different number is written
 * to the price history with no typed failure and no visible gap.
 *
 * Filed ADVISORY, not blocking. Acceptance criterion 1's trigger is an
 * extractor that "cannot resolve exactly one offer price and its ISO 4217
 * currency"; here exactly one price and one currency ARE resolved, so the
 * criterion is not breached on its face and the objection is a robustness
 * argument about a hand-rolled attribute matcher. The roadmap bounds this
 * phase's evidence to saved markup - "a green suite says the extractor is not
 * obviously wrong about markup somebody already saved" - and no committed
 * fixture carries a `data-content` attribute. Under decision 26 reasoning alone
 * does not block; the transcript is recorded here so it is checkable rather
 * than asserted, and SOURCE-3 or BREADTH-6 inherits it.
 *
 * Run: pnpm exec node --test tests/regress_0002_F5.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOffer } from "@deal-sentinel/extractor";

/**
 * One offer, one stated price of 129.99. The price element also carries a
 * `data-content` attribute - the Bootstrap popover attribute, and a shape a
 * real retail template emits.
 *
 * Synthetic markup. No review body, no reviewer name, no account identifier.
 */
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

/**
 * The same hole on `href`. The offer declares availability with a real
 * `href="https://schema.org/InStock"`, and a `data-href` written before it wins.
 *
 * Synthetic markup. No review body, no reviewer name, no account identifier.
 */
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
