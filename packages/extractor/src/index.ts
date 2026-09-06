/**
 * The pure offer extractor.
 *
 * `extractOffer` takes markup and returns either exactly one price with its
 * ISO 4217 currency and the availability token the markup carried, or a typed
 * failure saying why it refused. It never guesses: a gap is visible a week
 * later and a wrong number is not, and a wrong number cannot be un-recorded
 * because the page it came from is gone.
 *
 * Purity is a package boundary, not a description. This package imports
 * `@deal-sentinel/shared` and nothing else: no database client, no HTTP client,
 * no filesystem. Its tests read the committed fixtures beside it; the function
 * itself takes a string.
 */

import type { ExtractionResult } from "@deal-sentinel/shared";
import { findOfferCandidates } from "./offers.ts";
import type { OfferCandidate } from "./offers.ts";
import { normaliseCurrency, toMinorUnits } from "./currency.ts";

export {
  formatMinorUnits,
  minorUnitExponent,
  normaliseCurrency,
  toMinorUnits,
} from "./currency.ts";
export type { OfferCandidate } from "./offers.ts";

/**
 * Resolve exactly one offer price and its ISO 4217 currency from `markup`.
 *
 * Failure order, which is also the order a reader should think about it:
 *   - `no-offer`        nothing in the markup claims to be an Offer
 *   - `ambiguous-offer` more than one distinct offer, one price RANGE, or a
 *                       single offer stating two prices or two currencies that
 *                       do not agree
 *   - `no-price`        an offer with no price, or a price no exact minor-unit
 *                       conversion can represent
 *   - `no-currency`     a price whose currency is absent or is not a code this
 *                       repo resolves to an ISO 4217 minor-unit exponent
 */
export function extractOffer(markup: string): ExtractionResult {
  const candidates = findOfferCandidates(markup);
  if (candidates.length === 0) return { ok: false, reason: "no-offer" };

  const distinct = dedupe(candidates);
  if (distinct.length > 1) return { ok: false, reason: "ambiguous-offer" };

  const offer = distinct[0];
  if (offer.priceIsRange) return { ok: false, reason: "ambiguous-offer" };
  // Two different currency codes on one offer are not "its ISO 4217 currency".
  if (offer.currencies.length > 1) return { ok: false, reason: "ambiguous-offer" };
  if (offer.prices.length === 0) return { ok: false, reason: "no-price" };

  const currency =
    offer.currencies.length === 0 ? null : normaliseCurrency(offer.currencies[0]);
  if (currency === null) return { ok: false, reason: "no-currency" };

  // One offer can spell one price twice - a machine-readable `content` and the
  // visible text beside it. Those agree once both are converted, and agreeing
  // is what makes them one price. Two prices that do NOT agree (a struck-out
  // price and a sale price marked up as the same offer) are not one offer
  // price, and a gap is visible a week later where a wrong number is not.
  const amounts = new Set<bigint>();
  for (const price of offer.prices) {
    const minor = toMinorUnits(price, currency);
    if (minor === null) return { ok: false, reason: "no-price" };
    amounts.add(minor);
  }
  if (amounts.size > 1) return { ok: false, reason: "ambiguous-offer" };

  const [amountMinorUnits] = amounts;

  return {
    ok: true,
    amountMinorUnits,
    currency,
    availability: offer.availability,
  };
}

/**
 * Collapse candidates that state the same offer. The same offer is routinely
 * present twice (a JSON-LD block repeated per view, or a Product node and a
 * @graph node describing one listing), and that is one offer, not two. Two
 * candidates that differ in any field are two offers, and two offers on a page
 * this phase cannot tell apart is `ambiguous-offer`.
 */
function dedupe(candidates: OfferCandidate[]): OfferCandidate[] {
  const byIdentity = new Map<string, OfferCandidate>();
  for (const candidate of candidates) {
    const key = JSON.stringify([
      candidate.prices,
      candidate.currencies,
      candidate.availability,
      candidate.priceIsRange,
    ]);
    if (!byIdentity.has(key)) byIdentity.set(key, candidate);
  }
  return [...byIdentity.values()];
}
