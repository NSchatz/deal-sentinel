/**
 * The read-only query surface the operator view is built on.
 *
 * EVERY FUNCTION HERE IS A SELECT. Not "is currently"; may not become anything
 * else. The tables under this module are the irreplaceable thing in the system -
 * a price history accrues at one observation per listing per run and cannot be
 * backfilled - and three of them carry once-only marks (`warned_at`,
 * `stopped_at`, `notified_at`) whose whole purpose is that a second notification
 * is never sent. A read path that touched one of those would spend the mark it
 * was reading.
 *
 * That is also why the allowance is read HERE as rows and not through
 * `AllowanceLedger.check`. The ledger's read is advisory but not passive: at the
 * limit it announces the stop, which claims `stopped_at` and emits the period's
 * one notification. Reading the allowance to SHOW it must never be able to spend
 * it, warn on it or notify against it, so the display path reads the row and
 * does the subtraction itself.
 *
 * Each read is also NARROW - one question, its bounds as arguments - for the
 * reason `WatchlistStore` and `ObservationHistoryStore` already give: a caller
 * that could reach a wider query could show somebody else's history.
 */

import { and, asc, desc, eq, gt, gte, lt, sql } from "drizzle-orm";

import type { HistoryDatabase } from "./connection.ts";
import {
  breakerPauses,
  fetchOutcomes,
  governorAllowanceUsage,
  priceObservations,
  sourcePeriodStops,
  watchlistEntries,
} from "./schema.ts";
import type { FetchOutcomeClass } from "./schema.ts";

/* -------------------------------------------------------------------------- */
/* Fetch outcomes                                                              */
/* -------------------------------------------------------------------------- */

/** How many outcomes of one class one source had inside one period. */
export type FetchOutcomeCount = {
  sourceId: string;
  outcomeClass: FetchOutcomeClass;
  count: number;
};

/**
 * Count every recorded outcome whose instant falls inside `[from, to)`, grouped
 * by source and class.
 *
 * HALF-OPEN, and stated rather than left to be discovered: the lower bound is
 * inclusive and the upper bound is exclusive, so two adjacent periods partition
 * the records between them and no row is counted in both or in neither. A row
 * outside the bounds is excluded by the WHERE clause and not by a filter a
 * caller has to remember.
 */
export async function countFetchOutcomes(
  database: HistoryDatabase,
  from: Date,
  to: Date,
): Promise<FetchOutcomeCount[]> {
  const rows = await database
    .select({
      sourceId: fetchOutcomes.sourceId,
      outcomeClass: fetchOutcomes.outcomeClass,
      count: sql<string>`count(*)`,
    })
    .from(fetchOutcomes)
    .where(
      and(
        gte(fetchOutcomes.occurredAt, from),
        lt(fetchOutcomes.occurredAt, to),
      ),
    )
    .groupBy(fetchOutcomes.sourceId, fetchOutcomes.outcomeClass);

  return rows.map((row) => ({
    sourceId: row.sourceId,
    outcomeClass: row.outcomeClass as FetchOutcomeClass,
    count: Number(row.count),
  }));
}

/**
 * The instant of each source's most recent `success`, over ALL of history and
 * not only the requested period.
 *
 * Deliberately unbounded in time: the staleness verdict asks "when did this
 * source last work", and answering it inside the period would report every
 * source broken the moment somebody looked at a narrow window.
 */
export async function lastSuccessInstants(
  database: HistoryDatabase,
): Promise<Map<string, Date>> {
  const rows = await database
    .select({
      sourceId: fetchOutcomes.sourceId,
      lastSuccessAt: sql<Date>`max(${fetchOutcomes.occurredAt})`,
    })
    .from(fetchOutcomes)
    .where(eq(fetchOutcomes.outcomeClass, "success"))
    .groupBy(fetchOutcomes.sourceId);

  const instants = new Map<string, Date>();
  for (const row of rows) {
    if (row.lastSuccessAt === null) continue;
    instants.set(row.sourceId, new Date(row.lastSuccessAt));
  }
  return instants;
}

