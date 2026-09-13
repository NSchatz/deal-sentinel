/**
 * The durable record of what every governed request did, and the two reads over
 * it that an operator surface needs.
 *
 * Written from inside the one chokepoint, one row per request, with no sampling
 * and nothing aggregated at write time. An aggregate computed as the row is
 * written answers a question somebody guessed in advance; the window an owner
 * asks about a week later is not knowable now, and a request not recorded is
 * not recoverable, because nothing else in this system remembers that it
 * happened.
 *
 * WHAT THE RECORD CARRIES is three facts and an instant: which source it was
 * made for, which class of thing happened, and how long it took. What it does
 * NOT carry is the whole reason this table needs no retention policy of its
 * own: no URL (which is where this system's credential travels), no header, no
 * response body, no third party's Content. So no source's retention ceiling
 * governs a row here, and the sweep that ages raw offer markup has nothing to
 * do in this table.
 *
 * MIRRORS `source-stops.ts` deliberately: the same port shape, a Drizzle
 * implementation and an in-memory one answering by the same rules, so a caller
 * can be graded without a database and the two cannot drift on what a window
 * means.
 */

import { and, asc, count, desc, eq, gte, lt } from "drizzle-orm";

import type { RequestOutcomeClass } from "@deal-sentinel/shared";
import { REQUEST_OUTCOME_CLASSES } from "@deal-sentinel/shared";

import type { HistoryDatabase } from "./connection.ts";
import { requestOutcomes } from "./schema.ts";

/** One completed request, reduced to what may be kept about it. */
export type RequestOutcome = {
  sourceId: string;
  outcomeClass: RequestOutcomeClass;
  /** Whole milliseconds, measured on the governor's injected clock. */
  durationMs: number;
  recordedAt: Date;
};

/**
 * A half-open interval: `start <= recordedAt < end`.
 *
 * Half-open so that consecutive windows tile without overlapping and without a
 * gap, which is what lets two adjacent periods be added together. The other
 * two-ended read in this package, `ObservationHistoryStore.windowFor`, is
 * deliberately the OTHER convention (exclusive lower, inclusive upper) because
 * a rule's window ends at the observation it is evaluating; this one is a
 * reporting period and is not anchored to a row.
 */
export type OutcomeWindow = { start: Date; end: Date };

/** How many requests of each class one source made inside a window. */
export type SourceOutcomeCounts = {
  sourceId: string;
  counts: Record<RequestOutcomeClass, number>;
  /** The counts added up, so a caller does not re-derive a total from five. */
  total: number;
};

/** The counts, and the window they answer for, together. */
export type OutcomeCountsReport = {
  window: OutcomeWindow;
  sources: SourceOutcomeCounts[];
};

export type RequestOutcomeStore = {
  /** Append one row. Never an upsert: every request is its own row. */
  record(outcome: RequestOutcome): Promise<void>;
  /** Per source, the count in each class inside `window`, with the window. */
  countsIn(window: OutcomeWindow): Promise<OutcomeCountsReport>;
  /** The newest success for this source, or null when it has never had one. */
  lastSuccessAt(sourceId: string): Promise<Date | null>;
};

/** Every class at zero, so a class nobody hit is reported rather than missing. */
export function emptyCounts(): Record<RequestOutcomeClass, number> {
  const counts = {} as Record<RequestOutcomeClass, number>;
  for (const outcomeClass of REQUEST_OUTCOME_CLASSES) counts[outcomeClass] = 0;
  return counts;
}

function tally(
  rows: readonly { sourceId: string; outcomeClass: string; total: number }[],
): SourceOutcomeCounts[] {
  const bySource = new Map<string, SourceOutcomeCounts>();
  for (const row of rows) {
    let entry = bySource.get(row.sourceId);
    if (entry === undefined) {
      entry = { sourceId: row.sourceId, counts: emptyCounts(), total: 0 };
      bySource.set(row.sourceId, entry);
    }
    // A class this build does not know is still a row that happened, so it is
    // added to the total and reported nowhere else rather than dropped.
    if (isKnownClass(row.outcomeClass)) entry.counts[row.outcomeClass] += row.total;
    entry.total += row.total;
  }
  return [...bySource.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
}

function isKnownClass(value: string): value is RequestOutcomeClass {
  return (REQUEST_OUTCOME_CLASSES as readonly string[]).includes(value);
}

export function drizzleRequestOutcomes(
  database: HistoryDatabase,
): RequestOutcomeStore {
  return {
    async record(outcome) {
      await database.insert(requestOutcomes).values({
        sourceId: outcome.sourceId,
        outcomeClass: outcome.outcomeClass,
        durationMs: outcome.durationMs,
        recordedAt: outcome.recordedAt,
      });
    },

    async countsIn(window) {
      const rows = await database
        .select({
          sourceId: requestOutcomes.sourceId,
          outcomeClass: requestOutcomes.outcomeClass,
          total: count(),
        })
        .from(requestOutcomes)
        .where(
          and(
            gte(requestOutcomes.recordedAt, window.start),
            lt(requestOutcomes.recordedAt, window.end),
          ),
        )
        .groupBy(requestOutcomes.sourceId, requestOutcomes.outcomeClass)
        .orderBy(asc(requestOutcomes.sourceId));
      return { window, sources: tally(rows) };
    },

    async lastSuccessAt(sourceId) {
      const rows = await database
        .select({ recordedAt: requestOutcomes.recordedAt })
        .from(requestOutcomes)
        .where(
          and(
            eq(requestOutcomes.sourceId, sourceId),
            eq(requestOutcomes.outcomeClass, "success"),
          ),
        )
        .orderBy(desc(requestOutcomes.recordedAt))
        .limit(1);
      return rows[0]?.recordedAt ?? null;
    },
  };
}

/**
 * The same store in memory, answering by the same rules, for a caller with no
 * database. A test that uses it is testing the caller and not this.
 */
export function memoryRequestOutcomes(
  seed: readonly RequestOutcome[] = [],
): RequestOutcomeStore & { readonly rows: readonly RequestOutcome[] } {
  const rows: RequestOutcome[] = seed.map((outcome) => ({ ...outcome }));

  return {
    rows,
    record(outcome) {
      rows.push({ ...outcome });
      return Promise.resolve();
    },
    countsIn(window) {
      const inside = rows.filter(
        (row) =>
          row.recordedAt.getTime() >= window.start.getTime() &&
          row.recordedAt.getTime() < window.end.getTime(),
      );
      return Promise.resolve({
        window,
        sources: tally(
          inside.map((row) => ({
            sourceId: row.sourceId,
            outcomeClass: row.outcomeClass,
            total: 1,
          })),
        ),
      });
    },
    lastSuccessAt(sourceId) {
      const successes = rows
        .filter((row) => row.sourceId === sourceId && row.outcomeClass === "success")
        .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime());
      return Promise.resolve(successes[0]?.recordedAt ?? null);
    },
  };
}
