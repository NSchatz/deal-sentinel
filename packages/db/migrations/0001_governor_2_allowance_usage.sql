CREATE TABLE "governor_allowance_usage" (
	"source_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"warned_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "governor_allowance_usage_pkey" PRIMARY KEY("source_id","period_start"),
	CONSTRAINT "governor_allowance_usage_consumed_non_negative" CHECK ("governor_allowance_usage"."consumed" >= 0)
);
