/**
 * The collection run: the watchlist, once, per source.
 *
 * The run reads the WATCHLIST and nothing else to decide what to fetch. There
 * is no other input, no "and also this listing", no fallback list, so "attempts
 * no listing that is absent from the watchlist or disabled on it" is a property
 * of where the loop gets its entries rather than of care at a call site. Every
 * attempt is a request that leaves the household's address under a credential
 * and spends a metered allowance, so the set of them is worth being a fact
 * about the code.
 *
 * FOUR THINGS THE RUN REFUSES TO DO, and each one is an unhappy path that costs
 * something real when it is got wrong:
 *
 *   1. RETRY. Not a governor refusal, not a source error, not a 403. The
 *      governor's refusals are conditions a wait inside one run cannot clear
 *      (three of them exist to reduce traffic and two say an answer has
 *      expired), and a retry loop against a third party is the runaway scraper
 *      this repository's card names as the thing no re-run undoes. An entry
 *      that did not resolve is attempted again on the NEXT run, which is the
 *      only retry a price watcher needs: history accrues at one observation per
 *      listing per run.
 *   2. STOP THE RUN because one entry failed. A refusal for one listing is
 *      about that listing, and the remaining entries are still owed an attempt.
 *   3. STOP EVERY SOURCE because one source stopped. A 403 from one vendor says
 *      nothing about another, and the stop is keyed by source id precisely so
 *      that it cannot spread.
 *   4. KEEP ASKING A SOURCE THAT SAID STOP. The stop is read BEFORE the
 *      watchlist, so a stopped source issues no request at all for the rest of
 *      its period - across a restart, because the stop is durable.
 *
 * AND ONE THING IT ALWAYS DOES: sweep the retention ceiling at the end. The run
 * that stores content is the run that ages it, so there is no second process
 * that can be down while content piles up past a ceiling this system promised a
 * third party.
 */

import { recordObservation, sweepExpiredRawContent } from "@deal-sentinel/db";
import type {
  HistoryDatabase,
  HistoryWriter,
  RetentionSweep,
  SourceStopStore,
  WatchlistStore,
} from "@deal-sentinel/db";
import { periodStartFor } from "@deal-sentinel/governor";
import type { Clock, GovernorConfig, Notifier, RefusalReason } from "@deal-sentinel/governor";
import type { ExtractionFailureReason } from "@deal-sentinel/shared";

import type { SourceAdapter } from "./adapter.ts";
import { PARAMETER_REDACTOR } from "./credential.ts";
import type { SourceRegistry } from "./registry.ts";

export type ObservedEntry = { listingId: string; id: bigint; amountMinorUnits: bigint };
export type FailedEntry = {
  listingId: string;
  reason: ExtractionFailureReason;
  detail: string;
};
export type RefusedEntry = { listingId: string; reason: RefusalReason; detail: string };
export type ErroredEntry = { listingId: string; status: number | null; detail: string };

export type SourceStopReport = {
  periodStart: Date;
  reason: string;
  /** True only for the run that emitted the single notification for this stop. */
  notified: boolean;
};

export type SourceRunReport = {
  sourceId: string;
  /** Listings this run actually asked the adapter about, in order. */
  attempted: string[];
  observed: ObservedEntry[];
  extractionFailures: FailedEntry[];
  refusals: RefusedEntry[];
  errors: ErroredEntry[];
  /** Set when this run stopped the source, or found it already stopped. */
  stopped: SourceStopReport | null;
  /** True when the source was already stopped before this run began. */
  skippedBecauseStopped: boolean;
};

export type CollectionRunReport = {
  startedAt: Date;
  sources: SourceRunReport[];
  /** Null only when the run was given no database to sweep. */
  retention: RetentionSweep | null;
};

export type CollectionRunDependencies = {
  adapters: readonly SourceAdapter[];
  registry: SourceRegistry;
  watchlist: WatchlistStore;
  writer: HistoryWriter;
  stops: SourceStopStore;
  notifier: Notifier;
  clock: Clock;
  /** How long a source's stop lasts. See `stopPeriodsFromGovernorConfig`. */
  stopPeriodMsFor(sourceId: string): number;
  /** Swept at the end of the run. Omitted only where there is nothing to sweep. */
  database?: HistoryDatabase;
};

export async function runCollection(
  dependencies: CollectionRunDependencies,
): Promise<CollectionRunReport> {
  const startedAt = new Date(dependencies.clock.now());
  const sources: SourceRunReport[] = [];

  for (const adapter of dependencies.adapters) {
    sources.push(await runSource(adapter, dependencies));
  }

  const retention =
    dependencies.database === undefined
      ? null
      : await sweepExpiredRawContent(
          dependencies.database,
          new Date(dependencies.clock.now()),
        );

  return { startedAt, sources, retention };
}

