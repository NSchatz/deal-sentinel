/**
 * Acceptance criteria 3 and 14 of spec S0033-deal-sentinel-source-3:
 *
 *   3. WHEN content from a source that requires attribution is displayed or
 *      exported THE SYSTEM SHALL attribute that source.
 *  14. IF a display or export path would emit content from a source that
 *      declares an attribution requirement without carrying that attribution
 *      THEN THE SYSTEM SHALL refuse the emission rather than emit it
 *      unattributed.
 *
 * The obligation, verbatim from the sanctioned API's terms: "You must clearly
 * and conspicuously attribute the source of all Content as received from Best
 * Buy."
 *
 * Both criteria are graded on BOTH paths this phase creates - the export and
 * the one-line display - because a guard that only one of them calls is a guard
 * the next path will forget. Criterion 14 is the half that makes criterion 3
 * mean anything: an emitter that silently filled the notice in would pass the
 * first and prove nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UnattributedEmissionError,
  assertAttributed,
  attributedItem,
  formatMinorUnits,
  renderListingSummary,
  renderObservationExport,
} from "@deal-sentinel/sources";
import type { ExportItem } from "@deal-sentinel/sources";

import { registryDocument, testRegistry } from "../support/source-3-harness.ts";
import { validateSourceRegistry } from "@deal-sentinel/sources";

const registry = testRegistry();

/**
 * A source this repository holds no terms for, so nothing obliges attribution.
 * The other half of the property: the guard must not refuse everything.
 */
const unobliged = validateSourceRegistry(
  registryDocument({ rawContextRetentionHours: undefined }, "no-terms-source"),
  "the test source configuration",
);

const OBSERVED_AT = new Date("2026-09-06T12:00:00.000Z");
const UPDATED_AT = new Date("2026-09-05T18:32:00.000Z");

function item(overrides: Partial<ExportItem> = {}): ExportItem {
  return {
    sourceId: "bestbuy-api",
    listingId: "8880044",
    amountMinorUnits: 799n,
    currency: "USD",
    observedAt: OBSERVED_AT,
    vendorPriceUpdatedAt: UPDATED_AT,
    attribution: "Product information provided by Best Buy",
    ...overrides,
  };
}

describe("criterion 3: an emission from an attributing source carries the attribution", () => {
  it("declares the requirement in the registry, from the source's terms", () => {
    const entry = registry.require("bestbuy-api");
    assert.equal(entry.attribution.required, true);
    assert.equal(entry.attribution.attributeTo, "Best Buy");
    assert.ok(entry.attribution.notice.includes("Best Buy"));
  });

  it("builds an item carrying that source's notice", () => {
    const built = attributedItem(registry, {
      sourceId: "bestbuy-api",
      listingId: "8880044",
      amountMinorUnits: 799n,
      currency: "USD",
      observedAt: OBSERVED_AT,
      vendorPriceUpdatedAt: UPDATED_AT,
    });
    assert.equal(built.attribution, registry.require("bestbuy-api").attribution.notice);
  });

  it("attributes the export, at the head of the source's block", () => {
    const text = renderObservationExport(registry, [item(), item({ listingId: "6428337" })]);
    assert.ok(text.includes("Best Buy"), text);
    // Conspicuous means the reader meets it before the content, not after.
    const noticeAt = text.indexOf("Best Buy");
    const firstListingAt = text.indexOf("8880044");
    assert.ok(
      noticeAt < firstListingAt,
      "the attribution comes after the content it attributes",
    );
  });

  it("attributes the one-line display path too", () => {
    const line = renderListingSummary(registry, item());
    assert.ok(line.includes("Best Buy"), line);
    assert.ok(line.includes("USD 7.99"), line);
  });

  it("prints money from the exact minor units, by the currency's own exponent", () => {
    assert.equal(formatMinorUnits(799n, "USD"), "USD 7.99");
    assert.equal(formatMinorUnits(1299n, "JPY"), "JPY 1299");
    assert.equal(formatMinorUnits(12_995n, "KWD"), "KWD 12.995");
    // A sub-unit amount still shows its whole part.
    assert.equal(formatMinorUnits(5n, "USD"), "USD 0.05");
  });

  it("says plainly when the vendor published no price-update instant", () => {
    const line = renderListingSummary(registry, item({ vendorPriceUpdatedAt: null }));
    assert.match(line, /not published/);
    assert.ok(!line.includes(OBSERVED_AT.toISOString().slice(11)) || line.includes("12:00:00"));
  });

  it("emits a source with no attribution requirement without one", () => {
    const line = renderListingSummary(
      unobliged,
      item({ sourceId: "no-terms-source", attribution: null }),
    );
    assert.ok(line.includes("8880044"));
    assert.equal(assertAttributed(unobliged, item({ sourceId: "no-terms-source", attribution: null })), null);
  });
});

describe("criterion 14: an unattributed emission is refused, not emitted", () => {
  const unattributed: [string, ExportItem][] = [
    ["no attribution at all", item({ attribution: null })],
    ["an empty attribution", item({ attribution: "" })],
    ["whitespace pretending to be one", item({ attribution: "   " })],
    ["a notice that does not name the party", item({ attribution: "Provided by a retailer" })],
  ];

  for (const [what, subject] of unattributed) {
    it(`refuses the export for ${what}`, () => {
      assert.throws(
        () => renderObservationExport(registry, [subject]),
        (error: unknown) => {
          assert.ok(error instanceof UnattributedEmissionError);
          assert.equal(error.sourceId, "bestbuy-api");
          assert.equal(error.attributeTo, "Best Buy");
          assert.match(error.message, /refusing to emit/);
          return true;
        },
      );
    });

    it(`refuses the display path for ${what}`, () => {
      assert.throws(
        () => renderListingSummary(registry, subject),
        UnattributedEmissionError,
      );
    });
  }

  it("emits NOTHING when one item among many is unattributed", () => {
    // The whole export is refused rather than the offending row dropped: a
    // partial export is a file somebody keeps, and this one would be missing a
    // row for a reason no reader can see.
    assert.throws(
      () =>
        renderObservationExport(registry, [
          item(),
          item({ listingId: "6428337", attribution: null }),
          item({ listingId: "5901234" }),
        ]),
      UnattributedEmissionError,
    );
  });

  it("accepts a notice that names the party inside a longer sentence", () => {
    const line = renderListingSummary(
      registry,
      item({ attribution: "Prices and product information provided by Best Buy, used under their API terms." }),
    );
    assert.ok(line.includes("Best Buy"));
  });

  it("refuses an item from a source the registry does not carry at all", () => {
    assert.throws(() => renderListingSummary(registry, item({ sourceId: "nobody" })));
  });
});
