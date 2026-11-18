CREATE TABLE "bet_terms_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"drafted_by" text DEFAULT 'judge' NOT NULL,
	"source_tool" text,
	"canonical_json" text NOT NULL,
	"terms" jsonb GENERATED ALWAYS AS (canonical_json::jsonb) STORED,
	"terms_hash" text NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bet_terms_versions_version_pos" CHECK (version >= 1),
	CONSTRAINT "bet_terms_versions_drafted_by" CHECK (drafted_by IN ('judge','party_a','party_b')),
	CONSTRAINT "bet_terms_versions_hash" CHECK (terms_hash = encode(sha256(convert_to(canonical_json, 'UTF8')), 'hex')),
	CONSTRAINT "bet_terms_versions_terms_hash_fmt" CHECK (terms_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "chain_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"kind" "tx_kind" NOT NULL,
	"bundled_close" boolean DEFAULT false NOT NULL,
	"signer_role" text NOT NULL,
	"message_b64" text,
	"message_sha256" text NOT NULL,
	"nonce_account" text,
	"nonce_value" text,
	"a_signature" text,
	"b_signature" text,
	"a_signed_at" timestamp with time zone,
	"b_signed_at" timestamp with time zone,
	"first_signer" "party",
	"expires_at" timestamp with time zone,
	"revoked_by_tx_id" uuid,
	"simulated_cu" integer,
	"cu_limit" integer,
	"signature" text,
	"expected_status" "onchain_status" NOT NULL,
	"status" "tx_status" DEFAULT 'built' NOT NULL,
	"last_valid_block_height" bigint,
	"err" text,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"rpc_processed_at" timestamp with time zone,
	"rpc_confirmed_at" timestamp with time zone,
	"stream_seen_at" timestamp with time zone,
	CONSTRAINT "chain_txs_signature_uq" UNIQUE("signature"),
	CONSTRAINT "chain_txs_signer_role" CHECK (signer_role IN ('party_a','party_b','both_parties','judge','appeal','fee_payer','crank')),
	CONSTRAINT "chain_txs_message_sha" CHECK (message_b64 IS NULL OR message_sha256 = encode(sha256(decode(message_b64, 'base64')), 'hex')),
	CONSTRAINT "chain_txs_lock_shape" CHECK (kind <> 'atomic_lock' OR (message_b64 IS NOT NULL AND nonce_account IS NOT NULL
        AND nonce_value IS NOT NULL AND expires_at IS NOT NULL AND signer_role = 'both_parties')),
	CONSTRAINT "chain_txs_lock_fully_signed" CHECK (kind <> 'atomic_lock' OR status NOT IN ('sent','confirmed')
        OR (a_signature IS NOT NULL AND b_signature IS NOT NULL)),
	CONSTRAINT "chain_txs_nonce_advance_shape" CHECK (kind <> 'nonce_advance' OR (nonce_account IS NOT NULL AND signer_role = 'fee_payer')),
	CONSTRAINT "chain_txs_revoked_kind" CHECK (status <> 'revoked' OR kind = 'atomic_lock'),
	CONSTRAINT "chain_txs_revoked_by" CHECK ((status = 'revoked') = (revoked_by_tx_id IS NOT NULL)),
	CONSTRAINT "chain_txs_first_signer" CHECK ((first_signer IS NULL) = (a_signature IS NULL AND b_signature IS NULL)),
	CONSTRAINT "chain_txs_cu" CHECK (cu_limit IS NULL OR simulated_cu IS NULL OR cu_limit >= simulated_cu),
	CONSTRAINT "chain_txs_message_sha256_fmt" CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chain_txs_nonce_account_fmt" CHECK (nonce_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "chain_txs_a_signature_fmt" CHECK (a_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "chain_txs_b_signature_fmt" CHECK (b_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "chain_txs_signature_fmt" CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$')
);
--> statement-breakpoint
CREATE TABLE "nonce_pool" (
	"seed_index" smallint PRIMARY KEY NOT NULL,
	"nonce_account" text NOT NULL,
	"authority" text NOT NULL,
	"status" "nonce_status" DEFAULT 'free' NOT NULL,
	"nonce_value" text,
	"value_read_at" timestamp with time zone,
	"leased_bet_id" uuid,
	"leased_tx_id" uuid,
	"leased_at" timestamp with time zone,
	"advance_tx_id" uuid,
	"last_advanced_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL,
	"failures" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "nonce_pool_nonce_account_uq" UNIQUE("nonce_account"),
	CONSTRAINT "nonce_pool_seed_range" CHECK (seed_index BETWEEN 0 AND 15),
	CONSTRAINT "nonce_pool_leased" CHECK ((status = 'leased') = (leased_bet_id IS NOT NULL AND leased_tx_id IS NOT NULL)),
	CONSTRAINT "nonce_pool_advancing" CHECK ((status = 'advancing') = (advance_tx_id IS NOT NULL)),
	CONSTRAINT "nonce_pool_retired" CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
	CONSTRAINT "nonce_pool_free_value" CHECK (status <> 'free' OR nonce_value IS NOT NULL),
	CONSTRAINT "nonce_pool_nonce_account_fmt" CHECK (nonce_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "nonce_pool_authority_fmt" CHECK (authority ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
--> statement-breakpoint
ALTER TABLE "bet_terms_versions" ADD CONSTRAINT "bet_terms_versions_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_txs" ADD CONSTRAINT "chain_txs_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_txs" ADD CONSTRAINT "chain_txs_revoked_by_tx_id_chain_txs_id_fk" FOREIGN KEY ("revoked_by_tx_id") REFERENCES "public"."chain_txs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nonce_pool" ADD CONSTRAINT "nonce_pool_leased_bet_id_bets_id_fk" FOREIGN KEY ("leased_bet_id") REFERENCES "public"."bets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nonce_pool" ADD CONSTRAINT "nonce_pool_leased_tx_id_chain_txs_id_fk" FOREIGN KEY ("leased_tx_id") REFERENCES "public"."chain_txs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nonce_pool" ADD CONSTRAINT "nonce_pool_advance_tx_id_chain_txs_id_fk" FOREIGN KEY ("advance_tx_id") REFERENCES "public"."chain_txs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bet_terms_versions_bet_version_uq" ON "bet_terms_versions" USING btree ("bet_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "bet_terms_versions_final_uq" ON "bet_terms_versions" USING btree ("bet_id") WHERE is_final;--> statement-breakpoint
CREATE INDEX "chain_txs_bet_idx" ON "chain_txs" USING btree ("bet_id","built_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_txs_inflight_uq" ON "chain_txs" USING btree ("bet_id","kind") WHERE status IN ('built','signed','sent');--> statement-breakpoint
CREATE UNIQUE INDEX "chain_txs_lock_nonce_uq" ON "chain_txs" USING btree ("nonce_account","nonce_value") WHERE kind = 'atomic_lock';--> statement-breakpoint
CREATE INDEX "chain_txs_open_idx" ON "chain_txs" USING btree ("status","expires_at") WHERE status IN ('built','signed','sent');--> statement-breakpoint
CREATE UNIQUE INDEX "nonce_pool_leased_bet_uq" ON "nonce_pool" USING btree ("leased_bet_id") WHERE leased_bet_id IS NOT NULL;