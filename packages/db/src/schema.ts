/**
 * The price history schema.
 *
 * Eight tables, and all of them are load-bearing:
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
 *   `watchlist_entries`        the durable set of listings the system observes,
 *                              per source, each entry enabled or disabled. A
 *                              collection run reads this and NOTHING else to
 *                              decide what to fetch.
 *   `source_period_stops`      which sources are stopped for which allowance
 *                              period because the source itself said the limit
 *                              was exceeded, and whether the single
 *                              notification for that stop has been sent.
 *                              Durable for the same reason the allowance
 *                              counter is: a restart inside the period must not
 *                              be how a stopped source starts asking again.
 *   `alert_cooldowns`          when a rule last fired for a listing, so it does
 *                              not fire again inside its own cooldown. Durable
 *                              because a restart is otherwise how one alert
 *                              becomes an alert every time the container comes
 *                              back, which is the failure mode that kills tools
 *                              like this one.
 *   `fetch_outcomes`           one row per offered fetch: which source, which of
 *                              the four outcome classes, how long it took, when
 *                              its outcome was known, and the condition where
 *                              there is one. Durable because every one of those
 *                              facts otherwise dies in a process that exits, and
 *                              "is the watcher still watching?" is then a
 *                              question only a log can answer.
 *   `breaker_pauses`           one row per breaker pause, with the condition
 *                              that caused it. The breaker's own state is a Map
 *                              in one process; a reader that is not that process
 *                              can see a pause only because it is written here.
 *
 * THREE STATES THIS SCHEMA KEEPS APART, and conflating any two of them is the
 * defect the separation exists to prevent:
 *
 *   a `breaker_pauses` row              THIS system pausing a source it judges
 *                                       to be failing. Our verdict about them.
 *   `governor_allowance_usage`          THIS system reaching its OWN configured
 *     `.stopped_at`                     allowance for the period. Our budget.
 *   a `source_period_stops` row         THE VENDOR answering 403. Their verdict
 *                                       about us.
 *
 * An operator acts differently on each - raise nothing, wait for the period,
 * or go and read the vendor's terms - so a view that showed them as one state
 * would be worse than no view.
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
     *
     * NULLABLE since SOURCE-3, and the nullability is the retention policy's
     * only honest shape. A source whose terms cap how long its Content may be
     * cached has that content DELETED once the ceiling passes, while the
     * observation itself - price, currency, both instants, source and listing -
     * is kept indefinitely, so the column has to be able to hold "there is no
     * longer any raw content here". Writing an empty string instead would be a
     * value pretending to be an absence, and neither the terms nor a later
     * reader are served by that. Nothing in this system writes NULL here: the
     * write path requires a string, so a NULL is always content this system
     * aged out on purpose.
     */
    rawContext: varchar("raw_context", {
      length: RAW_CONTEXT_MAX_CHARS,
    }),

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

/**
 * The watchlist: the durable set of listings the system observes.
 *
 * A collection run reads THIS and nothing else to decide what to fetch, which
 * is what makes "attempted no listing that is absent from the watchlist" a
 * property of the query rather than of somebody's care at a call site. An entry
 * is keyed to the same per-listing natural key `price_observations.listing_id`
 * carries, per source - for the sanctioned API that is the vendor's own SKU -
 * so an observation is attributed by the key the watchlist asked for.
 *
 * `enabled` rather than a delete: switching a listing off and leaving its
 * history in place is the ordinary thing an owner does, and a row that came
 * back would otherwise lose why it was ever tracked.
 */
