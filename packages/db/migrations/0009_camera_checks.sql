-- Migration 0009 (camera checks, SAM 3.1 p1, non-binding): bet_checks (the CheckSpec compiled
-- from the bet's terms, keyed by the terms_hash it was compiled from) and attempt_checks (each
-- attempt's CheckReport, ok or unavailable). Not part of the hashed Terms. Both cascade on a bet
-- delete (POST /v1/demo/reset). Journal `when` 1795400000000 (after 0008's) so drizzle's
-- migrator, which skips entries older than the last applied one, applies it.
CREATE TABLE "attempt_checks" (
	"bet_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" text NOT NULL,
	"report" jsonb NOT NULL,
	"report_hash" text NOT NULL,
	"sam_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_checks_bet_id_attempt_no_pk" PRIMARY KEY("bet_id","attempt_no"),
	CONSTRAINT "attempt_checks_report_hash_fmt" CHECK (report_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attempt_checks_status" CHECK (status IN ('ok','unavailable')),
	CONSTRAINT "attempt_checks_attempt_no" CHECK (attempt_no >= 1),
	CONSTRAINT "attempt_checks_sam_ms" CHECK (sam_ms IS NULL OR sam_ms >= 0)
);
--> statement-breakpoint
CREATE TABLE "bet_checks" (
	"bet_id" uuid PRIMARY KEY NOT NULL,
	"terms_hash" text NOT NULL,
	"decision" text NOT NULL,
	"spec" jsonb,
	"why" text DEFAULT '' NOT NULL,
	"readback" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bet_checks_terms_hash_fmt" CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bet_checks_decision" CHECK (decision IN ('checks','judge_only')),
	CONSTRAINT "bet_checks_spec" CHECK ((decision = 'checks') = (spec IS NOT NULL)),
	CONSTRAINT "bet_checks_status" CHECK (status IN ('ok','fallback')),
	CONSTRAINT "bet_checks_readback_len" CHECK (char_length(readback) <= 400)
);
--> statement-breakpoint
ALTER TABLE "attempt_checks" ADD CONSTRAINT "attempt_checks_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bet_checks" ADD CONSTRAINT "bet_checks_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;