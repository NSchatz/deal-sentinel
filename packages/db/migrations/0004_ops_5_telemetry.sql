CREATE TABLE "breaker_pauses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"paused_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failing_count" integer NOT NULL,
	"window_outcomes" integer NOT NULL,
	"window_ms" integer NOT NULL,
	"failure_rate_threshold" text NOT NULL,
	"condition" text NOT NULL,
	CONSTRAINT "breaker_pauses_window_is_positive" CHECK ("breaker_pauses"."window_ms" > 0),
	CONSTRAINT "breaker_pauses_counts_are_sane" CHECK ("breaker_pauses"."failing_count" >= 0 and "breaker_pauses"."window_outcomes" >= "breaker_pauses"."failing_count"),
	CONSTRAINT "breaker_pauses_expires_after_it_begins" CHECK ("breaker_pauses"."expires_at" > "breaker_pauses"."paused_at")
);
--> statement-breakpoint
CREATE TABLE "fetch_outcomes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"outcome_class" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"condition" text,
	CONSTRAINT "fetch_outcomes_class_is_one_of_four" CHECK ("fetch_outcomes"."outcome_class" in ('success', 'error', 'blocked', 'refused')),
	CONSTRAINT "fetch_outcomes_latency_non_negative" CHECK ("fetch_outcomes"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "breaker_pauses_source_expires_idx" ON "breaker_pauses" USING btree ("source_id","expires_at");--> statement-breakpoint
CREATE INDEX "fetch_outcomes_source_occurred_idx" ON "fetch_outcomes" USING btree ("source_id","occurred_at");--> statement-breakpoint
CREATE INDEX "fetch_outcomes_source_class_occurred_idx" ON "fetch_outcomes" USING btree ("source_id","outcome_class","occurred_at");