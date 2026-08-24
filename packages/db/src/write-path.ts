/**
 * The write path, and the guard that is the point of it.
 *
 * `recordObservation` is the ONLY exported way an extraction result becomes a
 * row. It takes an `ExtractionResult` - the union, not the success - and a
 * failure returns before any writer method is called. There is no overload, no
 * flag and no second entry point that accepts a failure, so "a typed failure
 * never reaches a write" is a property of the shape of this module rather than
 * a rule someone has to remember at the call site.
 */

import type {
  ExtractionFailureReason,
  ExtractionResult,
  ObservationContext,
} from "@deal-sentinel/shared";

import type { HistoryDatabase } from "./connection.ts";
import { InvalidObservationError } from "./errors.ts";
import { RAW_CONTEXT_MAX_CHARS, priceObservations } from "./schema.ts";
import type { NewPriceObservationRow } from "./schema.ts";

/** The narrow port the write path needs. Anything wider is a temptation. */
export type HistoryWriter = {
  insertObservation(row: NewPriceObservationRow): Promise<bigint>;
};

export type WriteAccepted = {
  written: true;
  id: bigint;
  amountMinorUnits: bigint;
  currency: string;
};

export type WriteRefused = {
  written: false;
  /** The extractor's own typed reason, carried through unchanged. */
  reason: ExtractionFailureReason;
};

export type WriteOutcome = WriteAccepted | WriteRefused;

/** Wrap a Drizzle database as the writer the write path accepts. */
export function drizzleWriter(database: HistoryDatabase): HistoryWriter {
  return {
    async insertObservation(row) {
      const [inserted] = await database
        .insert(priceObservations)
        .values(row)
        .returning({ id: priceObservations.id });
      return inserted.id;
    },
  };
}

/**
 * Record one price observation, or refuse.
 *
 * A refusal is not an error: an extractor that cannot resolve exactly one price
 * and its currency has done its job correctly, and the caller records the typed
 * reason. What must never happen is a row.
 */
export async function recordObservation(
  writer: HistoryWriter,
  result: ExtractionResult,
  context: ObservationContext,
): Promise<WriteOutcome> {
  if (!result.ok) {
    // The single return that makes acceptance criterion 1 true. Nothing below
    // this line runs, and `writer` is never touched.
    return { written: false, reason: result.reason };
  }

  const row = buildRow(result, context);
  const id = await writer.insertObservation(row);
  return {
    written: true,
    id,
    amountMinorUnits: result.amountMinorUnits,
    currency: result.currency,
  };
}

function buildRow(
  result: Extract<ExtractionResult, { ok: true }>,
  context: ObservationContext,
): NewPriceObservationRow {
  requireText(context.sourceId, "sourceId");
  requireText(context.listingId, "listingId");
  requireText(context.sourceTimeZone, "sourceTimeZone");

  if (result.amountMinorUnits < 0n) {
    // The extractor refuses a negative price before it ever gets here, so this
    // is the boundary saying the same thing to a caller that built a success
    // by hand. No new-retail offer is priced below zero, and one negative row
    // is a permanent wrong answer to every later comparison on that listing.
    throw new InvalidObservationError(
      "amountMinorUnits must be a non-negative exact integer minor unit " +
        `(got ${result.amountMinorUnits}).`,
    );
  }

  if (context.storeId !== undefined && context.storeId !== null) {
    throw new InvalidObservationError(
      "storeId is reserved for the store-scoped dimension phase HARD-8 adds " +
        "and is left unpopulated until a store-scoped source exists. The " +
        "per-listing key is listingId, and a store id must never take that " +
        `job (got storeId=${JSON.stringify(context.storeId)}).`,
    );
  }

  if (!Number.isFinite(context.observedAt.getTime())) {
    throw new InvalidObservationError("observedAt is not a valid instant.");
  }

  const retention = context.rawContextRetentionHours;
  if (
    retention !== undefined &&
    retention !== null &&
    (!Number.isInteger(retention) || retention < 0)
  ) {
    throw new InvalidObservationError(
      `rawContextRetentionHours must be a whole number of hours or null (got ${retention}).`,
    );
  }

  return {
    sourceId: context.sourceId,
    listingId: context.listingId,
    storeId: null,
    amountMinorUnits: result.amountMinorUnits,
    currency: result.currency,
    observedAt: context.observedAt,
    sourceTimeZone: context.sourceTimeZone,
    vendorPriceUpdatedAt: context.vendorPriceUpdatedAt ?? null,
    rawContextRetentionHours: retention ?? null,
    rawContext: boundRawContext(context.rawContext),
    // Verbatim, including a token outside the twelve documented members. The
    // empty string means the markup declared no availability, which is stored
    // as NULL rather than as an empty token.
    availability: result.availability.length === 0 ? null : result.availability,
  };
}

/**
 * Keep the raw-context column inside its bound. Truncation is visible in the
 * stored value: a debugging aid that silently lost its tail would be worse than
 * one that says where it stopped.
 */
export function boundRawContext(rawContext: string): string {
  if (rawContext.length <= RAW_CONTEXT_MAX_CHARS) return rawContext;
  const marker = `\n<!-- truncated at ${RAW_CONTEXT_MAX_CHARS} characters -->`;
  return rawContext.slice(0, RAW_CONTEXT_MAX_CHARS - marker.length) + marker;
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidObservationError(`${field} is required and must not be empty.`);
  }
}
