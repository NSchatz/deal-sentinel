/**
 * Ageing out stored raw content, and nothing else.
 *
 * The sanctioned API's terms permit this system to "store or cache any Content
 * except on a temporary basis not to exceed seventy-two (72) hours", so the
 * cached vendor Content this repository holds - `price_observations.raw_context`
 * - has a per-source ceiling and has to go once that ceiling passes, with no
 * operator action. What must NOT go is the observation: the price, the currency,
 * both instants, the source and the listing are this system's own derived
 * record and are kept indefinitely (BRIEF.md wants history indefinitely). So
 * this is an UPDATE that nulls one column, never a DELETE of a row.
 *
 * WHOSE CEILING. The ceiling is a per-source declaration, and it is materialised
 * onto each row as `raw_context_retention_hours` when the observation is
 * written, exactly as `schema.ts` says it would be. Reading it off the row and
 * not out of today's configuration is deliberate: a row was stored under the
 * terms that applied when it was stored, and a configuration edit must not be
 * able to retroactively grant a longer life to content already held. It also
 * makes "a source that declares no ceiling is not touched" a property of the
 * WHERE clause - a NULL ceiling matches nothing - rather than of a branch
 * somebody has to remember to write.
 *
 * WHEN THE CLOCK STARTS. At `observed_at`: the raw content entered this process
 * when the observation was made, so that instant is when the vendor's clause
 * starts counting. It is also the only instant on the row that is always
 * present.
 */

import { and, isNotNull, lt, sql } from "drizzle-orm";

import type { HistoryDatabase } from "./connection.ts";
import { priceObservations } from "./schema.ts";

export type RetentionSweep = {
  /** The instant the sweep was run for, on the caller's clock. */
  at: Date;
  /** How many rows had their raw content deleted by THIS sweep. */
  deleted: number;
  /** The listings those rows belong to, for a run report. */
  listings: { sourceId: string; listingId: string }[];
};

/**
 * Delete every stored raw content whose source's declared ceiling has passed.
 *
 * IDEMPOTENT: a row whose content is already gone is excluded by
 * `raw_context is not null`, so a second sweep in the same second reports zero
 * rather than counting the same row twice. Runs as ONE statement, so a sweep
 * cannot half-apply.
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
        // A source that declares no retention ceiling: NULL matches nothing
        // here, so its content is retained and is never deleted.
        isNotNull(priceObservations.rawContextRetentionHours),
        // Still holding content. Without this the sweep would "delete" rows it
        // had already emptied, and the count would stop meaning anything.
        isNotNull(priceObservations.rawContext),
        // observed_at + ceiling < now. The arithmetic is done by PostgreSQL in
        // one expression over the row's OWN ceiling; there is no per-row round
        // trip and no value this process read first.
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
