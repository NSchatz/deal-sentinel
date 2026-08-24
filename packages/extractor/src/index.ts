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

export { minorUnitExponent, normaliseCurrency, toMinorUnits } from "./currency.ts";
export type { OfferCandidate } from "./offers.ts";

/**
 * Resolve exactly one offer price and its ISO 4217 currency from `markup`.
 *
 * Failure order, which is also the order a reader should think about it:
 *   - `no-offer`        nothing in the markup claims to be an Offer
 *   - `ambiguous-offer` more than one distinct offer, or one price RANGE
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
  if (offer.price === null) return { ok: false, reason: "no-price" };

  const currency =
    offer.currency === null ? null : normaliseCurrency(offer.currency);
  if (currency === null) return { ok: false, reason: "no-currency" };

  const amountMinorUnits = toMinorUnits(offer.price, currency);
  if (amountMinorUnits === null) return { ok: false, reason: "no-price" };

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
      candidate.price,
      candidate.currency,
      candidate.availability,
      candidate.priceIsRange,
    ]);
    if (!byIdentity.has(key)) byIdentity.set(key, candidate);
  }
  return [...byIdentity.values()];
}
