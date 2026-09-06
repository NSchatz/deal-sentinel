/**
 * The read model: every question the page answers, decided here, once.
 *
 * Separated from the rendering on purpose. What counts as BROKEN, what a source
 * with no records in a period is allowed to be called, and whether two
 * observations in different currencies are one series are all decisions, and a
 * decision taken inside a template is a decision nobody can test without a
 * browser. The browser-driven graders assert what is SHOWN; these functions are
 * what decides what there is to show.
 *
 * THREE VERDICTS AND THE ORDER BETWEEN THEM, because the phase's fail-safe turns
 * on it - "a source with no recent successful fetch reads as broken, not quiet":
 *
 *   1. BROKEN wins. No successful fetch ever, or the most recent one is older
 *      than the configured staleness horizon. Asked over ALL of history and not
 *      over the period on screen, because otherwise narrowing the window would
 *      be a way to make a dead source look broken for a reason it is not, or a
 *      working one look broken for no reason at all.
 *   2. NO DATA next. Not one record inside the period being shown. This is NOT
 *      a zero error rate and NOT a zero block rate and NOT healthy: a source
 *      that was never asked anything has no rate, and printing 0% would be this
 *      system inventing evidence of its own good behaviour.
 *   3. HEALTHY last, and only then. It is the residue of two refusals, which is
 *      the direction that cannot flatter.
 *
 * AND THREE STATES THAT ARE NEVER THE SAME STATE, carried separately all the way
 * to the screen: the breaker pause (this system's verdict about a source), the
 * allowance (this system's own budget) and the vendor stop (the vendor's verdict
 * about us). An operator does something different about each one.
 */

import { periodStartFor } from "@deal-sentinel/governor";
import type { GovernorConfig } from "@deal-sentinel/governor";
import {
  allowanceUsageFor,
  breakerPauseHistory,
  countFetchOutcomes,
  currentBreakerPause,
  currentSourceStop,
  lastSuccessInstants,
  observedPrices,
  recentConditions,
  sourceStopHistory,
  trackedListing,
  trackedListings,
} from "@deal-sentinel/db";
import type {
  BreakerPauseReading,
  HistoryDatabase,
  ObservedPrice,
  RecentFetchOutcome,
  SourceStopReading,
  TrackedListing,
} from "@deal-sentinel/db";
import { UnattributedEmissionError, assertAttributed, attributedItem } from "@deal-sentinel/sources";
import type { SourceRegistry } from "@deal-sentinel/sources";

import type { DashboardConfig } from "./config.ts";

/* -------------------------------------------------------------------------- */
/* Per-source health                                                           */
/* -------------------------------------------------------------------------- */

export type HealthVerdict = "broken" | "no-data" | "healthy";

export type OutcomeCounts = {
  success: number;
  error: number;
  blocked: number;
  refused: number;
  total: number;
};

/**
 * The rates, and the counts they were computed from, side by side.
 *
 * The counts travel WITH the rates because a rate with no denominator is not
 * evidence: "50% blocked" is an emergency out of forty requests and a shrug out
 * of two, and an operator deciding whether a politeness ceiling is right needs
 * to know which one they are looking at.
 *
 * THE DENOMINATOR IS WHAT LEFT THIS PROCESS, and it is carried here rather than
 * left to be inferred. `refused` means the governor declined to send: nothing
 * went to the far side, so the far side neither succeeded, failed nor blocked
 * it, and counting it under the line makes every rate smaller the more careful
 * this system is. A source with a hundred refusals and one block reads as "1.0%
 * blocked" over the total and as "100% blocked" over what was actually sent, and
 * the second number is the one the phase exists to produce: the roadmap places
 * it before the first scraped breadth because "block rate is what says whether
 * the politeness ceilings are right". A ceiling is tuned against the requests it
 * let through.
 *
 * Every raw count stays on the page beside this, refusals included, so the
 * denominator is legible and the other reading is still available to anybody who
 * wants it.
 */
export type OutcomeRates = {
  success: number;
  error: number;
  blocked: number;
  /**
   * The records in the period that LEFT this process: success + error +
   * blocked. Every rate above is over this and over nothing else.
   */
  attempted: number;
};