/** One recorded outcome, for the operator surface that shows recent conditions. */
export type RecentFetchOutcome = {
  sourceId: string;
  outcomeClass: FetchOutcomeClass;
  latencyMs: number;
  occurredAt: Date;
  condition: string | null;
};

/**
 * The most recent outcomes for one source that carry a condition, newest first.
 *
 * Conditions only: a successful fetch has nothing to say, and a list padded
 * with successes is a list nobody reads to the end of.
 */
export async function recentConditions(
  database: HistoryDatabase,
  sourceId: string,
  limit: number,
): Promise<RecentFetchOutcome[]> {
  const rows = await database
    .select()
    .from(fetchOutcomes)
    .where(
      and(
        eq(fetchOutcomes.sourceId, sourceId),
        sql`${fetchOutcomes.condition} is not null`,
      ),
    )
    .orderBy(desc(fetchOutcomes.occurredAt), desc(fetchOutcomes.id))
    .limit(limit);

  return rows.map((row) => ({
    sourceId: row.sourceId,
    outcomeClass: row.outcomeClass as FetchOutcomeClass,
    latencyMs: row.latencyMs,
    occurredAt: row.occurredAt,
    condition: row.condition,
  }));
}

/* -------------------------------------------------------------------------- */
/* Breaker pauses                                                              */
/* -------------------------------------------------------------------------- */

export type BreakerPauseReading = {
  sourceId: string;
  pausedAt: Date;
  expiresAt: Date;
  failingCount: number;
  windowOutcomes: number;
  windowMs: number;
  failureRateThreshold: string;
  condition: string;
};

/**
 * The pause in force for this source AT `at`, or null.
 *
 * "In force" is `paused_at <= at < expires_at`, compared against the instant the
 * caller hands in and against nothing else. That is the whole of AC13: an
 * expired pause answers null here on the very next read, with no restart, no
 * sweep and no manual reset, while its row stays exactly where it is.
 */
export async function currentBreakerPause(
  database: HistoryDatabase,
  sourceId: string,
  at: Date,
): Promise<BreakerPauseReading | null> {
  const rows = await database
    .select()
    .from(breakerPauses)
    .where(
      and(
        eq(breakerPauses.sourceId, sourceId),
        gt(breakerPauses.expiresAt, at),
        sql`${breakerPauses.pausedAt} <= ${at}`,
      ),
    )
    .orderBy(desc(breakerPauses.pausedAt))
    .limit(1);

  return rows[0] ?? null;
}

