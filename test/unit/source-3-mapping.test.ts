/**
 * Acceptance criteria 6, 7 and 8 of spec S0033-deal-sentinel-source-3:
 *
 *   6. WHEN a vendor payload carries a decimal sale price THE SYSTEM SHALL
 *      store the amount as an exact integer in that currency's ISO 4217 minor
 *      unit, and SHALL NOT store it as a floating point value or scale it by a
 *      fixed 100.
 *   7. IF a vendor payload for a watchlist entry carries no usable price,
 *      carries a price that does not resolve to exactly one exact minor-unit
 *      amount, or resolves to no ISO 4217 currency THEN THE SYSTEM SHALL record
 *      a typed extraction failure and SHALL NOT write a price observation for
 *      that entry.
 *   8. IF the vendor payload for a watchlist entry publishes no price-update
 *      timestamp THEN THE SYSTEM SHALL still record the observation, with that
 *      vendor timestamp absent rather than filled in from the fetch instant.
 *
 * The mapping is a pure function over a saved payload, so every case here is
 * graded in microseconds with no clock, no database and nothing on a wire. The
 * halves of criterion 7 that are about WRITING - "SHALL NOT write a price
 * observation" - are graded here through the same write path the run uses, with
 * a writer that records every call, so "wrote nothing" is an assertion about
 * the writer and not about a comment.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordObservation } from "@deal-sentinel/db";
import type { HistoryWriter, NewPriceObservationRow } from "@deal-sentinel/db";
import { mapVendorPayload } from "@deal-sentinel/sources";
import type { VendorMapping } from "@deal-sentinel/sources";

import { readVendorFixture } from "../support/source-3-harness.ts";

const USD = { currency: "USD", timeZone: "America/New_York" };

function map(
  fixture: string,
  listingId: string,
  settings = USD,
): VendorMapping {
  return mapVendorPayload(
    JSON.parse(readVendorFixture(fixture)) as unknown,
    listingId,
    settings,
  );
}

function resolved(fixture: string, listingId: string, settings = USD) {
  const mapping = map(fixture, listingId, settings);
  assert.ok(
    mapping.ok,
    `expected ${fixture} to resolve, got ${mapping.ok ? "" : mapping.detail}`,
  );
  return mapping;
}

function refused(fixture: string, listingId: string, settings = USD) {
  const mapping = map(fixture, listingId, settings);
  assert.equal(mapping.ok, false, `expected ${fixture} to refuse`);
  assert.ok(!mapping.ok);
  return mapping;
}

/** A writer that records every call and returns an id. Nothing is a database. */
function recordingWriter(): HistoryWriter & { rows: NewPriceObservationRow[] } {
  const rows: NewPriceObservationRow[] = [];
  return {
    rows,
    async insertObservation(row) {
      rows.push(row);
      return BigInt(rows.length);
    },
  };
}