async function runSource(
  adapter: SourceAdapter,
  dependencies: CollectionRunDependencies,
): Promise<SourceRunReport> {
  const { registry, watchlist, writer, stops, notifier, clock } = dependencies;
  const sourceId = adapter.sourceId;
  const entry = registry.require(sourceId);

  const report: SourceRunReport = {
    sourceId,
    attempted: [],
    observed: [],
    extractionFailures: [],
    refusals: [],
    errors: [],
    stopped: null,
    skippedBecauseStopped: false,
  };

  const periodStart = periodStartFor(
    clock.now(),
    dependencies.stopPeriodMsFor(sourceId),
  );

  // Asked BEFORE the watchlist is read, so that a stopped source costs nothing
  // and - the part that matters - issues nothing. Durable, so a restart inside
  // the period is not how a stopped source starts asking again.
  const held = await stops.read(sourceId, periodStart);
  if (held !== null) {
    report.skippedBecauseStopped = true;
    report.stopped = {
      periodStart: held.periodStart,
      reason: held.reason,
      notified: false,
    };
    return report;
  }

  const listings = await watchlist.enabledFor(sourceId);
  if (listings.length === 0) {
    // Nothing enabled is a complete run, not an error. A watchlist an owner has
    // switched entirely off is a decision, and a run that reported it as a
    // failure would train them to ignore the report.
    return report;
  }

  for (const listing of listings) {
    report.attempted.push(listing.listingId);
    const outcome = await adapter.observe(listing.listingId);

    if (outcome.kind === "limit-exceeded") {
      report.stopped = await stopSource(
        sourceId,
        periodStart,
        outcome.detail,
        stops,
        notifier,
        clock,
      );
      // No retry, and no further entry for THIS source. The loop over sources
      // carries on: every other source keeps running.
      break;
    }

    if (outcome.kind === "governor-refused") {
      report.refusals.push({
        listingId: outcome.listingId,
        reason: outcome.reason,
        detail: PARAMETER_REDACTOR.scrub(outcome.detail),
      });
      continue;
    }

    if (outcome.kind === "extraction-failed") {
      report.extractionFailures.push({
        listingId: outcome.listingId,
        reason: outcome.reason,
        detail: PARAMETER_REDACTOR.scrub(outcome.detail),
      });
      continue;
    }

    if (outcome.kind === "source-error") {
      report.errors.push({
        listingId: outcome.listingId,
        status: outcome.status,
        detail: PARAMETER_REDACTOR.scrub(outcome.detail),
      });
      continue;
    }

    const write = await recordObservation(
      writer,
      {
        ok: true,
        amountMinorUnits: outcome.draft.amountMinorUnits,
        currency: outcome.draft.currency,
        availability: outcome.draft.availability,
      },
      {
        sourceId,
        listingId: outcome.listingId,
        // `storeId` is DELIBERATELY not passed. It is reserved for the
        // store-scoped dimension HARD-8 adds, the write path throws on a
        // non-null value, and the row is attributed by `listingId` - the same
        // per-listing key the watchlist entry carries.
        observedAt: new Date(clock.now()),
        sourceTimeZone: entry.timeZone,
        vendorPriceUpdatedAt: outcome.draft.vendorPriceUpdatedAt,
        // The source's own ceiling, stamped onto the row, so the retention
        // sweep ages this content by the terms that applied when it was stored.
        rawContextRetentionHours: entry.rawContextRetentionHours,
        rawContext: outcome.draft.rawContext,
      },
    );

    if (write.written) {
      report.observed.push({
        listingId: outcome.listingId,
        id: write.id,
        amountMinorUnits: write.amountMinorUnits,
      });
    } else {
      report.extractionFailures.push({
        listingId: outcome.listingId,
        reason: write.reason,
        detail: "the write path refused this result and recorded no row.",
      });
    }
  }

  return report;
}

/**
 * Record the stop and emit the single notification it owes.
 *
 * Both decisions belong to the store: `stop` reports whether it created the
 * row, `markNotified` reports whether it set the mark. A flag held here would
 * send a second notification the moment two workers, or one worker across a
 * restart, met the same 403 - which is exactly when an owner least needs two.
 */
async function stopSource(
  sourceId: string,
  periodStart: Date,
  reason: string,
  stops: SourceStopStore,
  notifier: Notifier,
  clock: Clock,
): Promise<SourceStopReport> {
  const at = new Date(clock.now());
  await stops.stop(sourceId, periodStart, at, reason);

  const first = await stops.markNotified(sourceId, periodStart, at);
  if (first) {
    await notifier.notify({
      kind: "source-limit-exceeded",
      sourceId,
      at,
      // Already redacted by the adapter; scrubbed again here because a
      // notification body is the one place a credential would be hardest to
      // notice and impossible to recall.
      detail: PARAMETER_REDACTOR.scrub(
        `${reason} ${sourceId} is stopped until the period beginning ` +
          `${periodStart.toISOString()} ends. It will not be retried, and ` +
          "every other source keeps running.",
      ),
    });
  }

  return { periodStart, reason, notified: first };
}

/**
 * How long a source's stop lasts, taken from configuration and never invented.
 *
 * A METERED source has an allowance period, and that is "the period" the
 * criterion names: the vendor's own limit is per day, and this system's
 * allowance is aligned to it.
 *
 * An UNMETERED source has no such period, so its stop lasts its configured
 * breaker pause - the other number in this system that already means "stop
 * asking this source for a while". Both are values an operator chose in
 * `config/governor.json`; nothing here has a built-in default, for the same
 * reason the governor has none.
 */
export function stopPeriodsFromGovernorConfig(
  config: GovernorConfig,
): (sourceId: string) => number {
  return (sourceId) => {
    const settings = config.sources[sourceId];
    const allowance = settings?.allowance;
    if (allowance !== undefined) return allowance.periodMs;
    return settings?.breaker?.pauseMs ?? config.breaker.pauseMs;
  };
}
