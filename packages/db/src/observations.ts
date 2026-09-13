/**
 * Reading price history back, and the narrow port the rule evaluation sees.
 *
 * This is the first READ over `price_observations` in the system. Everything
 * before it wrote: the write path put rows in and the retention sweep aged raw
 * content out. A rule that compares against history needs the other direction,
 * and the shape of that read is decided by three properties the comparison
 * depends on:
 *
 *   - EXACT. `amount_minor_units` comes back as a `bigint`, the same integer
 *     that went in. Nothing on this path divides, rounds or parses a decimal,
 *     because an all-time-low comparison is an equality and a float is
 *     documented inexact.
 *   - CARRYING ITS CURRENCY. Two numbers are only comparable when their
 *     currencies agree, and the row is the only thing that knows. A read that
 *     returned amounts alone would make a currency mismatch impossible to
 *     detect and trivially easy to alert on.
 *   - WINDOWED, per listing, oldest first. The window is the rule's own, so the
 *     query takes both ends of it rather than reading a listing's whole history
 *     and filtering in memory - the index this uses,
 *     `price_observations_listing_observed_idx`, is on exactly (listing_id,
 *     observed_at) and exists for this read.
 *
 * The port answers ONE question, in the shape `WatchlistStore` already set: a
 * caller that could reach a wider query could compare a listing against
 * somebody else's history.
 */

import { and, asc, eq, gt, lte } from "drizzle-orm";

import type { HistoryDatabase } from "./connection.ts";
import { priceObservations } from "./schema.ts";

/** One stored observation, reduced to what a rule may look at. */
export type ObservationPoint = {
  /** Exact integer minor units, as stored. Never a float on this path. */
  amountMinorUnits: bigint;
  /** ISO 4217 alphabetic code, upper case, as stored. */
  currency: string;
  observedAt: Date;
};

/** The narrow port the rule evaluation needs. Anything wider is a temptation. */
export type ObservationHistoryStore = {
  /**
   * Every observation for this listing with `after < observedAt <= until`,
   * oldest first. The lower bound is EXCLUSIVE and the upper bound is
   * INCLUSIVE, so a window of exactly `windowMs` ending at an instant contains
   * that instant's own observation and not the one exactly `windowMs` before
   * it - one rule, stated once, rather than two ends that drift apart.
   */
  windowFor(listingId: string, after: Date, until: Date): Promise<ObservationPoint[]>;
};

/** Wrap a Drizzle database as the history a rule evaluation reads. */
export function drizzleObservationHistory(
  database: HistoryDatabase,
): ObservationHistoryStore {
  return {
    async windowFor(listingId, after, until) {
      const rows = await database
        .select({
          amountMinorUnits: priceObservations.amountMinorUnits,
          currency: priceObservations.currency,
          observedAt: priceObservations.observedAt,
        })
        .from(priceObservations)
        .where(
          and(
            eq(priceObservations.listingId, listingId),
            gt(priceObservations.observedAt, after),
            lte(priceObservations.observedAt, until),
          ),
        )
        .orderBy(asc(priceObservations.observedAt));
      return rows;
    },
  };
}

/**
 * One stored observation as a SURFACE shows it: the same exact amount and
 * instant a rule sees, plus the availability token the source published.
 *
 * A second, wider point type rather than a wider `ObservationPoint`, for the
 * reason `watchlist.ts` keeps two entry types: a rule compares numbers and must
 * not be handed a token it might branch on, while a page showing history has to
 * show what the source actually said - including a token this system does not
 * recognise, verbatim, because the alternative is quietly dropping it.
 */
export type ObservationSeriesPoint = ObservationPoint & {
  /** The schema.org token as received, or null where the markup declared none. */
  availability: string | null;
};

/** The narrow port an operator surface reads a listing's history through. */
export type ObservationSeriesStore = {
  /** The same window rule as `windowFor`: `after < observedAt <= until`. */
  seriesFor(
    listingId: string,
    after: Date,
    until: Date,
  ): Promise<ObservationSeriesPoint[]>;
};

export function drizzleObservationSeries(
  database: HistoryDatabase,
): ObservationSeriesStore {
  return {
    async seriesFor(listingId, after, until) {
      return await database
        .select({
          amountMinorUnits: priceObservations.amountMinorUnits,
          currency: priceObservations.currency,
          observedAt: priceObservations.observedAt,
          availability: priceObservations.availability,
        })
        .from(priceObservations)
        .where(
          and(
            eq(priceObservations.listingId, listingId),
            gt(priceObservations.observedAt, after),
            lte(priceObservations.observedAt, until),
          ),
        )
        .orderBy(asc(priceObservations.observedAt));
    },
  };
}

/** The same read in memory, for a caller with no database. */
export function memoryObservationSeries(
  rows: Readonly<Record<string, readonly ObservationSeriesPoint[]>>,
): ObservationSeriesStore {
  return {
    seriesFor(listingId, after, until) {
      const held = rows[listingId] ?? [];
      return Promise.resolve(
        held
          .filter(
            (point) =>
              point.observedAt.getTime() > after.getTime() &&
              point.observedAt.getTime() <= until.getTime(),
          )
          .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime())
          .map((point) => ({ ...point })),
      );
    },
  };
}

/**
 * The same read in memory, answering by the same rule, for a caller with no
 * database. A test that uses it is testing the caller and not this.
 */
export function memoryObservationHistory(
  rows: Readonly<Record<string, readonly ObservationPoint[]>>,
): ObservationHistoryStore {
  return {
    windowFor(listingId, after, until) {
      const held = rows[listingId] ?? [];
      return Promise.resolve(
        held
          .filter(
            (point) =>
              point.observedAt.getTime() > after.getTime() &&
              point.observedAt.getTime() <= until.getTime(),
          )
          .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime())
          .map((point) => ({ ...point })),
      );
    },
  };
}
