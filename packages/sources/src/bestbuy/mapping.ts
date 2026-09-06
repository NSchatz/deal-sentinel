/**
 * The sanctioned API's payload, mapped onto the observation record.
 *
 * PURE. This module takes a parsed payload and two per-source declarations and
 * returns either one resolved price or a typed failure. It reaches no network,
 * no clock and no database, which is what lets every unhappy path below be
 * graded against a fixture in milliseconds.
 *
 * The vendor's documented attributes this reads, quoted from its own tables:
 *
 *   `sku`              "Best Buy unique 7-digit product identifier"
 *   `salePrice`        "Current item selling price"
 *   `regularPrice`     "Product's regular selling price"
 *   `onSale`           "Identifies if sale price is less than regular price"
 *   `priceUpdateDate`  "Date and time product price was last updated"
 *
 * BOTH PRICE FIELDS ARE LOAD-BEARING and a payload carrying only one of them is
 * refused. The observation's amount is `salePrice`, which is the price a buyer
 * pays; `regularPrice` is what makes that number mean anything, because "is
 * this a deal" is a comparison and the vendor's own definition of `onSale` is
 * the comparison between exactly these two fields. Deriving the flag from
 * `onSale` alone would be trusting a boolean this system cannot check, and a
 * later phase's historical-low rule would then be reading a sale flag whose
 * reference price was never stored. Refusing is the fail-safe direction: a gap
 * is visible a week later and a wrong number is not.
 *
 * NO CLEARANCE. The vendor documents `onSale` and no clearance attribute at
 * all, so nothing here derives one. That limitation belongs to the retailer and
 * is recorded rather than papered over.
 *
 * NO CURRENCY AND NO ZONE IN THE PAYLOAD. The vendor's documentation publishes
 * neither, anywhere. Both arrive as per-source declarations from the registry,
 * which refuses a source that carries neither rather than guessing.
 */

import type { ExtractionFailureReason } from "@deal-sentinel/shared";
import { toMinorUnits } from "@deal-sentinel/extractor";

import { readVendorTimestamp } from "../time-zone.ts";

export type VendorMapping =
  | {
      ok: true;
      /** `salePrice` in the currency's own ISO 4217 minor unit. Exact. */
      amountMinorUnits: bigint;
      /** `regularPrice`, likewise, kept for the derivation below. */
      regularPriceMinorUnits: bigint;
      currency: string;
      /**
       * Derived the way the vendor defines it - "sale price is less than
       * regular price" - from the two amounts above, and never read off the
       * payload's own boolean.
       */
      onSale: boolean;
      /** What the vendor's own `onSale` said, for a disagreement to be visible. */
      vendorOnSale: boolean | null;
      /**
       * The schema.org ItemAvailability token. ALWAYS EMPTY for this source,
       * which the write path stores as NULL. The vendor's availability
       * attributes are booleans about whether a product can be bought online or
       * picked up in a store; not one of them is an ItemAvailability member,
       * and mapping a boolean onto a token would be this system inventing a
       * claim the vendor did not make.
       */
      availability: string;
      /** The vendor's own price-update instant, or null where it published none. */
      vendorPriceUpdatedAt: Date | null;
      /** The sku the payload resolved to, as text. */
      sku: string;
    }
  | { ok: false; reason: ExtractionFailureReason; detail: string };

export type MappingSettings = {
  /** ISO 4217 code from the source registry. The payload publishes none. */
  currency: string;
  /** IANA zone from the source registry. Zone-less vendor instants use it. */
  timeZone: string;
};

/**
 * Resolve one watchlist entry's price from a vendor payload.
 *
 * `listingId` is the entry the run asked for, and the payload has to be about
 * it. A document for another sku is not a wrong-looking price for this
 * listing - it is another listing's price, and writing it under this key is a
 * poisoning no later comparison can detect.
 */
export function mapVendorPayload(
  payload: unknown,
  listingId: string,
  settings: MappingSettings,
): VendorMapping {
  const product = resolveProduct(payload, listingId);
  if (!product.ok) return product;
  const node = product.node;

  const currency = settings.currency.trim().toUpperCase();

  const sale = readPrice(node.salePrice, currency);
  if (sale.kind !== "amount") {
    return {
      ok: false,
      reason: sale.kind === "absent" ? "no-price" : sale.reason,
      detail:
        sale.kind === "absent"
          ? `the payload for ${listingId} carries no salePrice, which is the ` +
            "vendor's own \"current item selling price\" and the only field " +
            "this adapter records as the observed amount."
          : sale.detail,
    };
  }

  const regular = readPrice(node.regularPrice, currency);
  if (regular.kind !== "amount") {
    return {
      ok: false,
      reason: regular.kind === "absent" ? "no-price" : regular.reason,
      detail:
        regular.kind === "absent"
          ? `the payload for ${listingId} carries no regularPrice. The vendor ` +
            "defines onSale as \"sale price is less than regular price\", so " +
            "without it this adapter would be recording a sale price with no " +
            "reference price behind it, and a later rule would compare " +
            "against a number nobody stored."
          : regular.detail,
    };
  }

  return {
    ok: true,
    amountMinorUnits: sale.amount,
    regularPriceMinorUnits: regular.amount,
    currency,
    onSale: sale.amount < regular.amount,
    vendorOnSale: typeof node.onSale === "boolean" ? node.onSale : null,
    availability: "",
    vendorPriceUpdatedAt: readVendorTimestamp(node.priceUpdateDate, settings.timeZone),
    sku: product.sku,
  };
}

