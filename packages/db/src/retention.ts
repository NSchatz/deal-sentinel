/**
 * Ageing out stored raw content, and nothing else.
 *
 * The sanctioned API's terms permit storing Content "on a temporary basis not
 * to exceed seventy-two (72) hours", so cached vendor Content has a per-source
 * ceiling and has to go once that ceiling passes, with no operator action. What
 * must NOT go is the observation - price, currency, both instants, source and
 * listing are this system's own derived record and are kept indefinitely - so
 * this is an UPDATE that nulls one column, never a DELETE of a row.
 *
 * The ceiling is read off the ROW, where it was materialised when the
 * observation was written, and not out of today's configuration: a row was
 * stored under the terms that applied then, and a configuration edit must not
 * retroactively grant content already held a longer life. The clock starts at
 * `observed_at`, when the content entered this process.
 */

import { and, isNotNull, lt, sql } from "drizzle-orm";

import type { HistoryDatabase } from "./connection.ts";
import { priceObservations } from "./schema.ts";

export type RetentionSweep = {
  at: Date;
  /** How many rows had their raw content deleted by THIS sweep. */
  deleted: number;
  listings: { sourceId: string; listingId: string }[];
};

/**
 * IDEMPOTENT: a row whose content is already gone is excluded by
 * `raw_context is not null`, so a second sweep in the same second reports zero.
 * One statement, so a sweep cannot half-apply.
 */
export async function sweepExpiredRawContent(
  database: HistoryDatabase,
  at: Date,
): Promise<RetentionSweep> {
  const rows = await database
    .update(priceObservations)
    .set({ rawContext: null })
    .where(
      and(
        // A source that declares no ceiling: NULL matches nothing here, so its
        // content is retained rather than deleted by a forgotten branch.
        isNotNull(priceObservations.rawContextRetentionHours),
        // Still holding content, or the count would stop meaning anything.
        isNotNull(priceObservations.rawContext),
        // observed_at + ceiling < now, done by PostgreSQL over the row's OWN
        // ceiling: no per-row round trip, no value this process read first.
        lt(
          sql`${priceObservations.observedAt} + make_interval(hours => ${priceObservations.rawContextRetentionHours})`,
          at,
        ),
      ),
    )
    .returning({
      sourceId: priceObservations.sourceId,
      listingId: priceObservations.listingId,
    });

  return { at, deleted: rows.length, listings: rows };
}
