import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

import { extractOffer, minorUnitExponent, toMinorUnits } from "../src/index.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

describe("extractOffer: offers that resolve", () => {
  it("resolves one clean USD offer to exact minor units", () => {
    const result = extractOffer(fixture("single-offer-clean.html"));
    assert.deepEqual(result, {
      ok: true,
      amountMinorUnits: 12999n,
      currency: "USD",
      availability: "https://schema.org/InStock",
    });
  });

  it("scales JPY by its own exponent of 0, not by a fixed 100", () => {
    const result = extractOffer(fixture("single-offer-jpy.html"));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.currency, "JPY");
    // 12800 yen is 12800 minor units. A fixed multiply-by-100 gives 1280000
    // and records a price a hundred times too high, forever.
    assert.equal(result.ok && result.amountMinorUnits, 12800n);
  });

  it("scales KWD by its own exponent of 3", () => {
    const result = extractOffer(fixture("single-offer-kwd.html"));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.currency, "KWD");
    assert.equal(result.ok && result.amountMinorUnits, 12995n);
  });

  it("reads a thousands separator in a USD price", () => {
    const result = extractOffer(fixture("unrecognised-availability-token.html"));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.amountMinorUnits, 129900n);
  });

  it("reads an offer expressed as microdata", () => {
    const result = extractOffer(fixture("microdata-single-offer.html"));
    assert.deepEqual(result, {
      ok: true,
      amountMinorUnits: 125000n,
      currency: "GBP",
      availability: "https://schema.org/BackOrder",
    });
  });
});

describe("extractOffer: availability is stored as received", () => {
  it("keeps a token outside the twelve documented members, verbatim", () => {
    const result = extractOffer(fixture("unrecognised-availability-token.html"));
    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.availability,
      "https://schema.org/ShipsInTwoToThreeWeeks",
    );
    // Not a boolean, not dropped, not mapped onto the nearest known member.
    assert.equal(typeof (result.ok && result.availability), "string");
  });

  it("reports an absent availability field as the empty string", () => {
    const result = extractOffer(fixture("offer-without-availability.html"));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.availability, "");
  });
});

describe("extractOffer: typed failures, never a guess", () => {
  const cases: Array<[string, string]> = [
    ["no-offer-markup.html", "no-offer"],
    ["two-variant-offers.html", "ambiguous-offer"],
    ["aggregate-offer-range.html", "ambiguous-offer"],
    ["offer-without-price.html", "no-price"],
    ["price-not-a-number.html", "no-price"],
    ["price-without-currency.html", "no-currency"],
    ["currency-not-iso-4217.html", "no-currency"],
  ];

  for (const [name, reason] of cases) {
    it(`${name} fails with ${reason}`, () => {
      const result = extractOffer(fixture(name));
      assert.deepEqual(result, { ok: false, reason });
    });
  }

  it("never returns a price on any failing fixture", () => {
    for (const [name] of cases) {
      const result = extractOffer(fixture(name));
      assert.equal(result.ok, false);
      assert.equal("amountMinorUnits" in result, false);
    }
  });
});

describe("minor-unit conversion is per-currency, by ISO 4217 exponent", () => {
  it("knows the exponents of the exception currencies", () => {
    assert.equal(minorUnitExponent("USD"), 2);
    assert.equal(minorUnitExponent("EUR"), 2);
    assert.equal(minorUnitExponent("JPY"), 0);
    assert.equal(minorUnitExponent("KRW"), 0);
    assert.equal(minorUnitExponent("KWD"), 3);
    assert.equal(minorUnitExponent("CLF"), 4);
  });

  it("refuses a code it cannot resolve rather than assuming 2", () => {
    assert.equal(minorUnitExponent("XYZ"), null);
    assert.equal(minorUnitExponent("$"), null);
    assert.equal(minorUnitExponent(""), null);
    assert.equal(toMinorUnits("10.00", "XYZ"), null);
  });

  it("converts by the currency's own exponent", () => {
    assert.equal(toMinorUnits("12.99", "USD"), 1299n);
    assert.equal(toMinorUnits("1299", "JPY"), 1299n);
    assert.equal(toMinorUnits("12.995", "KWD"), 12995n);
    assert.equal(toMinorUnits("1,299.00", "USD"), 129900n);
    assert.equal(toMinorUnits("$129.99", "USD"), 12999n);
    assert.equal(toMinorUnits("12.9900", "USD"), 1299n);
  });

  it("refuses a price it cannot represent exactly", () => {
    // A third decimal in a two-decimal currency would have to be rounded, and
    // a rounded price is indistinguishable from a true one a week later.
    assert.equal(toMinorUnits("12.995", "USD"), null);
    // JPY has no subdivision at all.
    assert.equal(toMinorUnits("1299.5", "JPY"), null);
    // "1.299" is 1299 in de-DE and 1.299 in en-US. Guessing is the poisoning.
    assert.equal(toMinorUnits("1.299,00", "EUR"), null);
    assert.equal(toMinorUnits("Call for price", "USD"), null);
    assert.equal(toMinorUnits("", "USD"), null);
  });
});

describe("the fixture invariant", () => {
  const FORBIDDEN = [
    /\breview(Body|Rating|Count|s)?\b/i,
    /\baggregateRating\b/i,
    /\bauthor\b/i,
    /\breviewer\b/i,
    /\bcustomerId\b/i,
    /\baccountId\b/i,
    /\buserName\b/i,
  ];

  /**
   * The invariant is about the MARKUP, so the provenance comment at the top of
   * each fixture (which says the words "no review body" out loud) is removed
   * before scanning, and its presence is asserted separately.
   */
  function withoutComments(markup: string): string {
    return markup.replace(/<!--[\s\S]*?-->/g, "");
  }

  const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".html"));

  it("has committed fixture files at all", () => {
    assert.ok(files.length > 0, "expected committed fixture files");
  });

  it("commits no review body, reviewer name or account identifier", () => {
    for (const name of files) {
      const markup = withoutComments(fixture(name));
      for (const pattern of FORBIDDEN) {
        assert.equal(
          pattern.test(markup),
          false,
          `${name} matches ${pattern}: fixtures carry offer markup only`,
        );
      }
    }
  });

  it("states the invariant in every fixture's provenance comment", () => {
    for (const name of files) {
      assert.match(
        fixture(name),
        /no review body/i,
        `${name} is missing the provenance comment`,
      );
    }
  });
});