/** Every recorded pause for a source, newest first. History, expired or not. */
export async function breakerPauseHistory(
  database: HistoryDatabase,
  sourceId: string,
  limit: number,
): Promise<BreakerPauseReading[]> {
  return await database
    .select()
    .from(breakerPauses)
    .where(eq(breakerPauses.sourceId, sourceId))
    .orderBy(desc(breakerPauses.pausedAt), desc(breakerPauses.id))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* The allowance counter, and the vendor's own stop                            */
/* -------------------------------------------------------------------------- */

export type AllowanceUsageReading = {
  consumed: number;
  warnedAt: Date | null;
  stoppedAt: Date | null;
};

/**
 * This period's counter row for a metered source, or null when the period has
 * not written one yet.
 *
 * NULL IS NOT AN ERROR and the caller must not render it as one: a period whose
 * first request has not left yet has no row, and "zero consumed, the whole
 * allowance remaining" is the true answer for it.
 */
export async function allowanceUsageFor(
  database: HistoryDatabase,
  sourceId: string,
  periodStart: Date,
): Promise<AllowanceUsageReading | null> {
  const rows = await database
    .select({
      consumed: governorAllowanceUsage.consumed,
      warnedAt: governorAllowanceUsage.warnedAt,
      stoppedAt: governorAllowanceUsage.stoppedAt,
    })
    .from(governorAllowanceUsage)
    .where(
      and(
        eq(governorAllowanceUsage.sourceId, sourceId),
        eq(governorAllowanceUsage.periodStart, periodStart),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export type SourceStopReading = {
  sourceId: string;
  periodStart: Date;
  stoppedAt: Date;
  reason: string;
  notifiedAt: Date | null;
};

/** Every stop this source has ever been given by its vendor, newest first. */
export async function sourceStopHistory(
  database: HistoryDatabase,
  sourceId: string,
  limit: number,
): Promise<SourceStopReading[]> {
  return await database
    .select()
    .from(sourcePeriodStops)
    .where(eq(sourcePeriodStops.sourceId, sourceId))
    .orderBy(desc(sourcePeriodStops.periodStart))
    .limit(limit);
}

/** The stop in force for this source's current period, or null. */
export async function currentSourceStop(
  database: HistoryDatabase,
  sourceId: string,
  periodStart: Date,
): Promise<SourceStopReading | null> {
  const rows = await database
    .select()
    .from(sourcePeriodStops)
    .where(
      and(
        eq(sourcePeriodStops.sourceId, sourceId),
        eq(sourcePeriodStops.periodStart, periodStart),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The watchlist, and one listing's observations                               */
/* -------------------------------------------------------------------------- */

export type TrackedListing = {
  sourceId: string;
  listingId: string;
  enabled: boolean;
  note: string | null;
};

/**
 * Every listing on the watchlist, enabled or not, in a stable order.
 *
 * A DISABLED entry is still tracked: the owner switched collection off and kept
 * the history, which is the ordinary thing an owner does, and refusing to show
 * that listing's chart would hide the very history they kept.
 */
export async function trackedListings(
  database: HistoryDatabase,
): Promise<TrackedListing[]> {
  return await database
    .select({
      sourceId: watchlistEntries.sourceId,
      listingId: watchlistEntries.listingId,
      enabled: watchlistEntries.enabled,
      note: watchlistEntries.note,
    })
    .from(watchlistEntries)
    .orderBy(asc(watchlistEntries.sourceId), asc(watchlistEntries.listingId));
}

/** Is this listing on a watchlist entry at all? The entry, or null. */
export async function trackedListing(
  database: HistoryDatabase,
  sourceId: string,
  listingId: string,
): Promise<TrackedListing | null> {
  const rows = await database
    .select({
      sourceId: watchlistEntries.sourceId,
      listingId: watchlistEntries.listingId,
      enabled: watchlistEntries.enabled,
      note: watchlistEntries.note,
    })
    .from(watchlistEntries)
    .where(
      and(
        eq(watchlistEntries.sourceId, sourceId),
        eq(watchlistEntries.listingId, listingId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** One stored observation, as a time series wants it. */
export type ObservedPrice = {
  amountMinorUnits: bigint;
  currency: string;
  observedAt: Date;
  vendorPriceUpdatedAt: Date | null;
};

/**
 * One listing's stored observations inside `[from, to]`, oldest first.
 *
 * Bounds INCLUSIVE at both ends here, unlike the outcome counts, and the
 * difference is deliberate rather than an oversight: a chart's range is the
 * range a human picked off a page and they expect the endpoints they named to be
 * in it, while a rate's period has to partition so two adjacent periods do not
 * double-count one request.
 *
 * ORDERED BY THE OBSERVATION INSTANT, which is what makes it a time series
 * rather than a scatter of rows in insertion order. The tie-break on id keeps
 * two observations recorded at the identical instant in a stable order.
 */
export async function observedPrices(
  database: HistoryDatabase,
  sourceId: string,
  listingId: string,
  from: Date,
  to: Date,
): Promise<ObservedPrice[]> {
  return await database
    .select({
      amountMinorUnits: priceObservations.amountMinorUnits,
      currency: priceObservations.currency,
      observedAt: priceObservations.observedAt,
      vendorPriceUpdatedAt: priceObservations.vendorPriceUpdatedAt,
    })
    .from(priceObservations)
    .where(
      and(
        eq(priceObservations.sourceId, sourceId),
        eq(priceObservations.listingId, listingId),
        gte(priceObservations.observedAt, from),
        sql`${priceObservations.observedAt} <= ${to}`,
      ),
    )
    .orderBy(asc(priceObservations.observedAt), asc(priceObservations.id));
}