export const watchlistEntries = pgTable(
  "watchlist_entries",
  {
    /** Surrogate key. The natural key of a row is (source, listing). */
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /** Which source observes this listing, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),

    /**
     * The listing, as the same natural key an observation is attributed by.
     * Never a store id: `price_observations.store_id` is HARD-8's dimension and
     * is not a listing key here either.
     */
    listingId: text("listing_id").notNull(),

    /**
     * The link the OWNER supplied for this listing: the page they would open to
     * buy it. Nullable, and the nullability is the honest shape - an entry added
     * before this column existed carries no link, and there is no way to derive
     * one. Nothing in this system fabricates it, and the adapter's own product
     * URL is not a candidate: that is an API endpoint carrying a credential in
     * its query string, and an alert is the one place that must never reach.
     * An alert for a listing with no link is NOT SENT; the listing is reported
     * by name instead.
     */
    listingUrl: text("listing_url"),

    /** False means a run attempts nothing for this entry, and issues nothing. */
    enabled: boolean("enabled").notNull().default(true),

    /** When the owner added it. Free text below says why. */
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
 * allowance, while a row here records the vendor answering 403 - documented by
 * the sanctioned API's own error table as "the API key is not valid, or the
 * allocated call limit has been exceeded". Only the vendor knows which of those
 * it meant, and neither is fixed by asking again, so the answer to both is to
 * stop that source for the period rather than retry it.
 *
 * Keyed by (source, period start) exactly as the allowance counter is, so a new
 * period is a new row and no reset job has to exist. Durable because a crash
 * loop inside the period is precisely when a stopped source would otherwise
 * start asking again. `notified_at` holds "notify once" across that restart.
 */
export const sourcePeriodStops = pgTable(
  "source_period_stops",
  {
    /** The source that was stopped, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),
    /** The instant the allowance period began, aligned to the epoch. */
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** When this system recorded the stop. */
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
 * When a rule last fired for a listing, so that it does not fire again inside
 * its own cooldown.
 *
 * DURABLE, and that is the whole point of it being a table. BRIEF.md section 7
 * names over-alerting as "the failure mode that kills these tools", and an
 * in-memory suppression is no suppression at all: a container that restarts
 * every few minutes would send the same alert every few minutes, which is
 * precisely the moment the owner stops reading them. `source_period_stops`
 * carries its once-only `notified_at` for the same reason.
 *
 * Keyed by (source, listing, rule) - the same per-listing natural key
 * `watchlist_entries` uses, plus the rule. A listing id means nothing without
 * its source, and two rules over one listing are two independent cooldowns.
 *
 * `fired_at` is the instant of the notification this system DELIVERED. A
 * delivery that failed writes nothing here, so a failed alert is retried on the
 * next run rather than being silently suppressed for a week.
 */
export const alertCooldowns = pgTable(
  "alert_cooldowns",
  {
    /** The source the listing belongs to, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),
    /** The listing, as the same natural key an observation is attributed by. */
    listingId: text("listing_id").notNull(),
    /** The rule that fired, as `config/alerts.json` names it. */
    ruleId: text("rule_id").notNull(),
    /** When the notification this row suppresses was delivered. */
    firedAt: timestamp("fired_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * The observed price that fired it, in exact minor units, and its currency.
     * Carried so an operator can see WHY a listing is quiet without joining
     * back to the history. Never a credential and never a URL: an alert record
     * is a place a pasted endpoint would otherwise come to rest.
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

/**
 * The four outcome classes a recorded fetch is sorted into, and nothing else.
 *
 * Exhaustive on purpose, and distinguishable in every query and view over the
 * record, because the four are acted on differently and a fifth bucket called
 * "other" is where the interesting one would go:
 *
 *   `success`  a usable response arrived.
 *   `error`    the request LEFT THIS PROCESS and no usable response came back -
 *              a transport failure, or a status that is not a refusal and is
 *              not usable.
 *   `blocked`  the far side REFUSED it: a 429, or a status that source's own
 *              terms document as limit-exceeded. This is the class the roadmap
 *              phase exists for - block rate is what says whether the
 *              politeness ceilings are right, and adding retailers without it
 *              is tuning blind.
 *   `refused`  THIS system declined to send it, and the governor's own refusal
 *              reason is the condition. Nothing left the process.
 */
export const FETCH_OUTCOME_CLASSES = [
  "success",
  "error",
  "blocked",
  "refused",
] as const;

export type FetchOutcomeClass = (typeof FETCH_OUTCOME_CLASSES)[number];

/**
 * One offered fetch, and how it ended.
 *
 * WHAT THIS TABLE MAY NEVER HOLD: a response body, a credential, or a query
 * string carrying one. A row is a class, a latency and a redacted condition,
 * and that bound is what keeps the source retention ceilings out of this table
 * entirely - there is no content here to age out. `raw_context` on an
 * observation is content and has a per-source ceiling; a condition string is
 * this system's own words about what happened and has none.
 */
export const fetchOutcomes = pgTable(
  "fetch_outcomes",
  {
    /** Surrogate key. The natural key of a row is (source, instant). */
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /** Which source the fetch was offered for, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),

    /** One of the four classes above. The check constraint is what makes it. */
    outcomeClass: text("outcome_class").notNull(),

    /**
     * Whole milliseconds from when the request was OFFERED to when its outcome
     * was KNOWN. Recorded for all four classes: a refusal that took a whole
     * ceiling interval to arrive at is a fact about this system's behaviour
     * just as much as a slow response is.
     */
    latencyMs: integer("latency_ms").notNull(),

    /** The instant the outcome was known. Every rate is computed over this. */
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),

    /**
     * Why, in this system's own words, REDACTED. Null for an ordinary success,
     * which has no condition to state. Never a response body: see the table
     * comment.
     */
    condition: text("condition"),
  },
  (table) => [
    // The read this table exists for: one source's outcomes inside a period.
    index("fetch_outcomes_source_occurred_idx").on(
      table.sourceId,
      table.occurredAt,
    ),
    // And the other one: this source's most recent success, for the staleness
    // verdict, which reads one row per source and must not scan the table.
    index("fetch_outcomes_source_class_occurred_idx").on(
      table.sourceId,
      table.outcomeClass,
      table.occurredAt,
    ),
    check(
      "fetch_outcomes_class_is_one_of_four",
      sql`${table.outcomeClass} in ('success', 'error', 'blocked', 'refused')`,
    ),
    check("fetch_outcomes_latency_non_negative", sql`${table.latencyMs} >= 0`),
  ],
);

/**
 * A breaker pause, made durable at the moment it is announced.
 *
 * `Breaker` keeps every counter in a `Map` in one process and resumes lazily,
 * so "this source is paused" is a fact that exists nowhere a second process can
 * read it. A row here is what makes a pause visible to a reader that is not the
 * process that paused the source, which is the whole of the phase assertion.
 *
 * WRITTEN EXACTLY ONCE PER PAUSE, because it is written from the one place a
 * pause is announced: `Breaker.record`'s return value. Anything that polled
 * `status()` instead would write a row per request behind the pause.
 *
 * `expires_at` rather than a duration: whether a source is paused RIGHT NOW is
 * then a comparison a reader makes against its own clock, so an expired pause
 * reads as resumed with no restart, no sweep job and no manual reset - and the
 * expired row stays exactly where it is, as the history of what happened.
 */
export const breakerPauses = pgTable(
  "breaker_pauses",
  {
    /** Surrogate key. The natural key of a row is (source, start). */
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /** The source that was paused, e.g. "bestbuy-api". */
    sourceId: text("source_id").notNull(),

    /** When the pause began. */
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }).notNull(),

    /** When it ends. A reader compares this against its own clock and nothing else. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),

    /** How many outcomes in the window were an error or a block. */
    failingCount: integer("failing_count").notNull(),

    /** How many outcomes were in the window altogether. */
    windowOutcomes: integer("window_outcomes").notNull(),

    /** The configured window those outcomes were counted over, in milliseconds. */
    windowMs: integer("window_ms").notNull(),

    /**
     * The configured failure-rate threshold that was crossed, as the exact text
     * of the number the operator configured.
     *
     * TEXT and not a float column: this value is only ever SHOWN, never
     * computed with, and a float column would let 0.5 come back as something
     * with a tail on a display path. The repository's rule about floats is
     * about money; this is the same instinct applied one table over, at no
     * cost, because nothing here ever needs to add it up.
     */
    failureRateThreshold: text("failure_rate_threshold").notNull(),

    /** The condition in words, as the breaker itself stated it. Redacted. */
    condition: text("condition").notNull(),
  },
  (table) => [
    // "Is this source paused now?" and "what pauses has it had?" are the same
    // read with a different bound, and both are this index.
    index("breaker_pauses_source_expires_idx").on(table.sourceId, table.expiresAt),
    check("breaker_pauses_window_is_positive", sql`${table.windowMs} > 0`),
    check(
      "breaker_pauses_counts_are_sane",
      sql`${table.failingCount} >= 0 and ${table.windowOutcomes} >= ${table.failingCount}`,
    ),
    check(
      "breaker_pauses_expires_after_it_begins",
      sql`${table.expiresAt} > ${table.pausedAt}`,
    ),
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
export type FetchOutcomeRow = typeof fetchOutcomes.$inferSelect;
export type NewFetchOutcomeRow = typeof fetchOutcomes.$inferInsert;
export type BreakerPauseRow = typeof breakerPauses.$inferSelect;
export type NewBreakerPauseRow = typeof breakerPauses.$inferInsert;
