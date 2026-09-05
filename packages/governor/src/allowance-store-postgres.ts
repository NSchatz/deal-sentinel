/**
 * The durable allowance store.
 *
 * Spec ruling R5: the counter has to survive a restart, so it is stored rather
 * than held in memory, and the store this repository already has is the history
 * database. `governor_allowance_usage` is keyed by (source, period start), so
 * the new period is a new row and no reset job has to exist.
 *
 * EVERY MUTATION HERE IS A SINGLE STATEMENT, and none of them is a read this
 * module then acts on. That is not a stylistic preference; it is the whole
 * correctness argument of this file, and it is what the process boundary in
 * `governor.ts` relies on:
 *
 *   - `reserve` is an upsert whose UPDATE carries its own WHERE. PostgreSQL
 *     evaluates that WHERE against the LATEST committed version of the
 *     conflicting row, under the row lock the upsert takes, so two sessions
 *     racing on one (source, period) cannot both find room for the last unit.
 *     No row comes back when the condition fails, and no row back is the refusal;
 *   - `release` is a bare arithmetic UPDATE, so giving a unit back cannot lose
 *     another session's addition the way `set consumed = <a number I read>`
 *     would. The table's `consumed >= 0` check constraint is the backstop;
 *   - the two marks are conditional updates that report whether THEY were the
 *     transition, which is what makes "notify exactly once" hold when two
 *     workers race inside one period: the database decides, not a flag in one
 *     process.
 *
 * A read-then-write anywhere in this file would be worse than the same shape in
 * memory rather than equivalent to it: the gap between the read and the write is
 * a network round trip rather than a microtask, so it is wide enough for many
 * concurrent requests to fit inside.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { governorAllowanceUsage } from "@deal-sentinel/db";
import type { HistoryDatabase } from "@deal-sentinel/db";

import type { AllowanceRecord, AllowanceStore } from "./allowance.ts";

export function createPostgresAllowanceStore(
  database: HistoryDatabase,
): AllowanceStore {
  const empty = (): AllowanceRecord => ({
    consumed: 0,
    warnedAt: null,
    stoppedAt: null,
  });

  const readRecord = async (
    sourceId: string,
    periodStart: Date,
  ): Promise<AllowanceRecord> => {
    const rows = await database
      .select()
      .from(governorAllowanceUsage)
      .where(
        and(
          eq(governorAllowanceUsage.sourceId, sourceId),
          eq(governorAllowanceUsage.periodStart, periodStart),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return empty();
    return {
      consumed: row.consumed,
      warnedAt: row.warnedAt,
      stoppedAt: row.stoppedAt,
    };
  };

  return {
    read: readRecord,

    async reserve(sourceId, periodStart, amount, limit) {
      // `limit` is validated at load time as an integer of at least 1
      // (`config.ts`), and `amount` is 1, so the INSERT branch - taken only when
      // no row exists for this period, meaning consumption is zero - can never
      // land above the limit on its own.
      const granted = await database
        .insert(governorAllowanceUsage)
        .values({ sourceId, periodStart, consumed: amount })
        .onConflictDoUpdate({
          target: [governorAllowanceUsage.sourceId, governorAllowanceUsage.periodStart],
          set: {
            consumed: sql`${governorAllowanceUsage.consumed} + ${amount}`,
          },
          // The test lives INSIDE the statement that does the adding. Two
          // sessions offering the last unit at once are serialised by the row
          // lock this upsert takes, and the second one re-evaluates this
          // condition against the first one's committed row, so it finds no
          // room and comes back empty-handed.
          setWhere: sql`${governorAllowanceUsage.consumed} + ${amount} <= ${limit}`,
        })
        .returning({ consumed: governorAllowanceUsage.consumed });

      const row = granted[0];
      if (row !== undefined) return { granted: true, consumed: row.consumed };

      // Refused: the statement above added nothing. The total is read only to
      // say so in words. A concurrent addition could make this number a moment
      // out of date, and that is harmless HERE and only here - the refusal was
      // already decided by the statement, and consumption inside a period never
      // falls except by a `release` for a request that did not leave.
      const current = await readRecord(sourceId, periodStart);
      return { granted: false, consumed: current.consumed };
    },

    async release(sourceId, periodStart, amount) {
      await database
        .update(governorAllowanceUsage)
        .set({ consumed: sql`${governorAllowanceUsage.consumed} - ${amount}` })
        .where(
          and(
            eq(governorAllowanceUsage.sourceId, sourceId),
            eq(governorAllowanceUsage.periodStart, periodStart),
            // Arithmetic, not a value this process read: whatever else has
            // happened to the row, exactly this reservation is given back. The
            // guard keeps a release with no reservation behind it from tripping
            // the table's non-negative check constraint.
            sql`${governorAllowanceUsage.consumed} >= ${amount}`,
          ),
        );
    },

    async markWarned(sourceId, periodStart, at) {
      const rows = await database
        .update(governorAllowanceUsage)
        .set({ warnedAt: at })
        .where(
          and(
            eq(governorAllowanceUsage.sourceId, sourceId),
            eq(governorAllowanceUsage.periodStart, periodStart),
            isNull(governorAllowanceUsage.warnedAt),
          ),
        )
        .returning({ sourceId: governorAllowanceUsage.sourceId });
      return rows.length === 1;
    },

    async markStopped(sourceId, periodStart, at) {
      // The row may not exist yet: a source can be found already stopped by a
      // process that has counted nothing this period. Try to create it carrying
      // the mark, and fall back to the same conditional update `markWarned`
      // uses. Both statements are decided by the database, so two racing
      // workers still emit one notification between them.
      const inserted = await database
        .insert(governorAllowanceUsage)
        .values({ sourceId, periodStart, consumed: 0, stoppedAt: at })
        .onConflictDoNothing({
          target: [governorAllowanceUsage.sourceId, governorAllowanceUsage.periodStart],
        })
        .returning({ sourceId: governorAllowanceUsage.sourceId });
      if (inserted.length === 1) return true;

      const updated = await database
        .update(governorAllowanceUsage)
        .set({ stoppedAt: at })
        .where(
          and(
            eq(governorAllowanceUsage.sourceId, sourceId),
            eq(governorAllowanceUsage.periodStart, periodStart),
            isNull(governorAllowanceUsage.stoppedAt),
          ),
        )
        .returning({ sourceId: governorAllowanceUsage.sourceId });
      return updated.length === 1;
    },
  };
}
