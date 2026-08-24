/**
 * regress_0002_F2 - impl-gate ordinal 1, spec S0002-deal-sentinel-history-1.
 *
 * Finding F2 (NON-BLOCKING, filed as advisory): a NEGATIVE offer price is
 * resolved rather than refused, and is written to the price history.
 *
 * `toMinorUnits` in `packages/extractor/src/currency.ts` explicitly handles a
 * leading "-":
 *
 *     const negative = cleaned.startsWith("-");
 *     ...
 *     return negative ? -minor : minor;
 *
 * and neither `buildRow` in `packages/db/src/write-path.ts` nor the migration
 * (`0000_history_1_price_observations.sql`, which puts no CHECK on
 * `amount_minor_units`) rejects the result. A retail offer price below zero is
 * not a price; the roadmap's fail-safe for this phase is "a wrong price cannot
 * enter it".
 *
 * This is filed NON-BLOCKING on purpose. Acceptance criterion 1's trigger is
 * an extractor that "cannot resolve exactly one offer price"; a signed decimal
 * IS resolved to exactly one value, so the criterion is not violated on its
 * face and the objection is design reasoning, not a spec breach. Under
 * decision 26 reasoning alone does not block. The transcript is recorded here
 * so the observation is checkable rather than asserted.
 *
 * Run: node --test tests/regress_0002_F2.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOffer, toMinorUnits } from "@deal-sentinel/extractor";
import { recordObservation } from "@deal-sentinel/db";
import type { HistoryWriter } from "@deal-sentinel/db";

/** Synthetic markup. No review body, no reviewer name, no account identifier. */
const NEGATIVE_PRICE = `<!doctype html>
<html lang="en">
  <head>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Impact Driver",
        "offers": {
          "@type": "Offer",
          "price": "-129.99",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock"
        }
      }
    </script>
  </head>
  <body><h1>Impact Driver</h1></body>
</html>`;

/** A price whose symbol contradicts its declared ISO 4217 code. */
const SYMBOL_CONTRADICTS_CODE = `<!doctype html>
<html lang="en">
  <head>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Track Saw",
        "offers": {
          "@type": "Offer",
          "price": "£499.00",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock"
        }
      }
    </script>
  </head>
  <body><h1>Track Saw</h1></body>
</html>`;

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

describe("regress_0002_F2: a negative price is resolved and stored", () => {
  it("converts a negative decimal to negative minor units", () => {
    assert.equal(
      toMinorUnits("-129.99", "USD"),
      null,
      "a negative offer price is not a price and should not convert",
    );
  });

  it("refuses a negative offer rather than resolving it", () => {
    const result = extractOffer(NEGATIVE_PRICE);
    assert.equal(
      result.ok,
      false,
      `extractOffer resolved a negative price: ${JSON.stringify(
        result,
        (_k, v) => (typeof v === "bigint" ? `${v}n` : v),
      )}`,
    );
  });

  it("writes no observation carrying a negative amount", async () => {
    const writer = recordingWriter();
    const outcome = await recordObservation(writer, extractOffer(NEGATIVE_PRICE), {
      sourceId: "regress-0002-f2",
      listingId: "https://example.invalid/tools/impact-driver",
      observedAt: new Date("2026-08-24T16:00:00.000Z"),
      sourceTimeZone: "America/New_York",
      rawContext: NEGATIVE_PRICE,
    });
    assert.equal(
      outcome.written,
      false,
      `a negative price reached the history: ${JSON.stringify(
        writer.rows,
        (_k, v) => (typeof v === "bigint" ? `${v}n` : v),
      )}`,
    );
  });
});

describe("regress_0002_F2b: a symbol contradicting the declared code", () => {
  it("does not silently record a GBP-marked price as USD", () => {
    const result = extractOffer(SYMBOL_CONTRADICTS_CODE);
    assert.equal(
      result.ok && result.currency === "USD" && result.amountMinorUnits === 49900n,
      false,
      "a price written with a GBP symbol was stripped and stored under the " +
        "declared USD code",
    );
  });
});