describe("criterion 6: a decimal price becomes exact minor units", () => {
  it("reads 7.99 USD as 799 minor units, exactly", () => {
    const mapping = resolved("product-on-sale.json", "8880044");
    assert.equal(mapping.amountMinorUnits, 799n);
    assert.equal(mapping.currency, "USD");
    // A bigint, not a number: the type itself is half the criterion.
    assert.equal(typeof mapping.amountMinorUnits, "bigint");
  });

  it("reads the regular price the same way, so the comparison is exact too", () => {
    const mapping = resolved("product-on-sale.json", "8880044");
    assert.equal(mapping.regularPriceMinorUnits, 999n);
  });

  it("derives onSale from the two amounts and not from the vendor's boolean", () => {
    const onSale = resolved("product-on-sale.json", "8880044");
    assert.equal(onSale.onSale, true);
    assert.equal(onSale.vendorOnSale, true);

    const notOnSale = resolved("product-not-on-sale.json", "6428337");
    assert.equal(notOnSale.amountMinorUnits, 12_999n);
    assert.equal(notOnSale.regularPriceMinorUnits, 12_999n);
    // Equal prices are not "sale price is less than regular price", which is
    // the vendor's own definition of the flag.
    assert.equal(notOnSale.onSale, false);
  });

  it("scales by the CURRENCY's exponent and never by a fixed 100", () => {
    // The same payload, the same digits, read under three currencies whose
    // minor-unit exponents differ. A fixed multiply-by-100 answers 129900 for
    // the yen and 129900 for the dinar, and both are wrong.
    const yen = resolved("product-whole-number-price.json", "1299001", {
      currency: "JPY",
      timeZone: "Asia/Tokyo",
    });
    assert.equal(yen.amountMinorUnits, 1299n, "JPY has no subdivision at all");

    const dollars = resolved("product-whole-number-price.json", "1299001");
    assert.equal(dollars.amountMinorUnits, 129_900n);

    const dinars = resolved("product-whole-number-price.json", "1299001", {
      currency: "KWD",
      timeZone: "Asia/Kuwait",
    });
    assert.equal(dinars.amountMinorUnits, 1_299_000n, "KWD's exponent is 3");
  });

  it("keeps a trailing-zero decimal exact", () => {
    const mapping = mapVendorPayload(
      { sku: 1, salePrice: 349.5, regularPrice: 399 },
      "1",
      USD,
    );
    assert.ok(mapping.ok);
    assert.equal(mapping.amountMinorUnits, 34_950n);
  });

  it("carries no floating point value anywhere in the result", () => {
    const mapping = resolved("product-on-sale.json", "8880044");
    for (const [key, value] of Object.entries(mapping)) {
      assert.notEqual(
        typeof value,
        "number",
        `${key} came back as a number, and money in this system is integers`,
      );
    }
  });
});

describe("criterion 7: a payload that does not resolve writes nothing", () => {
  const unresolvable: [string, string, string][] = [
    ["a price with more digits than the minor unit can hold", "product-inexact-price.json", "4410099"],
    ["no sale price at all", "product-no-sale-price.json", "3320011"],
    ["no regular price to derive the sale flag from", "product-no-regular-price.json", "3320012"],
    ["a price that is prose", "product-price-not-a-number.json", "2210044"],
    ["a document about another listing", "product-wrong-sku.json", "8880044"],
    ["two products where one listing was asked about", "products-two-results.json", "8880044"],
  ];

  for (const [what, fixture, listingId] of unresolvable) {
    it(`records a typed failure for ${what}`, () => {
      const mapping = refused(fixture, listingId);
      assert.ok(
        ["no-offer", "ambiguous-offer", "no-price", "no-currency"].includes(mapping.reason),
        `${mapping.reason} is not one of the extractor's typed reasons`,
      );
      assert.ok(mapping.detail.length > 0, "the failure carries no reason in words");
    });
  }

  it("refuses 12.995 in USD rather than rounding it to 12.99 or 13.00", () => {
    const mapping = refused("product-inexact-price.json", "4410099");
    assert.equal(mapping.reason, "no-price");
    // The same digits ARE representable in a three-exponent currency, which is
    // what shows the refusal is about the currency's minor unit and not about
    // the string.
    const dinars = resolved("product-inexact-price.json", "4410099", {
      currency: "KWD",
      timeZone: "Asia/Kuwait",
    });
    assert.equal(dinars.amountMinorUnits, 12_995n);
  });

  it("answers no-currency when the declared code resolves to no exponent", () => {
    const mapping = mapVendorPayload(
      { sku: 1, salePrice: 7.99, regularPrice: 9.99 },
      "1",
      { currency: "ZZZ", timeZone: "America/New_York" },
    );
    assert.ok(!mapping.ok);
    assert.equal(mapping.reason, "no-currency");
  });

  it("refuses a payload that is not a JSON object", () => {
    for (const payload of [null, 42, "a string", [1, 2]]) {
      const mapping = mapVendorPayload(payload, "1", USD);
      assert.ok(!mapping.ok, `${JSON.stringify(payload)} was accepted`);
      assert.equal(mapping.reason, "no-offer");
    }
  });

  it("writes NO price observation for any of them", async () => {
    const writer = recordingWriter();
    for (const [, fixture, listingId] of unresolvable) {
      const mapping = refused(fixture, listingId);
      const outcome = await recordObservation(
        writer,
        { ok: false, reason: mapping.reason },
        {
          sourceId: "bestbuy-api",
          listingId,
          observedAt: new Date("2026-09-06T12:00:00.000Z"),
          sourceTimeZone: "America/New_York",
          rawContext: "",
        },
      );
      assert.equal(outcome.written, false);
    }
    assert.deepEqual(
      writer.rows,
      [],
      "a refusal reached the writer, so a gap became a row",
    );
  });

  it("resolves the same envelope when it carries exactly one product", () => {
    // The other half of the ambiguity rule: one product inside the search
    // envelope is one offer and it resolves.
    const mapping = resolved("products-one-result.json", "8880044");
    assert.equal(mapping.amountMinorUnits, 799n);
  });
});

