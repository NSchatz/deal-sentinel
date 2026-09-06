CREATE TABLE "source_period_stops" (
	"source_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "source_period_stops_pkey" PRIMARY KEY("source_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "watchlist_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "price_observations" ALTER COLUMN "raw_context" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_entries_source_listing_key" ON "watchlist_entries" USING btree ("source_id","listing_id");--> statement-breakpoint
CREATE INDEX "watchlist_entries_source_enabled_idx" ON "watchlist_entries" USING btree ("source_id","enabled");