export type AllowanceView =
  | {
      /** Configured with no allowance. Never "zero remaining", never "at limit". */
      metered: false;
    }
  | {
      metered: true;
      limit: number;
      consumed: number;
      /** limit - consumed, and consumed + remaining is the limit by construction. */
      remaining: number;
      periodStart: Date;
      periodMs: number;
      /** True only when the whole allowance for this period has been spent. */
      atLimit: boolean;
      /** When this system marked the period stopped, or null. Its OWN budget. */
      stoppedAt: Date | null;
      warnedAt: Date | null;
    };

export type SourceHealth = {
  sourceId: string;
  verdict: HealthVerdict;
  /** Why, in words, for the page to show beside the verdict. */
  verdictDetail: string;
  /** The most recent successful fetch, over all of history, or null. */
  lastSuccessAt: Date | null;
  /** Null when there is not one record inside the period. */
  counts: OutcomeCounts | null;
  /** Null for exactly the same reason, and never a set of zeros. */
  rates: OutcomeRates | null;
  allowance: AllowanceView;
  /** THIS system pausing a source it judges failing. Null when it is not. */
  breakerPause: BreakerPauseReading | null;
  breakerPauseHistory: BreakerPauseReading[];
  /** THE VENDOR refusing us for a period. Null when it has not. */
  vendorStop: SourceStopReading | null;
  vendorStopHistory: SourceStopReading[];
  /** The most recent recorded conditions, newest first. */
  conditions: RecentFetchOutcome[];
};

export type Overview = {
  now: Date;
  period: { from: Date; to: Date };
  stalenessHorizonMs: number;
  sources: SourceHealth[];
  listings: TrackedListing[];
};

export type OverviewDependencies = {
  database: HistoryDatabase;
  governor: GovernorConfig;
  config: DashboardConfig;
  now: Date;
};

/** Everything the overview page shows, read in one pass. Writes nothing. */
export async function buildOverview(
  dependencies: OverviewDependencies,
): Promise<Overview> {
  const { database, governor, config, now } = dependencies;
  const from = new Date(now.getTime() - config.ratePeriodMs);

  const counted = await countFetchOutcomes(database, from, now);
  const lastSuccess = await lastSuccessInstants(database);

  const bySource = new Map<string, OutcomeCounts>();
  for (const row of counted) {
    const held = bySource.get(row.sourceId) ?? emptyCounts();
    held[row.outcomeClass] += row.count;
    held.total += row.count;
    bySource.set(row.sourceId, held);
  }

  // Every CONFIGURED source, and every source that has a record even if it is
  // no longer configured. A source somebody removed from the configuration
  // yesterday still has yesterday's block rate, and hiding it would hide the
  // reason it was removed.
  const sourceIds = [
    ...new Set([...Object.keys(governor.sources), ...bySource.keys()]),
  ].sort();

  const sources: SourceHealth[] = [];
  for (const sourceId of sourceIds) {
    sources.push(
      await buildSourceHealth({
        database,
        governor,
        config,
        now,
        from,
        sourceId,
        counts: bySource.get(sourceId) ?? null,
        lastSuccessAt: lastSuccess.get(sourceId) ?? null,
      }),
    );
  }

  return {
    now,
    period: { from, to: now },
    stalenessHorizonMs: config.stalenessHorizonMs,
    sources,
    listings: await trackedListings(database),
  };
}

async function buildSourceHealth(input: {
  database: HistoryDatabase;
  governor: GovernorConfig;
  config: DashboardConfig;
  now: Date;
  from: Date;
  sourceId: string;
  counts: OutcomeCounts | null;
  lastSuccessAt: Date | null;
}): Promise<SourceHealth> {
  const { database, governor, config, now, sourceId, counts, lastSuccessAt } = input;
  const limit = config.conditionHistoryLimit;

  const allowance = await readAllowance(database, governor, sourceId, now);
  // The period a vendor stop is keyed by is the same period the allowance is
  // keyed by where the source is metered, and the breaker's own pause interval
  // where it is not - the rule `stopPeriodsFromGovernorConfig` already states.
  const stopPeriodStart = periodStartFor(
    now.getTime(),
    stopPeriodMs(governor, sourceId),
  );

  const verdict = decideVerdict(counts, lastSuccessAt, now, config.stalenessHorizonMs);

  return {
    sourceId,
    verdict: verdict.verdict,
    verdictDetail: verdict.detail,
    lastSuccessAt,
    counts,
    rates: counts === null ? null : ratesFrom(counts),
    allowance,
    breakerPause: await currentBreakerPause(database, sourceId, now),
    breakerPauseHistory: await breakerPauseHistory(database, sourceId, limit),
    vendorStop: await currentSourceStop(database, sourceId, stopPeriodStart),
    vendorStopHistory: await sourceStopHistory(database, sourceId, limit),
    conditions: await recentConditions(database, sourceId, limit),
  };
}

