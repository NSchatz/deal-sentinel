/**
 * The price history schema.
 *
 * Three tables, and all of them are load-bearing:
 *
 *   `price_observations`       one row per listing per run, kept indefinitely.
 *                              History accrues at one observation per listing
 *                              per run and cannot be backfilled, so every
 *                              column the phase names is here now rather than
 *                              as a migration over the largest table in the
 *                              system later.
 *   `history_initialization`   the completed-initialization marker. Its
 *                              presence is what the ordinary start path checks;
 *                              its presence is also what the one-time
 *                              initialization action refuses to run past.
 *   `governor_allowance_usage` how much of a metered source's allowance the
 *                              current period has spent, and whether the one
 *                              warning and the one stop notification for that
 *                              period have been sent. Durable because a crash
 *                              loop inside a period is exactly how a free
 *                              allowance gets burned twice.
 */

import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The bound on the raw-context column. Enough of the parsed offer markup to
 * debug a parser break, and no more: this phase has no live fetch, and the
 * fixture invariant (no review body, no reviewer name, no account identifier)
 * bounds what the column is ever allowed to hold as much as the length does.
 */
export const RAW_CONTEXT_MAX_CHARS = 8192;

export const priceObservations = pgTable(
  "price_observations",
  {
    /** Surrogate key. The natural key of a row is (source, listing, instant). */
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /** Which adapter produced this row, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),

    /**
     * The listing this row observed, as a natural key - the tracked URL, or the
     * source's own listing id. No watchlist table exists before SOURCE-3 to
     * point at with a foreign key, so the natural key is the attribution. THIS
     * is the per-listing key; `store_id` is not, and never becomes it.
     */
    listingId: text("listing_id").notNull(),

    /**
     * Reserved for the store-scoped retail dimension HARD-8 adds ("the store it
     * was observed for", distinct from the product). Nullable, and left
     * unpopulated by this phase: no store-scoped source exists yet. It is not
     * the per-listing key and a row is never attributed by it.
     */
    storeId: text("store_id"),

    /**
     * The price as an exact integer in the currency's own minor unit. `bigint`,
     * because floating point is documented inexact and an all-time-low
     * comparison is an equality, and because `numeric` would invite a decimal
     * price back in. Scaled by the currency's ISO 4217 exponent, never by a
     * fixed 100.
     */
    amountMinorUnits: bigint("amount_minor_units", { mode: "bigint" }).notNull(),

    /** ISO 4217 alphabetic code, upper case. Without it there is no history. */
    currency: varchar("currency", { length: 3 }).notNull(),

    /**
     * The timezone-aware instant of the observation. PostgreSQL stores this as
     * UTC and does NOT retain the input zone, which is why the next column
     * exists.
     */
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),

    /**
     * The source's own local time zone as an IANA name, stored beside the
     * instant rather than re-derived from it. A 90-day low is anchored to the
     * retailer's local day, and `timestamptz` cannot answer which day that was.
     */
    sourceTimeZone: text("source_time_zone").notNull(),

    /**
     * The vendor's own price-update timestamp where the source publishes one,
     * null where it does not. SOURCE-3 records it beside the fetch instant.
     */
    vendorPriceUpdatedAt: timestamp("vendor_price_updated_at", {
      withTimezone: true,
      mode: "date",
    }),

    /**
     * How many hours this source's terms allow its raw content to be retained,
     * null where the source declares no ceiling. Retention is a per-source
     * property (Best Buy's terms cap cached Content at 72 hours while the brief
     * wants history indefinitely), so it is a column on the row from the first
     * migration rather than a migration over the largest table later. SOURCE-3
     * enforces it; this phase only carries it.
     */
    rawContextRetentionHours: integer("raw_context_retention_hours"),

    /**
     * Enough of the parsed offer markup to debug a parser break, bounded to
     * RAW_CONTEXT_MAX_CHARS and to the same reduced markup the fixture
     * invariant requires.
     */
    rawContext: varchar("raw_context", {
      length: RAW_CONTEXT_MAX_CHARS,
    }).notNull(),

    /**
     * The schema.org ItemAvailability token exactly as received, including one
     * this system does not recognise. Never a boolean: ten of the twelve
     * documented members are neither InStock nor OutOfStock. NULL means the
     * markup declared no availability at all, which is not the same as a token
     * whose meaning is unknown.
     */
    availability: text("availability"),
  },
  (table) => [
    index("price_observations_listing_observed_idx").on(
      table.listingId,
      table.observedAt,
    ),
    index("price_observations_source_idx").on(table.sourceId),
    check(
      "price_observations_currency_is_iso_4217",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);

/**
 * The completed-initialization marker.
 *
 * One row, ever. Its presence means "this volume carries a history that was
 * deliberately initialized"; its absence means the ordinary start path must
 * refuse to start rather than begin a new empty history.
 */
export const historyInitialization = pgTable(
  "history_initialization",
  {
    /** Always 1. The check constraint below is what makes this a singleton. */
    id: integer("id").primaryKey(),
    /** When the one-time initialization action completed. */
    initializedAt: timestamp("initialized_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    /** Which migration set was applied, so a restore is self-describing. */
    schemaVersion: text("schema_version").notNull(),
    /** Free text: who or what ran the initialization action, and from where. */
    note: text("note").notNull(),
  },
  (table) => [
    check("history_initialization_is_singleton", sql`${table.id} = 1`),
  ],
);

/**
 * The governor's allowance counter, one row per metered source per period.
 *
 * The primary key is (source, period start), so a new period is a new row and
 * "counting from zero for the new period" is a property of the key rather than
 * of a reset somebody has to remember to run. `warned_at` and `stopped_at` hold
 * the "exactly once per period" promise across a restart: an in-memory flag
 * would send the second warning at exactly the moment - a crash loop - when the
 * owner least needs two.
 */
export const governorAllowanceUsage = pgTable(
  "governor_allowance_usage",
  {
    /** The source the allowance belongs to, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),
    /** The instant the current allowance period began, aligned to the epoch. */
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * Requests that LEFT THE PROCESS in this period, whatever came back. An
     * error, a 403 and a block each consumed the allowance.
     */
    consumed: integer("consumed").notNull().default(0),
    /** When the single warn-fraction notification for this period was emitted. */
    warnedAt: timestamp("warned_at", { withTimezone: true, mode: "date" }),
    /** When the single stop notification for this period was emitted. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({
      name: "governor_allowance_usage_pkey",
      columns: [table.sourceId, table.periodStart],
    }),
    check(
      "governor_allowance_usage_consumed_non_negative",
      sql`${table.consumed} >= 0`,
    ),
  ],
);

export type PriceObservationRow = typeof priceObservations.$inferSelect;
export type NewPriceObservationRow = typeof priceObservations.$inferInsert;
export type InitializationMarkerRow = typeof historyInitialization.$inferSelect;
export type GovernorAllowanceUsageRow = typeof governorAllowanceUsage.$inferSelect;
