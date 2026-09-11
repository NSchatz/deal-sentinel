/**
 * The raw-content retention policy, and the job that enforces it.
 *
 * The policy is one number per source, and its home is the source registry,
 * which refuses to run a source whose terms declare a ceiling and whose
 * configuration declares none. It is stamped onto every row at write time, so a
 * row is aged by the terms that applied when it was stored.
 *
 * `runCollection` calls the sweep at the end of every collection run, so
 * retention is enforced by the same recurring work that created the content.
 * There is deliberately no timer: a scheduled job is a second process that can
 * be down while the first keeps writing, and "the collector is running and the
 * sweeper is not" is content held past a ceiling somebody promised a third
 * party. Only the raw content goes - the observation is this system's own
 * derived record, and BRIEF.md wants history indefinitely.
 */

import { sweepExpiredRawContent } from "@deal-sentinel/db";
import type { HistoryDatabase, RetentionSweep } from "@deal-sentinel/db";
import type { Clock } from "@deal-sentinel/governor";

import type { SourceRegistry } from "./registry.ts";

export type { RetentionSweep };

/** Null where the source's terms declare no ceiling and its config set none. */
export function retentionHoursFor(
  registry: SourceRegistry,
  sourceId: string,
): number | null {
  return registry.require(sourceId).rawContextRetentionHours;
}

/** Idempotent, one statement, and safe to call at the end of every run. */
export async function sweepRetention(
  database: HistoryDatabase,
  clock: Clock,
): Promise<RetentionSweep> {
  return await sweepExpiredRawContent(database, new Date(clock.now()));
}

/** For a start-up report saying what this system promised each third party. */
export function declaredRetention(
  registry: SourceRegistry,
): { sourceId: string; retentionHours: number | null; ceilingHours: number | null }[] {
  return registry.ids().map((sourceId) => {
    const entry = registry.sources[sourceId];
    return {
      sourceId,
      retentionHours: entry.rawContextRetentionHours,
      ceilingHours: entry.terms?.rawContentCeilingHours ?? null,
    };
  });
}
