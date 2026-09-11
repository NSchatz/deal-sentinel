/**
 * Cross-package types for deal-sentinel: the price, currency and availability
 * shapes `@deal-sentinel/extractor` produces and `@deal-sentinel/db`'s write
 * path consumes. It depends on no package here, so a caller can narrow an
 * `ExtractionResult` without importing either side of it. A later phase may
 * extend the `reason` union; it may not change a success.
 */

export type ExtractionFailureReason =
  | "no-offer"
  | "ambiguous-offer"
  | "no-price"
  | "no-currency";

/** Recorded instead of an observation: a gap is visible, a wrong number is not. */
export type ExtractionFailure = {
  ok: false;
  reason: ExtractionFailureReason;
};

/** A resolved offer: exactly one price, in exactly one ISO 4217 currency. */
export type ExtractionSuccess = {
  ok: true;
  /**
   * An exact integer in the currency's own minor unit, scaled by its ISO 4217
   * minor-unit exponent (2 for USD, 0 for JPY, 3 for KWD). Never a float,
   * never a fixed multiply-by-100.
   */
  amountMinorUnits: bigint;
  /** ISO 4217 alphabetic code, upper case, e.g. "USD". */
  currency: string;
  /** The schema.org token verbatim, unrecognised included; empty means none. */
  availability: string;
};

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/** Everything the caller knows that the markup does not. */
export type ObservationContext = {
  sourceId: string;
  /** The tracked URL or the source's listing id. `storeId` is never this key. */
  listingId: string;
  /** Reserved for the store-scoped dimension HARD-8 adds; unused this phase. */
  storeId?: string | null;
  observedAt: Date;
  /**
   * IANA name. `timestamptz` drops the input zone, and a 90-day low is
   * anchored to the retailer's local day.
   */
  sourceTimeZone: string;
  vendorPriceUpdatedAt?: Date | null;
  /** Per-source, so a column rather than a setting. Null where none declared. */
  rawContextRetentionHours?: number | null;
  /** Bounded offer markup only: no review body, no reviewer, no account id. */
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