/**
 * The verdict, and the sentence that goes with it.
 *
 * Written as three returns in the order the header states, so that the
 * precedence is the shape of the function and not a comment about it.
 */
export function decideVerdict(
  counts: OutcomeCounts | null,
  lastSuccessAt: Date | null,
  now: Date,
  stalenessHorizonMs: number,
): { verdict: HealthVerdict; detail: string } {
  if (lastSuccessAt === null) {
    return {
      verdict: "broken",
      detail:
        "this source has no successful fetch on record at all. That is BROKEN " +
        "and not idle: a source that has never worked and a source nobody has " +
        "asked anything look identical from a log, and only one of them is " +
        "fine.",
    };
  }

  const age = now.getTime() - lastSuccessAt.getTime();
  if (age > stalenessHorizonMs) {
    return {
      verdict: "broken",
      detail:
        `this source's most recent successful fetch was ${age}ms ago, past ` +
        `the configured staleness horizon of ${stalenessHorizonMs}ms. BROKEN, ` +
        "not quiet.",
    };
  }

  if (counts === null || counts.total === 0) {
    return {
      verdict: "no-data",
      detail:
        "no fetch was recorded for this source inside the period shown, so " +
        "there is no rate to report. This is not a zero error rate and not a " +
        "zero block rate: nothing was asked, so nothing was refused.",
    };
  }

  return {
    verdict: "healthy",
    detail:
      `${counts.success} of ${counts.total} recorded outcomes in this period ` +
      "succeeded, and the most recent success is inside the configured " +
      "staleness horizon.",
  };
}

/**
 * The three rates over what left this process, or null when nothing did.
 *
 * NULL AND NOT ZERO. A period in which every record is a refusal this system
 * made has no success, error or block rate to report at all: nothing reached the
 * far side, so the far side answered nothing. Reporting zeros there would say
 * "we asked and were never blocked", which is the same lie AC4 forbids for a
 * period with no records - and the counts, refusals included, are reported
 * either way, so nothing is hidden by declining to divide.
 */
export function ratesFrom(counts: OutcomeCounts): OutcomeRates | null {
  const attempted = counts.success + counts.error + counts.blocked;
  if (attempted === 0) return null;
  return {
    success: counts.success / attempted,
    error: counts.error / attempted,
    blocked: counts.blocked / attempted,
    attempted,
  };
}

function emptyCounts(): OutcomeCounts {
  return { success: 0, error: 0, blocked: 0, refused: 0, total: 0 };
}

/**
 * The allowance, read as ROWS and never through the ledger.
 *
 * `AllowanceLedger.check` announces the stop when it finds the counter at the
 * limit, which claims `stopped_at` and emits the period's one notification. A
 * page that read the allowance through it would spend the mark it was reading
 * and notify the owner every time they opened the dashboard. So the row is read
 * and the subtraction is done here.
 */
async function readAllowance(
  database: HistoryDatabase,
  governor: GovernorConfig,
  sourceId: string,
  now: Date,
): Promise<AllowanceView> {
  const settings = governor.sources[sourceId]?.allowance;
  if (settings === undefined) return { metered: false };

  const periodStart = periodStartFor(now.getTime(), settings.periodMs);
  const usage = await allowanceUsageFor(database, sourceId, periodStart);

  // NO ROW IS NOT UNKNOWN. A period whose first request has not left yet has
  // written nothing, and "zero consumed, the whole allowance remaining" is the
  // true and complete answer for it.
  const consumed = usage?.consumed ?? 0;

  return {
    metered: true,
    limit: settings.limit,
    consumed,
    remaining: settings.limit - consumed,
    periodStart,
    periodMs: settings.periodMs,
    atLimit: consumed >= settings.limit,
    stoppedAt: usage?.stoppedAt ?? null,
    warnedAt: usage?.warnedAt ?? null,
  };
}

/** The same rule `stopPeriodsFromGovernorConfig` states, read-only. */
function stopPeriodMs(governor: GovernorConfig, sourceId: string): number {
  const settings = governor.sources[sourceId];
  if (settings?.allowance !== undefined) return settings.allowance.periodMs;
  return settings?.breaker?.pauseMs ?? governor.breaker.pauseMs;
}

