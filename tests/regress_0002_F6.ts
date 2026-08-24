/**
 * regress_0002_F6 - impl-gate ordinal 2, spec S0002-deal-sentinel-history-1.
 *
 * Finding F6 (ADVISORY): when a microdata `itemprop="price"` element carries no
 * `content` attribute, its value is read as the text up to the NEXT `<`, so
 * markup that splits the price across a child element yields a truncated price
 * rather than a typed failure.
 *
 * Root cause, `packages/extractor/src/offers.ts`:
 *
 *     function textAfter(markup: string, from: number): string | null {
 *       const end = markup.indexOf("<", from);
 *       const text = markup.slice(from, end === -1 ? undefined : end);
 *
 * `<span itemprop="price">129<sup>99</sup></span>` therefore reads "129", and
 * `toMinorUnits("129", "USD")` is an exact conversion to 12900 - one dollar
 * short of the 129.99 the page states, with no `no-price` and no gap.
 * Superscripted cents are a real retail typography, and the microdata data
 * model says a property's value is the element's whole textContent, so neither
 * "129" nor the textContent reading "12999" is the offer's price. Two readings
 * that disagree by a factor of a hundred is exactly the ambiguity this phase's
 * fail-safe exists for.
 *
 * Filed ADVISORY, not blocking. Criterion 1's trigger is an extractor that
 * "cannot resolve exactly one offer price and its ISO 4217 currency"; here one
 * price and one currency ARE resolved, and the objection is that the resolved
 * value is wrong - a robustness argument about a deliberately small tag
 * scanner, not a breach of the quoted clause. The roadmap's own Known
 * limitations bound this phase: "a green suite says the extractor is not
 * obviously wrong about markup somebody already saved", and no committed
 * fixture splits a price across a child element. Under decision 26 reasoning
 * alone does not block; recorded so it is checkable, and so SOURCE-3 inherits
 * it rather than rediscovering it against a live page.
 *
 * Run: pnpm exec node --test tests/regress_0002_F6.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOffer } from "@deal-sentinel/extractor";

/**
 * One offer at $129.99, with the cents superscripted and no `content`
 * attribute to read the machine-readable value from.
 *
 * Synthetic markup. No review body, no reviewer name, no account identifier.
 */
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
