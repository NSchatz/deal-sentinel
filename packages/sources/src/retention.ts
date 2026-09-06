/**
 * The raw-content retention policy, and the job that enforces it.
 *
 * THE POLICY is one number per source - how long that source's terms permit its
 * content to be held - and it has exactly one home: the source registry, which
 * refuses to run a source whose terms declare a ceiling and whose configuration
 * declares none. It is stamped onto every row at write time, so a row is aged
 * by the terms that applied when it was stored and not by whatever the
 * configuration says today.
 *
 * THE JOB is `sweepRetention`, and it takes NO OPERATOR ACTION because it is
 * not a thing an operator runs. `runCollection` calls it at the end of every
 * collection run, so retention is enforced by the same recurring work that
 * created the content. That is deliberate and it is the whole reason there is
 * no timer here: a scheduled job is a second process that can be down while the
 * first one keeps writing, and the failure mode of "the collector is running
 * and the sweeper is not" is content held past a ceiling somebody promised a
 * third party. Tying them together makes that state unreachable - a run that
 * stores content is a run that ages it.
 *
 * WHAT SURVIVES. The observation. Price, currency, the observation instant, the
 * vendor's price-update instant, the source and the listing are this system's
 * own derived record, not cached vendor Content, and BRIEF.md wants history
 * indefinitely. Only the raw content goes.
 */

import { sweepExpiredRawContent } from "@deal-sentinel/db";
import type { HistoryDatabase, RetentionSweep } from "@deal-sentinel/db";
import type { Clock } from "@deal-sentinel/governor";

import type { SourceRegistry } from "./registry.ts";

export type { RetentionSweep };

/**
 * How long this source's raw content may be held, in hours, or null where its
 * terms declare no ceiling and its configuration set none.
 */
export function retentionHoursFor(
  registry: SourceRegistry,
  sourceId: string,
): number | null {
  return registry.require(sourceId).rawContextRetentionHours;
}

/**
 * Delete every stored raw content whose ceiling has passed, and report what
 * went. Idempotent, single statement, and safe to call on every run.
 */
export async function sweepRetention(
  database: HistoryDatabase,
  clock: Clock,
): Promise<RetentionSweep> {
  return await sweepExpiredRawContent(database, new Date(clock.now()));
}

/**
 * Every source that declares a ceiling, and the ceiling. For a start-up report
 * that says what this system has promised each third party.
 */
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
