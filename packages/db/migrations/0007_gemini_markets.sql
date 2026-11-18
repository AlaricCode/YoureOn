-- Migration 0007 (Beat 6, the Gemini closer): gemini_markets + market_snapshots (DATA-MODEL
-- §5.16), bets.gemini_market_id / pricing_snapshot_id with CHECK bets_gemini_market and
-- bets_market_idx, and one settlement ruling per bet (rulings_settlement_uq).
-- Numbered 0007 on purpose: 0006 belongs to another stream. Nothing here depends on 0006, so the
-- two apply in either order; the journal `when` (1795200000000) is later than 0006's so drizzle's
-- migrator (which skips entries older than the last applied one) applies both.
-- bets_gemini_market holds for every existing row: real_world bets were refused (NO_MARKET)
-- before this migration, so no bet has evidence_source = 'gemini'.
CREATE TABLE "gemini_markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_ticker" text NOT NULL,
	"instrument_symbol" text NOT NULL,
	"contract_ticker" text,
	"series" text,
	"title" text,
	"strike" numeric(20, 8),
	"window_start" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "market_status" DEFAULT 'active' NOT NULL,
	"resolution_side" "market_side",
	"settlement_value" text,
	"resolved_at" timestamp with time zone,
	"settlement_raw" text,
	"settlement_response_sha256" text,
	"event_raw" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gemini_markets_settlement_pair" CHECK ((settlement_raw IS NULL) = (settlement_response_sha256 IS NULL)),
	CONSTRAINT "gemini_markets_settlement_hash" CHECK (settlement_raw IS NULL
        OR settlement_response_sha256 = encode(sha256(convert_to(settlement_raw, 'UTF8')), 'hex')),
	CONSTRAINT "gemini_markets_resolution" CHECK (resolution_side IS NULL OR status = 'settled'),
	CONSTRAINT "gemini_markets_settlement_response_sha256_fmt" CHECK (settlement_response_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "market_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"market_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exchange_ts" timestamp with time zone,
	"source" text NOT NULL,
	"best_bid" numeric(5, 4),
	"best_ask" numeric(5, 4),
	"last_price" numeric(5, 4),
	"index_price" numeric(20, 8),
	"snapshot_canonical" text,
	"snapshot_sha256" text,
	CONSTRAINT "market_snapshots_source" CHECK (source IN ('ws_book_ticker','rest_event')),
	CONSTRAINT "market_snapshots_hash" CHECK ((snapshot_canonical IS NULL) = (snapshot_sha256 IS NULL)
        AND (snapshot_canonical IS NULL
          OR snapshot_sha256 = encode(sha256(convert_to(snapshot_canonical, 'UTF8')), 'hex'))),
	CONSTRAINT "market_snapshots_snapshot_sha256_fmt" CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "gemini_market_id" uuid;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "pricing_snapshot_id" bigint;--> statement-breakpoint
ALTER TABLE "market_snapshots" ADD CONSTRAINT "market_snapshots_market_id_gemini_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."gemini_markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gemini_markets_symbol_uq" ON "gemini_markets" USING btree ("instrument_symbol");--> statement-breakpoint
CREATE INDEX "gemini_markets_open_idx" ON "gemini_markets" USING btree ("expires_at") WHERE status IN ('active','closed');--> statement-breakpoint
CREATE INDEX "market_snapshots_idx" ON "market_snapshots" USING btree ("market_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_gemini_market_id_gemini_markets_id_fk" FOREIGN KEY ("gemini_market_id") REFERENCES "public"."gemini_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_pricing_snapshot_id_market_snapshots_id_fk" FOREIGN KEY ("pricing_snapshot_id") REFERENCES "public"."market_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bets_market_idx" ON "bets" USING btree ("gemini_market_id") WHERE gemini_market_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rulings_settlement_uq" ON "rulings" USING btree ("bet_id") WHERE stage = 'settlement';--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_gemini_market" CHECK (evidence_source IS DISTINCT FROM 'gemini'
        OR (gemini_market_id IS NOT NULL AND a_position IS NOT NULL
            AND outcome IS DISTINCT FROM 'split'));