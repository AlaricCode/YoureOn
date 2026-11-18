-- Migration 0008 (Beat 5, the appeal panel): appeals + appeal_votes (DATA-MODEL §5.15) and the
-- deferred FK rulings.appeal_id -> appeals (the stage='appeal' ruling holds the hashed
-- AppealResult). The enums (appeal_status, panel_provider, vote_status, vote_counted_as,
-- appeal_decided_by) already exist from 0000. Journal `when` 1795300000000 (after 0007's) so
-- drizzle's migrator, which skips entries older than the last applied one, applies it.
-- The FKs between appeals and rulings are NO ACTION (checked at the end of the statement), so a
-- bet delete (POST /v1/demo/reset) cascades through both tables in one statement.
CREATE TABLE "appeal_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appeal_id" uuid NOT NULL,
	"seat" smallint NOT NULL,
	"provider" "panel_provider" NOT NULL,
	"model" text NOT NULL,
	"status" "vote_status" NOT NULL,
	"outcome" "ruling_outcome" NOT NULL,
	"counted_as" "vote_counted_as" NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"output_sha256" text NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_votes_seat" CHECK (seat BETWEEN 0 AND 2),
	CONSTRAINT "appeal_votes_outcome" CHECK (outcome IN ('A_WINS','B_WINS','REDO')),
	CONSTRAINT "appeal_votes_confidence" CHECK (confidence BETWEEN 0 AND 1),
	CONSTRAINT "appeal_votes_reason_len" CHECK (char_length(reason) <= 280),
	CONSTRAINT "appeal_votes_failed" CHECK (status = 'ok' OR (outcome = 'REDO' AND confidence = 0 AND reason = ''
        AND counted_as = 'ABSTAIN')),
	CONSTRAINT "appeal_votes_latency" CHECK (latency_ms IS NULL OR latency_ms >= 0),
	CONSTRAINT "appeal_votes_output_sha256_fmt" CHECK (output_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"appellant_user_id" uuid NOT NULL,
	"appellant_party" "party" NOT NULL,
	"appealed_ruling_id" uuid NOT NULL,
	"original_outcome" "ruling_outcome" NOT NULL,
	"status" "appeal_status" DEFAULT 'filing' NOT NULL,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"final_outcome" "ruling_outcome",
	"decided_by" "appeal_decided_by",
	"flipped" boolean,
	"result_ruling_id" uuid,
	CONSTRAINT "appeals_original_outcome" CHECK (original_outcome IN ('A_WINS','B_WINS','VOID')),
	CONSTRAINT "appeals_final_outcome" CHECK (final_outcome IS NULL OR final_outcome IN ('A_WINS','B_WINS','VOID')),
	CONSTRAINT "appeals_decided" CHECK ((status = 'decided') = (decided_at IS NOT NULL AND final_outcome IS NOT NULL
        AND decided_by IS NOT NULL AND flipped IS NOT NULL AND result_ruling_id IS NOT NULL)),
	CONSTRAINT "appeals_flipped" CHECK (flipped IS NULL OR flipped = (final_outcome IS DISTINCT FROM original_outcome))
);
--> statement-breakpoint
ALTER TABLE "appeal_votes" ADD CONSTRAINT "appeal_votes_appeal_id_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appellant_user_id_users_id_fk" FOREIGN KEY ("appellant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_appealed_ruling_id_rulings_id_fk" FOREIGN KEY ("appealed_ruling_id") REFERENCES "public"."rulings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_result_ruling_id_rulings_id_fk" FOREIGN KEY ("result_ruling_id") REFERENCES "public"."rulings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_votes_seat_uq" ON "appeal_votes" USING btree ("appeal_id","seat");--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_votes_provider_uq" ON "appeal_votes" USING btree ("appeal_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_bet_uq" ON "appeals" USING btree ("bet_id");--> statement-breakpoint
ALTER TABLE "rulings" ADD CONSTRAINT "rulings_appeal_id_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeals"("id") ON DELETE no action ON UPDATE no action;