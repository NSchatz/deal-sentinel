CREATE TABLE "request_outcomes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"outcome_class" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "request_outcomes_duration_non_negative" CHECK ("request_outcomes"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "request_outcomes_source_recorded_idx" ON "request_outcomes" USING btree ("source_id","recorded_at");