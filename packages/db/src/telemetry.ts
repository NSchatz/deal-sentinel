/**
 * The durable half of the observability the governor already knows about.
 *
 * The governor decides everything worth knowing about this system's behaviour
 * toward third parties and it tells nobody: it counts what left, it pauses a
 * failing source, it records what a vendor refused, and every one of those facts
 * dies in a process that exits. This module is where two of them stop dying -
 * the outcome of each offered fetch, and each breaker pause.
 *
 * TWO PORTS AND NOT ONE, because they are written at different moments by
 * different rules. A fetch outcome is written once per offered request, on every
 * path out of the chokepoint. A pause is written once per PAUSE, from the single
 * place a pause is announced, which is what keeps "once per pause" true. A
 * single "record everything" port would have made the second one a matter of
 * remembering.
 *
 * NEITHER WRITE MAY BE ABLE TO CHANGE WHAT THE SYSTEM DOES. That is the
 * caller's job and the governor holds it, but it is worth saying here too: this
 * repository's card names a runaway scraper as the thing no re-run undoes, and a
 * telemetry write that throws into a caller that then retries the fetch is
 * exactly that, built out of an observability feature.
 */

import { sql } from "drizzle-orm";

import type { HistoryDatabase } from "./connection.ts";
import { OpsSchemaBehindError } from "./errors.ts";
import { breakerPauses, fetchOutcomes } from "./schema.ts";
import type { FetchOutcomeClass } from "./schema.ts";

/** One offered fetch, as it is written down. */
export type FetchOutcomeEntry = {
  sourceId: string;
  outcomeClass: FetchOutcomeClass;
  /** Whole milliseconds, offered to known. Never negative. */
  latencyMs: number;
  /** The instant the outcome was known. */
  occurredAt: Date;
  /** This system's own words about why, REDACTED, or null for a plain success. */
  condition: string | null;
};

/** The narrow write port the chokepoint holds. It cannot read. */
export type FetchOutcomeStore = {
  record(entry: FetchOutcomeEntry): Promise<void>;
};

/** One breaker pause, as it is written down. */
export type BreakerPauseEntry = {
  sourceId: string;
  pausedAt: Date;
  expiresAt: Date;
  failingCount: number;
  windowOutcomes: number;
  windowMs: number;
  /** The configured threshold, as text. Shown, never computed with. */
  failureRateThreshold: string;
  condition: string;
};

/** The narrow write port the chokepoint holds for a pause. It cannot read. */
export type BreakerPauseStore = {
  record(entry: BreakerPauseEntry): Promise<void>;
};

/** Wrap a Drizzle database as the place a fetch outcome is written. */
export function drizzleFetchOutcomes(database: HistoryDatabase): FetchOutcomeStore {
  return {
    async record(entry) {
      await database.insert(fetchOutcomes).values({
        sourceId: entry.sourceId,
        outcomeClass: entry.outcomeClass,
        // Whole milliseconds, and clamped at zero: a clock that goes backwards
        // during a request is a fact about the clock, and the check constraint
        // would otherwise turn it into a failed write on the fetch path.
        latencyMs: Math.max(0, Math.round(entry.latencyMs)),
        occurredAt: entry.occurredAt,
        condition: entry.condition,
      });
    },
  };
}

/** Wrap a Drizzle database as the place a breaker pause is written. */
export function drizzleBreakerPauses(database: HistoryDatabase): BreakerPauseStore {
  return {
    async record(entry) {
      await database.insert(breakerPauses).values({
        sourceId: entry.sourceId,
        pausedAt: entry.pausedAt,
        expiresAt: entry.expiresAt,
        failingCount: entry.failingCount,
        windowOutcomes: entry.windowOutcomes,
        windowMs: entry.windowMs,
        failureRateThreshold: entry.failureRateThreshold,
        condition: entry.condition,
      });
    },
  };
}

/** The same two stores in memory, for a caller with no database. */
export function memoryFetchOutcomes(
  held: FetchOutcomeEntry[] = [],
): FetchOutcomeStore & { readonly recorded: FetchOutcomeEntry[] } {
  return {
    recorded: held,
    record(entry) {
      held.push({ ...entry });
      return Promise.resolve();
    },
  };
}

export function memoryBreakerPauses(
  held: BreakerPauseEntry[] = [],
): BreakerPauseStore & { readonly recorded: BreakerPauseEntry[] } {
  return {
    recorded: held,
    record(entry) {
      held.push({ ...entry });
      return Promise.resolve();
    },
  };
}

/**
 * The tables this spec added, by the name the database knows them under.
 *
 * Read by the schema check below rather than derived from the Drizzle objects,
 * so that a rename in `schema.ts` that nobody migrated is caught HERE, against
 * the live database, and not silently agreed with.
 */
export const OPS_TABLES = ["fetch_outcomes", "breaker_pauses"] as const;

/**
 * Refuse to read a history database that does not carry this spec's own tables.
 *
 * The alternative is the failure this exists to prevent: a dashboard pointed at
 * a database one migration behind would answer every question with "no rows",
 * and no rows renders as zero errors, zero blocks and a source that looks fine.
 * A reader cannot tell a quiet system from an absent table, so the system says
 * which it is, and says it before anything is rendered.
 */
export async function assertOpsSchema(database: HistoryDatabase): Promise<void> {
  const missing: string[] = [];
  for (const table of OPS_TABLES) {
    const present = await database.execute(
      sql`select to_regclass(${`public.${table}`}) as table_name`,
    );
    if ((present.rows[0]?.table_name ?? null) === null) missing.push(table);
  }
  if (missing.length === 0) return;

  throw new OpsSchemaBehindError(
    missing,
    "Refusing to read: this history database's schema is BEHIND this build. " +
      `It carries no ${missing.join(" and no ")}, which is where every fetch ` +
      "outcome and every breaker pause is recorded. Reporting empty telemetry, " +
      "zero rates or a healthy source off a missing table would be a lie the " +
      "owner has no way to see through. Apply the migrations " +
      "(`pnpm db:init` on a fresh volume; on a live one, run the committed " +
      "migration set against it) and read again.",
  );
}
