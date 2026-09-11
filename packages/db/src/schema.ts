/**
 * The price history schema: six tables, all load-bearing.
 *
 * History accrues at one observation per listing per run and cannot be
 * backfilled, so every column a phase names is here from its first migration
 * rather than as a migration over the largest table in the system later.
 * Durability is the other theme: the initialization marker, the allowance
 * counter, the source stops and the alert cooldowns are all tables because a
 * crash loop is otherwise how a free allowance gets burned twice and how one
 * alert becomes an alert every time the container comes back.
 */

import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Enough of the parsed offer markup to debug a parser break, and no more. */
export const RAW_CONTEXT_MAX_CHARS = 8192;

export const priceObservations = pgTable(
  "price_observations",
  {
    /** Surrogate key. The natural key of a row is (source, listing, instant). */
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    sourceId: text("source_id").notNull(),

    /**
     * The tracked URL, or the source's own listing id. THIS is the per-listing
     * key; `store_id` is not, and never becomes it.
     */
    listingId: text("listing_id").notNull(),

    /**
     * Reserved for the store-scoped retail dimension HARD-8 adds, distinct from
     * the product. Left unpopulated by this phase, and a row is never
     * attributed by it.
     */
    storeId: text("store_id"),

    /**
     * An exact integer in the currency's own minor unit. `bigint`, because
     * floating point is documented inexact and an all-time-low comparison is an
     * equality, and because `numeric` would invite a decimal price back in.
     * Scaled by the currency's ISO 4217 exponent, never by a fixed 100.
     */
    amountMinorUnits: bigint("amount_minor_units", { mode: "bigint" }).notNull(),

    /** ISO 4217 alphabetic code, upper case. Without it there is no history. */
    currency: varchar("currency", { length: 3 }).notNull(),

    /**
     * PostgreSQL stores this as UTC and does NOT retain the input zone, which
     * is why the next column exists.
     */
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),

    /**
     * An IANA name, stored beside the instant rather than re-derived from it: a
     * 90-day low is anchored to the retailer's local day, and `timestamptz`
     * cannot answer which day that was.
     */
    sourceTimeZone: text("source_time_zone").notNull(),

    /** Null where the source publishes no price-update timestamp of its own. */
    vendorPriceUpdatedAt: timestamp("vendor_price_updated_at", {
      withTimezone: true,
      mode: "date",
    }),

    /**
     * Null where the source declares no ceiling. Retention is a per-source
     * property - Best Buy's terms cap cached Content at 72 hours while the
     * brief wants history indefinitely - so it is a column from the first
     * migration. SOURCE-3 enforces it; this phase only carries it.
     */
    rawContextRetentionHours: integer("raw_context_retention_hours"),

    /**
     * NULLABLE, and the nullability is the retention policy's only honest
     * shape: a source whose terms cap how long its Content may be cached has
     * that content DELETED once the ceiling passes, while the observation
     * itself is kept indefinitely. An empty string would be a value pretending
     * to be an absence. Nothing here writes NULL - the write path requires a
     * string - so a NULL is always content this system aged out on purpose.
     */
    rawContext: varchar("raw_context", {
      length: RAW_CONTEXT_MAX_CHARS,
    }),

    /**
     * The schema.org ItemAvailability token exactly as received, unrecognised
     * ones included. Never a boolean: ten of the twelve documented members are
     * neither InStock nor OutOfStock. NULL means the markup declared none,
     * which is not the same as a token whose meaning is unknown.
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
 * One row, ever. Its presence means "this volume carries a history that was
 * deliberately initialized"; its absence means the ordinary start path refuses
 * to start rather than beginning a new empty history.
 */
export const historyInitialization = pgTable(
  "history_initialization",
  {
    /** Always 1. The check constraint below is what makes this a singleton. */
    id: integer("id").primaryKey(),
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
 * counting from zero is a property of the key rather than of a reset somebody
 * remembers to run. `warned_at` and `stopped_at` hold "exactly once per period"
 * across a restart: an in-memory flag would send the second warning during a
 * crash loop, exactly when the owner least needs two.
 */
export const governorAllowanceUsage = pgTable(
  "governor_allowance_usage",
  {
    sourceId: text("source_id").notNull(),
    /** Aligned to the epoch. */
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * Requests that LEFT THE PROCESS in this period, whatever came back. An
     * error, a 403 and a block each consumed the allowance.
     */
    consumed: integer("consumed").notNull().default(0),
    /** When the single warn-fraction notification for this period went out. */
    warnedAt: timestamp("warned_at", { withTimezone: true, mode: "date" }),
    /** When the single stop notification for this period went out. */
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

/**
 * The durable set of listings the system observes.
 *
 * A collection run reads THIS and nothing else to decide what to fetch, which
 * makes "attempted no listing absent from the watchlist" a property of the
 * query rather than of care at a call site. `enabled` rather than a delete:
 * switching a listing off and keeping its history is the ordinary thing an
 * owner does, and a deleted row that came back would lose why it was tracked.
 */
export const watchlistEntries = pgTable(
  "watchlist_entries",
  {
    /** Surrogate key. The natural key of a row is (source, listing). */
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    sourceId: text("source_id").notNull(),

    /**
     * The same natural key an observation is attributed by. Never a store id:
     * `price_observations.store_id` is HARD-8's dimension, not a listing key.
     */
    listingId: text("listing_id").notNull(),

    /**
     * The link the OWNER supplied: the page they would open to buy it. An entry
     * added before this column existed carries none, and nothing fabricates
     * one. The adapter's own product URL is not a candidate - that is an API
     * endpoint carrying a credential in its query string, and an alert is the
     * one place that must never reach. An alert for a listing with no link is
     * NOT SENT; the listing is reported by name instead.
     */
    listingUrl: text("listing_url"),

    /** False means a run attempts nothing for this entry, and issues nothing. */
    enabled: boolean("enabled").notNull().default(true),

    addedAt: timestamp("added_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    /** The owner's own note. Never a credential, never a response body. */
    note: text("note"),
  },
  (table) => [
    // One entry per listing per source. Two rows for one listing would be two
    // requests per run for one price, spent out of a metered allowance.
    uniqueIndex("watchlist_entries_source_listing_key").on(
      table.sourceId,
      table.listingId,
    ),
    index("watchlist_entries_source_enabled_idx").on(table.sourceId, table.enabled),
  ],
);

/**
 * A source stopped for one allowance period because THE SOURCE said so.
 *
 * Distinct from `governor_allowance_usage.stopped_at`, and the distinction is
 * the point: that column records this system reaching its OWN configured
 * allowance, while a row here records the vendor answering 403, documented as
 * "the API key is not valid, or the allocated call limit has been exceeded".
 * Only the vendor knows which it meant and neither is fixed by asking again.
 * Keyed like the allowance counter, and durable for the same reason.
 */
export const sourcePeriodStops = pgTable(
  "source_period_stops",
  {
    sourceId: text("source_id").notNull(),
    /** Aligned to the epoch. */
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * The condition, in words. Never a response body and never a credential:
     * the vendor's key travels in a query string, so anything echoed back is
     * redacted before it reaches this column.
     */
    reason: text("reason").notNull(),
    /** When the single notification for this stop was emitted. */
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({
      name: "source_period_stops_pkey",
      columns: [table.sourceId, table.periodStart],
    }),
  ],
);

/**
 * When a rule last fired for a listing, so it does not fire again inside its
 * own cooldown.
 *
 * DURABLE, which is the whole point of it being a table: BRIEF.md section 7
 * names over-alerting as "the failure mode that kills these tools", and a
 * container restarting every few minutes would otherwise send the same alert
 * every few minutes. Keyed by (source, listing, rule), because a listing id
 * means nothing without its source and two rules over one listing are two
 * independent cooldowns. `fired_at` is the instant of a notification this
 * system DELIVERED, so a failed delivery is retried on the next run rather
 * than silently suppressed for a week.
 */
export const alertCooldowns = pgTable(
  "alert_cooldowns",
  {
    sourceId: text("source_id").notNull(),
    listingId: text("listing_id").notNull(),
    /** The rule that fired, as `config/alerts.json` names it. */
    ruleId: text("rule_id").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * The price that fired it, carried so an operator can see WHY a listing is
     * quiet without joining back to the history. Never a credential and never a
     * URL: an alert record is where a pasted endpoint would come to rest.
     */
    amountMinorUnits: bigint("amount_minor_units", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "alert_cooldowns_pkey",
      columns: [table.sourceId, table.listingId, table.ruleId],
    }),
    check("alert_cooldowns_currency_is_iso_4217", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export type PriceObservationRow = typeof priceObservations.$inferSelect;
export type NewPriceObservationRow = typeof priceObservations.$inferInsert;
export type InitializationMarkerRow = typeof historyInitialization.$inferSelect;
export type GovernorAllowanceUsageRow = typeof governorAllowanceUsage.$inferSelect;
export type WatchlistEntryRow = typeof watchlistEntries.$inferSelect;
export type NewWatchlistEntryRow = typeof watchlistEntries.$inferInsert;
export type SourcePeriodStopRow = typeof sourcePeriodStops.$inferSelect;
export type AlertCooldownRow = typeof alertCooldowns.$inferSelect;
