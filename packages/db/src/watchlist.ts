/**
 * Reading the watchlist, and the narrow port a collection run sees of it.
 *
 * A run asks exactly one question - "what is enabled for this source?" - and
 * this module is the only thing that answers it. That narrowness is the whole
 * design: a run that could reach a wider query could attempt a listing nobody
 * put on the watchlist, and every attempt is a request that leaves the
 * household's address and spends a metered allowance.
 *
 * `enabledFor` returns entries in a stable order (the surrogate key), so a run
 * over the same watchlist attempts the same listings in the same order, which
 * is what makes a run's report comparable between two runs at all.
 */

import { and, asc, eq } from "drizzle-orm";

import type { HistoryDatabase } from "./connection.ts";
import { watchlistEntries } from "./schema.ts";
import type { NewWatchlistEntryRow, WatchlistEntryRow } from "./schema.ts";

/** One listing a source observes. */
export type WatchlistEntry = {
  sourceId: string;
  listingId: string;
  enabled: boolean;
};

/** The narrow port a collection run needs. Anything wider is a temptation. */
export type WatchlistStore = {
  /** Every ENABLED entry for this source, in a stable order. */
  enabledFor(sourceId: string): Promise<WatchlistEntry[]>;
};

/**
 * One listing an evaluation run may alert about, WITH the owner's link.
 *
 * A second, wider entry type rather than a wider `WatchlistEntry`, because the
 * two readers want different things and neither should carry the other's. A
 * collection run must not see a URL: it fetches by the source's own listing key
 * through an adapter that builds its own URL, and handing it a second one would
 * be handing it somewhere else to go. An alert run must see it: a notification
 * with no link the owner can open is not sent at all.
 */
export type AlertListing = {
  sourceId: string;
  listingId: string;
  /** The owner's link, or null. Null is not a defect; it is an alert not sent. */
  listingUrl: string | null;
};

/** The narrow port an evaluation run reads its listings through. */
export type AlertListingStore = {
  /** Every ENABLED entry for this source, in a stable order. */
  enabledFor(sourceId: string): Promise<AlertListing[]>;
};

/** Wrap a Drizzle database as the watchlist a run reads. */
export function drizzleWatchlist(database: HistoryDatabase): WatchlistStore {
  return {
    async enabledFor(sourceId) {
      const rows = await database
        .select()
        .from(watchlistEntries)
        .where(
          and(
            eq(watchlistEntries.sourceId, sourceId),
            eq(watchlistEntries.enabled, true),
          ),
        )
        .orderBy(asc(watchlistEntries.id));
      return rows.map(toEntry);
    },
  };
}

/**
 * A watchlist held in memory, for a caller that has no database in hand. It
 * answers the same one question by the same rule - enabled only, insertion
 * order - so a test that uses it is testing the run and not this.
 */
export function memoryWatchlist(entries: readonly WatchlistEntry[]): WatchlistStore {
  const held = [...entries];
  return {
    enabledFor(sourceId) {
      return Promise.resolve(
        held.filter((entry) => entry.sourceId === sourceId && entry.enabled),
      );
    },
  };
}

/** Wrap a Drizzle database as the listings an evaluation run alerts about. */
export function drizzleAlertListings(database: HistoryDatabase): AlertListingStore {
  return {
    async enabledFor(sourceId) {
      const rows = await database
        .select({
          sourceId: watchlistEntries.sourceId,
          listingId: watchlistEntries.listingId,
          listingUrl: watchlistEntries.listingUrl,
        })
        .from(watchlistEntries)
        .where(
          and(
            eq(watchlistEntries.sourceId, sourceId),
            eq(watchlistEntries.enabled, true),
          ),
        )
        .orderBy(asc(watchlistEntries.id));
      return rows;
    },
  };
}

/** The same read in memory, for a caller with no database. */
export function memoryAlertListings(
  entries: readonly AlertListing[],
): AlertListingStore {
  const held = entries.map((entry) => ({ ...entry }));
  return {
    enabledFor(sourceId) {
      return Promise.resolve(held.filter((entry) => entry.sourceId === sourceId));
    },
  };
}

/**
 * Put a listing on the watchlist, or update the entry that is already there.
 *
 * Upsert on (source, listing) rather than insert: adding a listing twice is
 * something an owner does, and a second row would mean a second request per run
 * for one price, paid for out of a metered allowance.
 */
export async function addWatchlistEntry(
  database: HistoryDatabase,
  entry: NewWatchlistEntryRow,
): Promise<WatchlistEntryRow> {
  const [row] = await database
    .insert(watchlistEntries)
    .values(entry)
    .onConflictDoUpdate({
      target: [watchlistEntries.sourceId, watchlistEntries.listingId],
      set: {
        enabled: entry.enabled ?? true,
        note: entry.note ?? null,
        // The owner correcting a link is the ordinary reason to add an entry
        // twice, so the upsert has to carry it. Absent means absent: an entry
        // re-added without a link no longer has one, and the alert path then
        // refuses to send for it rather than using a link nobody restated.
        listingUrl: entry.listingUrl ?? null,
      },
    })
    .returning();
  return row;
}

/** Switch an entry on or off. Returns false when there is no such entry. */
export async function setWatchlistEntryEnabled(
  database: HistoryDatabase,
  sourceId: string,
  listingId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await database
    .update(watchlistEntries)
    .set({ enabled })
    .where(
      and(
        eq(watchlistEntries.sourceId, sourceId),
        eq(watchlistEntries.listingId, listingId),
      ),
    )
    .returning({ id: watchlistEntries.id });
  return rows.length === 1;
}

function toEntry(row: WatchlistEntryRow): WatchlistEntry {
  return {
    sourceId: row.sourceId,
    listingId: row.listingId,
    enabled: row.enabled,
  };
}