type PriceReading =
  | { kind: "amount"; amount: bigint }
  | { kind: "absent" }
  | { kind: "unusable"; reason: ExtractionFailureReason; detail: string };

/**
 * One vendor price field, as an exact integer in the currency's minor unit.
 *
 * The vendor sends prices as JSON NUMBERS (`"salePrice": 7.99`), and a JSON
 * number is a double. `String()` prints the shortest decimal that round-trips
 * to that double, so the decimal the vendor wrote comes back exactly for every
 * price a retailer can quote, and the conversion to minor units is then done on
 * DIGITS by the currency's own ISO 4217 exponent - 2 for USD, 0 for JPY, 3 for
 * KWD - and never by a fixed multiply-by-100 and never on the double itself. A
 * value that cannot be represented exactly in that exponent (12.995 in USD) is
 * a typed failure, because rounding a price is how a history gets poisoned in a
 * way nobody can see a week later.
 */
function readPrice(value: unknown, currency: string): PriceReading {
  if (value === undefined || value === null) return { kind: "absent" };

  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return {
        kind: "unusable",
        reason: "no-price",
        detail: `the payload carries ${String(value)} where a price belongs.`,
      };
    }
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    return {
      kind: "unusable",
      reason: "no-price",
      detail:
        "the payload carries a price that is neither a number nor a string " +
        `(${describeType(value)}), so no exact minor-unit amount resolves.`,
    };
  }

  const amount = toMinorUnits(text, currency);
  if (amount === null) {
    // Two conditions land here and the message says which. An unresolvable
    // CURRENCY is the caller's declaration being wrong; an unresolvable PRICE
    // is the payload's.
    if (toMinorUnits("1", currency) === null) {
      return {
        kind: "unusable",
        reason: "no-currency",
        detail:
          `${JSON.stringify(currency)} does not resolve to an ISO 4217 ` +
          "minor-unit exponent, so no exact amount can be derived from " +
          "any price in this payload.",
      };
    }
    return {
      kind: "unusable",
      reason: "no-price",
      detail:
        `${JSON.stringify(text)} does not resolve to exactly one exact ` +
        `amount in ${currency}'s minor unit. Nothing is rounded and nothing ` +
        "is written.",
    };
  }

  return { kind: "amount", amount };
}

type ProductResolution =
  | { ok: true; node: Record<string, unknown>; sku: string }
  | { ok: false; reason: ExtractionFailureReason; detail: string };

/**
 * Find the one product document this payload is about.
 *
 * The vendor answers a single-product call with the product document itself and
 * a search with `{ "products": [ ... ] }`, so both shapes are read. More than
 * one product is `ambiguous-offer`: a run asked about one listing and got
 * several, and picking one of them is a guess.
 */
function resolveProduct(payload: unknown, listingId: string): ProductResolution {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      reason: "no-offer",
      detail:
        `the payload for ${listingId} is not a JSON object, so it carries no ` +
        "product document at all.",
    };
  }

  const root = payload as Record<string, unknown>;
  let node: Record<string, unknown> = root;

  if (Array.isArray(root.products)) {
    const products = root.products.filter(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" && candidate !== null && !Array.isArray(candidate),
    );
    if (products.length === 0) {
      return {
        ok: false,
        reason: "no-offer",
        detail: `the payload for ${listingId} carries an empty products list.`,
      };
    }
    if (products.length > 1) {
      return {
        ok: false,
        reason: "ambiguous-offer",
        detail:
          `the payload carries ${products.length} products where ` +
          `${listingId} is one listing. Choosing one of them is a guess, and ` +
          "a guess about which product a price belongs to is unrecoverable.",
      };
    }
    node = products[0];
  }

  const sku = node.sku;
  if (sku === undefined || sku === null) {
    return {
      ok: false,
      reason: "no-offer",
      detail:
        `the payload for ${listingId} carries no sku, so nothing in it can be ` +
        "shown to be about the listing that was asked for.",
    };
  }

  const skuText = String(sku).trim();
  if (skuText !== listingId.trim()) {
    // Not "a price this reader could not resolve": a price for ANOTHER
    // listing. Recording it under this key would be a wrong number attributed
    // to a product that never had it, and no later comparison could detect it.
    return {
      ok: false,
      reason: "no-offer",
      detail:
        `the payload is about sku ${JSON.stringify(skuText)} and the ` +
        `watchlist entry asked for ${JSON.stringify(listingId)}. There is no ` +
        "offer for the listing that was requested, and another listing's " +
        "price is never written under this one's key.",
    };
  }

  return { ok: true, node, sku: skuText };
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
