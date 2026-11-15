CREATE TABLE "chain_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chain_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"signature" text NOT NULL,
	"outer_ix" smallint NOT NULL,
	"inner_ix" smallint NOT NULL,
	"slot" bigint,
	"block_height" bigint,
	"tx_index" integer,
	"block_time" timestamp with time zone,
	"commitment" text DEFAULT 'confirmed' NOT NULL,
	"program_id" text NOT NULL,
	"event_name" text NOT NULL,
	"bet_id" uuid,
	"payload" jsonb NOT NULL,
	"raw_b64" text,
	"source" "chain_event_source" DEFAULT 'stream' NOT NULL,
	"delivery_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"apply_error" text,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "chain_events_commitment" CHECK (commitment IN ('confirmed','finalized')),
	CONSTRAINT "chain_events_ix_nonneg" CHECK (outer_ix >= 0 AND inner_ix >= 0),
	CONSTRAINT "chain_events_signature_fmt" CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "chain_events_program_id_fmt" CHECK (program_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_dedupe_uq" ON "chain_events" USING btree ("signature","outer_ix","inner_ix");--> statement-breakpoint
CREATE INDEX "chain_events_bet_idx" ON "chain_events" USING btree ("bet_id","received_at");--> statement-breakpoint
CREATE INDEX "chain_events_unapplied" ON "chain_events" USING btree ("received_at") WHERE applied_at IS NULL;--> statement-breakpoint
CREATE INDEX "chain_events_recent" ON "chain_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "bet_events" ADD CONSTRAINT "bet_events_chain_event_id_chain_events_id_fk" FOREIGN KEY ("chain_event_id") REFERENCES "public"."chain_events"("id") ON DELETE no action ON UPDATE no action;