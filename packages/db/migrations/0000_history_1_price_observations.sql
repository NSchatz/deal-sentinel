CREATE TABLE "history_initialization" (
	"id" integer PRIMARY KEY NOT NULL,
	"initialized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" text NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "history_initialization_is_singleton" CHECK ("history_initialization"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "price_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"store_id" text,
	"amount_minor_units" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_time_zone" text NOT NULL,
	"vendor_price_updated_at" timestamp with time zone,
	"raw_context_retention_hours" integer,
	"raw_context" varchar(8192) NOT NULL,
	"availability" text,
	CONSTRAINT "price_observations_currency_is_iso_4217" CHECK ("price_observations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE INDEX "price_observations_listing_observed_idx" ON "price_observations" USING btree ("listing_id","observed_at");--> statement-breakpoint
CREATE INDEX "price_observations_source_idx" ON "price_observations" USING btree ("source_id");