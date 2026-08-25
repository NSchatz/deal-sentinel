/**
 * The durable allowance store.
 *
 * Spec ruling R5: the counter has to survive a restart, so it is stored rather
 * than held in memory, and the store this repository already has is the history
 * database. `governor_allowance_usage` is keyed by (source, period start), so
 * the new period is a new row and no reset job has to exist.
 *
 * Every mutation here is a single statement, and the two marks are conditional
 * updates that report whether THEY were the transition. That is what makes
 * "notify exactly once" hold when two workers race inside one period: the
 * database decides, not a flag in one process.
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

  return {
    async read(sourceId, periodStart) {
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
    },

    async consume(sourceId, periodStart, amount) {
      const [row] = await database
        .insert(governorAllowanceUsage)
        .values({ sourceId, periodStart, consumed: amount })
        .onConflictDoUpdate({
          target: [governorAllowanceUsage.sourceId, governorAllowanceUsage.periodStart],
          set: {
            consumed: sql`${governorAllowanceUsage.consumed} + ${amount}`,
          },
        })
        .returning();
      return {
        consumed: row.consumed,
        warnedAt: row.warnedAt,
        stoppedAt: row.stoppedAt,
      };
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