describe("criterion 8: an absent vendor timestamp stays absent", () => {
  const fetchInstant = new Date("2026-09-06T12:00:00.000Z");

  it("still resolves the observation when the vendor publishes none", () => {
    const mapping = resolved("product-no-price-update-date.json", "5901234");
    assert.equal(mapping.amountMinorUnits, 34_950n);
    assert.equal(mapping.vendorPriceUpdatedAt, null);
  });

  it("does not fill it in from the fetch instant", async () => {
    const writer = recordingWriter();
    const mapping = resolved("product-no-price-update-date.json", "5901234");
    await recordObservation(
      writer,
      {
        ok: true,
        amountMinorUnits: mapping.amountMinorUnits,
        currency: mapping.currency,
        availability: mapping.availability,
      },
      {
        sourceId: "bestbuy-api",
        listingId: "5901234",
        observedAt: fetchInstant,
        sourceTimeZone: "America/New_York",
        vendorPriceUpdatedAt: mapping.vendorPriceUpdatedAt,
        rawContextRetentionHours: 24,
        rawContext: "{}",
      },
    );

    assert.equal(writer.rows.length, 1);
    assert.equal(writer.rows[0].vendorPriceUpdatedAt, null);
    assert.equal(writer.rows[0].observedAt?.toISOString(), fetchInstant.toISOString());
  });

  it("treats an unreadable timestamp as absent rather than losing the price", () => {
    const mapping = resolved("product-unreadable-price-update-date.json", "7710055");
    assert.equal(mapping.amountMinorUnits, 1849n);
    assert.equal(mapping.vendorPriceUpdatedAt, null);
  });

  it("reads a zone-less vendor instant in the SOURCE's declared zone", () => {
    // 2026-09-05T14:32:00 with no offset. New York is on daylight time in
    // September, so UTC-4: the instant is 18:32Z. Read as UTC it would be
    // 14:32Z, and read in the host's own zone it would be anything at all.
    const eastern = resolved("product-on-sale.json", "8880044");
    assert.equal(
      eastern.vendorPriceUpdatedAt?.toISOString(),
      "2026-09-05T18:32:00.000Z",
    );

    const tokyo = resolved("product-on-sale.json", "8880044", {
      currency: "USD",
      timeZone: "Asia/Tokyo",
    });
    assert.equal(
      tokyo.vendorPriceUpdatedAt?.toISOString(),
      "2026-09-05T05:32:00.000Z",
      "the same string in another zone is another instant, which is the point",
    );
  });

  it("takes an explicit offset at its word", () => {
    const mapping = mapVendorPayload(
      {
        sku: 1,
        salePrice: 7.99,
        regularPrice: 9.99,
        priceUpdateDate: "2026-09-05T14:32:00Z",
      },
      "1",
      USD,
    );
    assert.ok(mapping.ok);
    assert.equal(
      mapping.vendorPriceUpdatedAt?.toISOString(),
      "2026-09-05T14:32:00.000Z",
    );
  });

  it("records no availability token, because the vendor documents none", () => {
    // The vendor's availability attributes are booleans about buying online or
    // picking up in a store, and not one is a schema.org ItemAvailability
    // member. An empty token is stored as NULL by the write path, which is the
    // honest answer: this source declared no availability.
    const mapping = resolved("product-on-sale.json", "8880044");
    assert.equal(mapping.availability, "");
  });
});
