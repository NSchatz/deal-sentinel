CREATE TABLE "alert_cooldowns" (
	"source_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	CONSTRAINT "alert_cooldowns_pkey" PRIMARY KEY("source_id","listing_id","rule_id"),
	CONSTRAINT "alert_cooldowns_currency_is_iso_4217" CHECK ("alert_cooldowns"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "watchlist_entries" ADD COLUMN "listing_url" text;