/* -------------------------------------------------------------------------- */
/* One listing's price history                                                 */
/* -------------------------------------------------------------------------- */

export type ListingRange = { from: Date; to: Date };

export type ListingView =
  /** No watchlist entry names this listing. Nothing about it is shown. */
  | { kind: "not-tracked"; sourceId: string; listingId: string }
  /** Tracked, and this system holds no observation for it in this range. */
  | {
      kind: "empty";
      sourceId: string;
      listingId: string;
      range: ListingRange;
      entry: TrackedListing;
    }
  /**
   * Tracked, observed, and this system may not show the values: the source's
   * terms require an attribution this build cannot establish. REFUSED rather
   * than shown unattributed, and rather than repaired here.
   */
  | {
      kind: "unattributed";
      sourceId: string;
      listingId: string;
      range: ListingRange;
      entry: TrackedListing;
      reason: string;
    }
  /** Tracked, observed, and the observations are not one comparable series. */
  | {
      kind: "mixed-currency";
      sourceId: string;
      listingId: string;
      range: ListingRange;
      entry: TrackedListing;
      currencies: string[];
      attribution: string | null;
    }
  /** Tracked, observed, one currency: a time series. */
  | {
      kind: "series";
      sourceId: string;
      listingId: string;
      range: ListingRange;
      entry: TrackedListing;
      currency: string;
      points: ObservedPrice[];
      attribution: string | null;
    };

export type ListingViewDependencies = {
  database: HistoryDatabase;
  registry: SourceRegistry;
  sourceId: string;
  listingId: string;
  range: ListingRange;
};

/**
 * One listing, answered in the order the criteria are written in.
 *
 * NOT TRACKED comes first, and it is answered from the WATCHLIST rather than
 * from the presence of observations: a listing whose entry was removed still has
 * rows, and answering "here is its history" would be showing a chart for
 * something this system is not watching.
 *
 * ATTRIBUTION comes before anything derived from the observations is described,
 * including the currencies. Whatever the terms cover, they cover it at the point
 * it is shown, and the check is `assertAttributed` - the module that already
 * REFUSES an emission which lost its notice rather than filling one in - not a
 * notice composed beside it. A check that repairs what it finds is ceremonial.
 */
export async function buildListingView(
  dependencies: ListingViewDependencies,
): Promise<ListingView> {
  const { database, registry, sourceId, listingId, range } = dependencies;

  const entry = await trackedListing(database, sourceId, listingId);
  if (entry === null) {
    return { kind: "not-tracked", sourceId, listingId };
  }

  const points = await observedPrices(
    database,
    sourceId,
    listingId,
    range.from,
    range.to,
  );

  if (points.length === 0) {
    return { kind: "empty", sourceId, listingId, range, entry };
  }

  let attribution: string | null;
  try {
    attribution = attributionFor(registry, sourceId, listingId, points[0]);
  } catch (error) {
    return {
      kind: "unattributed",
      sourceId,
      listingId,
      range,
      entry,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const currencies = [...new Set(points.map((point) => point.currency))].sort();
  if (currencies.length > 1) {
    return {
      kind: "mixed-currency",
      sourceId,
      listingId,
      range,
      entry,
      currencies,
      attribution,
    };
  }

  return {
    kind: "series",
    sourceId,
    listingId,
    range,
    entry,
    currency: currencies[0],
    points,
    attribution,
  };
}

/**
 * The notice this source's terms require, or a throw.
 *
 * Built through `attributedItem` and checked through `assertAttributed`, which
 * is the supported route and the one that refuses. A source the registry does
 * not carry raises here too, and that is right: this build cannot say whether
 * that source's terms require attribution, and "we could not tell" is not a
 * licence to show the price anyway.
 */
function attributionFor(
  registry: SourceRegistry,
  sourceId: string,
  listingId: string,
  point: ObservedPrice,
): string | null {
  try {
    const item = attributedItem(registry, {
      sourceId,
      listingId,
      amountMinorUnits: point.amountMinorUnits,
      currency: point.currency,
      observedAt: point.observedAt,
      vendorPriceUpdatedAt: point.vendorPriceUpdatedAt,
    });
    return assertAttributed(registry, item);
  } catch (error) {
    if (error instanceof UnattributedEmissionError) throw error;
    throw new UnattributedEmissionError(
      sourceId,
      sourceId,
      `refusing to show any observed value for ${listingId} from ${sourceId}: ` +
        "this build cannot establish what that source's terms require, so it " +
        `cannot attribute the value. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
