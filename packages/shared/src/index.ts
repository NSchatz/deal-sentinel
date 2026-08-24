/**
 * Cross-package types for deal-sentinel.
 *
 * This package holds the price / currency / availability shapes that
 * `@deal-sentinel/extractor` produces and that `@deal-sentinel/db`'s write path
 * consumes, and nothing else. It depends on no other package in this repo, and
 * it contains no runtime behaviour beyond the two type guards at the bottom,
 * which exist so a caller can narrow an `ExtractionResult` without importing
 * either of the two packages that sit on either side of it.
 *
 * The shapes below are fixed by spec S0002-deal-sentinel-history-1, section
 * "Layout decision". A later phase may extend the `reason` union; it may not
 * change the shape of a success.
 */

/** Why an extraction refused to produce a price observation. */
export type ExtractionFailureReason =
  | "no-offer"
  | "ambiguous-offer"
  | "no-price"
  | "no-currency";

/**
 * A typed extraction failure. The system records this and writes no price
 * observation: a gap is visible and a wrong number is not.
 */
export type ExtractionFailure = {
  ok: false;
  reason: ExtractionFailureReason;
};

/** A resolved offer: exactly one price, in exactly one ISO 4217 currency. */
export type ExtractionSuccess = {
  ok: true;
  /**
   * The price as an exact integer in the currency's own minor unit, scaled by
   * that currency's ISO 4217 minor-unit exponent (2 for USD, 0 for JPY, 3 for
   * KWD). Never a float, never a fixed multiply-by-100.
   */
  amountMinorUnits: bigint;
  /** ISO 4217 alphabetic code, upper case, e.g. "USD". */
  currency: string;
  /**
   * The schema.org ItemAvailability token exactly as the markup carried it,
   * including a token this system does not recognise. The empty string means
   * the markup declared no availability at all.
   */
  availability: string;
};

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/**
 * The non-extraction half of a price observation: everything the caller knows
 * that the markup does not. The write path takes one of these plus an
 * `ExtractionResult`.
 */
export type ObservationContext = {
  /** Which adapter produced this row, e.g. "bestbuy-api" or "jsonld-generic". */
  sourceId: string;
  /**
   * The natural key of the listing observed - the tracked URL, or the source's
   * own listing id. This is the per-listing key. `storeId` is never it.
   */
  listingId: string;
  /**
   * Reserved for the store-scoped retail dimension phase HARD-8 adds. No source
   * in this phase is store-scoped, so this phase never populates it.
   */
  storeId?: string | null;
  /** The timezone-aware instant the observation was made. */
  observedAt: Date;
  /**
   * The source's own local time zone as an IANA name, e.g. "America/New_York".
   * Stored beside the instant because `timestamptz` does not retain the input
   * zone, and a 90-day low is anchored to the retailer's local day.
   */
  sourceTimeZone: string;
  /** The vendor's own price-update timestamp, where the source publishes one. */
  vendorPriceUpdatedAt?: Date | null;
  /**
   * How many hours this source's terms allow raw content to be retained, or
   * null where the source declares no ceiling. A per-source property, so it is
   * a column on the row rather than a global setting.
   */
  rawContextRetentionHours?: number | null;
  /**
   * Enough of the parsed offer markup to debug a parser break. Bounded, and
   * reduced to the offer markup under test: no review body, no reviewer name,
   * no account identifier ever reaches this column.
   */
  rawContext: string;
};

export function isExtractionSuccess(
  result: ExtractionResult,
): result is ExtractionSuccess {
  return result.ok;
}

export function isExtractionFailure(
  result: ExtractionResult,
): result is ExtractionFailure {
  return !result.ok;
}
