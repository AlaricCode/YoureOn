CREATE TYPE "public"."actor_kind" AS ENUM('user', 'server', 'judge', 'panel', 'system');--> statement-breakpoint
CREATE TYPE "public"."appeal_decided_by" AS ENUM('majority', 'upheld_no_majority');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('filing', 'panel_voting', 'decided', 'failed');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('recording', 'uploaded', 'judging', 'ruled', 'redo', 'failed');--> statement-breakpoint
CREATE TYPE "public"."authorization_method" AS ENUM('faceid_hold', 'passcode_hold');--> statement-breakpoint
CREATE TYPE "public"."bet_end_reason" AS ENUM('refused', 'declined', 'terms_changed', 'cancelled', 'draft_idle', 'quote_expired', 'accept_timeout', 'resolve_timeout', 'appeal_timeout', 'lock_failed');--> statement-breakpoint
CREATE TYPE "public"."bet_state" AS ENUM('DRAFTING', 'TERMS_PROPOSED', 'AWAITING_AUTHORIZATIONS', 'AWAITING_LOCK', 'LOCKED', 'ATTEMPT', 'JUDGING', 'HEARING', 'AWAITING_MARKET', 'RULED', 'CONCEDED', 'FINALIZED', 'APPEALED', 'APPEAL_RESOLVED', 'PAID', 'VOIDED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."chain_event_source" AS ENUM('stream', 'rpc_poll');--> statement-breakpoint
CREATE TYPE "public"."chain_ix" AS ENUM('create_bet', 'accept_bet', 'cancel_open_bet', 'resolve', 'concede', 'appeal', 'resolve_appeal', 'finalize', 'timeout_refund', 'close_bet');--> statement-breakpoint
CREATE TYPE "public"."challenge_method" AS ENUM('face', 'list', 'link');--> statement-breakpoint
CREATE TYPE "public"."claim_result" AS ENUM('MET', 'NOT_MET', 'UNCLEAR');--> statement-breakpoint
CREATE TYPE "public"."device_role" AS ENUM('phone', 'judge_cam');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."evidence_source" AS ENUM('camera', 'gemini');--> statement-breakpoint
CREATE TYPE "public"."hearing_status" AS ENUM('open', 'closed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."hearing_trigger" AS ENUM('contested', 'max_redos', 'demo');--> statement-breakpoint
CREATE TYPE "public"."join_method" AS ENUM('code', 'qr', 'nearby', 'link', 'demo_seed');--> statement-breakpoint
CREATE TYPE "public"."liveness_method" AS ENUM('blink', 'head_turn');--> statement-breakpoint
CREATE TYPE "public"."lock_mode" AS ENUM('atomic', 'sequential');--> statement-breakpoint
CREATE TYPE "public"."market_side" AS ENUM('yes', 'no');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('approved', 'active', 'closed', 'under_review', 'settled', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."nonce_status" AS ENUM('free', 'leased', 'advancing', 'retired');--> statement-breakpoint
CREATE TYPE "public"."onchain_outcome" AS ENUM('party_a', 'party_b', 'split', 'refund');--> statement-breakpoint
CREATE TYPE "public"."onchain_status" AS ENUM('none', 'open', 'locked', 'resolved', 'appealed', 'settled', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."panel_provider" AS ENUM('anthropic', 'openai', 'google');--> statement-breakpoint
CREATE TYPE "public"."party" AS ENUM('A', 'B');--> statement-breakpoint
CREATE TYPE "public"."payout_via" AS ENUM('concede', 'finalize', 'resolve_appeal', 'timeout_refund', 'cancel_open_bet');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('ios');--> statement-breakpoint
CREATE TYPE "public"."redo_reason" AS ENUM('unclear', 'low_confidence', 'contested');--> statement-breakpoint
CREATE TYPE "public"."room_kind" AS ENUM('demo', 'nearby', 'session');--> statement-breakpoint
CREATE TYPE "public"."ruling_outcome" AS ENUM('A_WINS', 'B_WINS', 'REDO', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."ruling_stage" AS ENUM('attempt', 'settlement', 'hearing', 'appeal');--> statement-breakpoint
CREATE TYPE "public"."ruling_void_reason" AS ENUM('undecidable', 'max_redos', 'market_invalid', 'safety_stop');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tx_kind" AS ENUM('atomic_lock', 'create_bet', 'accept_bet', 'cancel_open_bet', 'resolve', 'concede', 'appeal', 'resolve_appeal', 'finalize', 'timeout_refund', 'close_bet', 'nonce_advance');--> statement-breakpoint
CREATE TYPE "public"."tx_status" AS ENUM('built', 'signed', 'sent', 'confirmed', 'failed', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."voice_purpose" AS ENUM('terms', 'hearing', 'announce');--> statement-breakpoint
CREATE TYPE "public"."vote_counted_as" AS ENUM('A_WINS', 'B_WINS', 'ABSTAIN');--> statement-breakpoint
CREATE TYPE "public"."vote_status" AS ENUM('ok', 'error', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."wallet_kind" AS ENUM('device_keypair', 'embedded_provider');--> statement-breakpoint
CREATE TABLE "api_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_sha256" text NOT NULL,
	"user_id" uuid,
	"device_id" uuid,
	"room_id" uuid,
	"scopes" text[] DEFAULT '{app}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_sessions_token_sha256_uq" UNIQUE("token_sha256"),
	CONSTRAINT "api_sessions_token_sha256_fmt" CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_sessions_scopes_known" CHECK (scopes <@ ARRAY['app','stage','demo']::text[]),
	CONSTRAINT "api_sessions_app_scope" CHECK (('app' = ANY(scopes)) = (user_id IS NOT NULL AND device_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "platform" DEFAULT 'ios' NOT NULL,
	"push_provider" text DEFAULT 'expo' NOT NULL,
	"push_token" text,
	"device_pubkey" text,
	"role" "device_role" DEFAULT 'phone' NOT NULL,
	"app_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_push_provider" CHECK (push_provider IN ('expo','apns')),
	CONSTRAINT "devices_device_pubkey_fmt" CHECK (device_pubkey ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"avatar_key" text,
	"wallet_pubkey" text,
	"wallet_kind" "wallet_kind" DEFAULT 'device_keypair' NOT NULL,
	"age_attested_18plus" boolean DEFAULT false NOT NULL,
	"attested_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"demo_seed_ciphertext" "bytea",
	"demo_seed_nonce" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_wallet_pubkey_uq" UNIQUE("wallet_pubkey"),
	CONSTRAINT "users_display_name_len" CHECK (char_length(display_name) BETWEEN 1 AND 32),
	CONSTRAINT "users_wallet_pubkey_fmt" CHECK (wallet_pubkey ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "users_attested_at" CHECK (NOT age_attested_18plus OR attested_at IS NOT NULL),
	CONSTRAINT "users_wallet_required" CHECK (is_demo OR deleted_at IS NOT NULL OR wallet_pubkey IS NOT NULL),
	CONSTRAINT "users_demo_seed_demo_only" CHECK (is_demo OR demo_seed_ciphertext IS NULL),
	CONSTRAINT "users_demo_seed_pair" CHECK ((demo_seed_ciphertext IS NULL) = (demo_seed_nonce IS NULL))
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_via" "join_method" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_members_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"kind" "room_kind" DEFAULT 'session' NOT NULL,
	"join_method" "join_method" DEFAULT 'code' NOT NULL,
	"created_by" uuid,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '12 hours' NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "rooms_code_uq" UNIQUE("code"),
	CONSTRAINT "rooms_code_fmt" CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
	CONSTRAINT "rooms_expiry" CHECK (expires_at > created_at AND expires_at <= created_at + interval '14 days')
);
--> statement-breakpoint
CREATE TABLE "bet_events" (
	"bet_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"chain_event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bet_events_pk" PRIMARY KEY("bet_id","seq"),
	CONSTRAINT "bet_events_source" CHECK (source IN ('server','chain')),
	CONSTRAINT "bet_events_source_type" CHECK ((type LIKE 'chain.%') = (source = 'chain')),
	CONSTRAINT "bet_events_seq_positive" CHECK (seq >= 1)
);
--> statement-breakpoint
CREATE TABLE "bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid,
	"party_a_id" uuid NOT NULL,
	"party_b_id" uuid NOT NULL,
	"party_a_wallet" text,
	"party_b_wallet" text,
	"lock_mode" "lock_mode" DEFAULT 'atomic' NOT NULL,
	"challenge_method" "challenge_method" DEFAULT 'face' NOT NULL,
	"supersedes_bet_id" uuid,
	"title" text,
	"evidence_source" "evidence_source",
	"state" "bet_state" DEFAULT 'DRAFTING' NOT NULL,
	"end_reason" "bet_end_reason",
	"refusal_category" text,
	"onchain_status" "onchain_status" DEFAULT 'none' NOT NULL,
	"onchain_pending" "onchain_status",
	"pending_sig" text,
	"mint" text NOT NULL,
	"stake_a" bigint,
	"stake_b" bigint,
	"terms_hash" text,
	"bet_pda" text,
	"vault" text,
	"a_position" "market_side",
	"odds_p" numeric(3, 2),
	"odds_source" text,
	"quoted_at" timestamp with time zone,
	"a_authorized_at" timestamp with time zone,
	"b_authorized_at" timestamp with time zone,
	"a_authorization_method" "authorization_method",
	"b_authorization_method" "authorization_method",
	"a_authorized_device_at" timestamp with time zone,
	"b_authorized_device_at" timestamp with time zone,
	"redo_count" smallint DEFAULT 0 NOT NULL,
	"accept_deadline" timestamp with time zone,
	"resolve_deadline" timestamp with time zone,
	"appeal_deadline" timestamp with time zone,
	"appeal_resolve_deadline" timestamp with time zone,
	"appealed_at" timestamp with time zone,
	"evidence_hash" text,
	"ruling_hash" text,
	"appeal_ruling_hash" text,
	"outcome" "onchain_outcome",
	"payout_a" bigint,
	"payout_b" bigint,
	"payout_via" "payout_via",
	"create_sig" text,
	"accept_sig" text,
	"resolve_sig" text,
	"appeal_sig" text,
	"payout_sig" text,
	"close_sig" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terms_final_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"is_seed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "bets_bet_pda_uq" UNIQUE("bet_pda"),
	CONSTRAINT "bets_vault_uq" UNIQUE("vault"),
	CONSTRAINT "bets_distinct_parties" CHECK (party_a_id <> party_b_id),
	CONSTRAINT "bets_stake_a_cap" CHECK (stake_a IS NULL OR stake_a BETWEEN 1 AND 20000000),
	CONSTRAINT "bets_stake_b_cap" CHECK (stake_b IS NULL OR stake_b BETWEEN 1 AND 20000000),
	CONSTRAINT "bets_binding_set" CHECK (state < 'AWAITING_AUTHORIZATIONS' OR state IN ('CANCELLED','EXPIRED')
        OR (terms_hash IS NOT NULL AND stake_a IS NOT NULL AND stake_b IS NOT NULL AND evidence_source IS NOT NULL)),
	CONSTRAINT "bets_onchain_binding" CHECK (onchain_status = 'none'
        OR (terms_hash IS NOT NULL AND stake_a IS NOT NULL AND stake_b IS NOT NULL)),
	CONSTRAINT "bets_wallet_snapshot" CHECK (is_seed OR onchain_status = 'none' OR party_a_wallet IS NOT NULL),
	CONSTRAINT "bets_auth_pairs" CHECK ((a_authorized_at IS NULL) = (a_authorization_method IS NULL)
        AND (b_authorized_at IS NULL) = (b_authorization_method IS NULL)),
	CONSTRAINT "bets_locked_authorized" CHECK (is_seed OR onchain_status IN ('none','open','cancelled')
        OR (onchain_status = 'refunded' AND accept_sig IS NULL)
        OR (a_authorized_at IS NOT NULL AND b_authorized_at IS NOT NULL)),
	CONSTRAINT "bets_end_reason" CHECK ((state IN ('CANCELLED','EXPIRED')) = (end_reason IS NOT NULL)),
	CONSTRAINT "bets_refusal" CHECK ((end_reason IS NOT DISTINCT FROM 'refused') = (refusal_category IS NOT NULL)),
	CONSTRAINT "bets_pending_pair" CHECK ((onchain_pending IS NULL) = (pending_sig IS NULL)),
	CONSTRAINT "bets_terminal_sig" CHECK (is_seed OR onchain_status < 'settled' OR payout_sig IS NOT NULL),
	CONSTRAINT "bets_payout_rule" CHECK (onchain_status < 'settled' OR (
        outcome IS NOT NULL AND payout_a IS NOT NULL AND payout_b IS NOT NULL
        AND CASE onchain_status
          WHEN 'cancelled' THEN payout_b = 0 AND payout_a >= stake_a
          WHEN 'refunded'  THEN (payout_b = 0 AND payout_a >= stake_a)
                             OR (payout_a = stake_a AND payout_b >= stake_b)
          ELSE payout_a + payout_b >= stake_a + stake_b AND CASE outcome
            WHEN 'party_a' THEN payout_b = 0
            WHEN 'party_b' THEN payout_a = 0
            WHEN 'refund'  THEN payout_a = stake_a
            WHEN 'split'   THEN payout_a = (payout_a + payout_b) / 2
          END
        END)),
	CONSTRAINT "bets_redo_cap" CHECK (redo_count BETWEEN 0 AND 3),
	CONSTRAINT "bets_odds_source" CHECK (odds_source IS NULL OR odds_source IN ('mid','last_in_spread')),
	CONSTRAINT "bets_odds_p_range" CHECK (odds_p IS NULL OR odds_p BETWEEN 0 AND 1),
	CONSTRAINT "bets_payout_nonneg" CHECK ((payout_a IS NULL OR payout_a >= 0) AND (payout_b IS NULL OR payout_b >= 0)),
	CONSTRAINT "bets_party_a_wallet_fmt" CHECK (party_a_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "bets_party_b_wallet_fmt" CHECK (party_b_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "bets_mint_fmt" CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "bets_bet_pda_fmt" CHECK (bet_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "bets_vault_fmt" CHECK (vault ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "bets_terms_hash_fmt" CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bets_evidence_hash_fmt" CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bets_ruling_hash_fmt" CHECK (ruling_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bets_appeal_ruling_hash_fmt" CHECK (appeal_ruling_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bets_pending_sig_fmt" CHECK (pending_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "bets_create_sig_fmt" CHECK (create_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "bets_accept_sig_fmt" CHECK (accept_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "bets_resolve_sig_fmt" CHECK (resolve_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "bets_appeal_sig_fmt" CHECK (appeal_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "bets_payout_sig_fmt" CHECK (payout_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "bets_close_sig_fmt" CHECK (close_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$')
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"bet_id" uuid,
	"subject_user_id" uuid,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_sessions" ADD CONSTRAINT "api_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_sessions" ADD CONSTRAINT "api_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_sessions" ADD CONSTRAINT "api_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bet_events" ADD CONSTRAINT "bet_events_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_party_a_id_users_id_fk" FOREIGN KEY ("party_a_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_party_b_id_users_id_fk" FOREIGN KEY ("party_b_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_supersedes_bet_id_bets_id_fk" FOREIGN KEY ("supersedes_bet_id") REFERENCES "public"."bets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_sessions_device_idx" ON "api_sessions" USING btree ("device_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_push_token_uq" ON "devices" USING btree ("push_token") WHERE push_token IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_device_pubkey_uq" ON "devices" USING btree ("device_pubkey") WHERE device_pubkey IS NOT NULL;--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "room_members_user_idx" ON "room_members" USING btree ("user_id") WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX "rooms_active_idx" ON "rooms" USING btree ("expires_at") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bet_events_chain_uq" ON "bet_events" USING btree ("chain_event_id") WHERE chain_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bets_a_idx" ON "bets" USING btree ("party_a_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bets_b_idx" ON "bets" USING btree ("party_b_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bets_room_idx" ON "bets" USING btree ("room_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bets_active_idx" ON "bets" USING btree ("state") WHERE state < 'PAID';--> statement-breakpoint
CREATE INDEX "bets_pending_idx" ON "bets" USING btree ("updated_at") WHERE onchain_pending IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bets_h2h_idx" ON "bets" USING btree ("party_a_id","party_b_id") WHERE onchain_status = 'settled';--> statement-breakpoint
CREATE INDEX "bets_h2h_rev_idx" ON "bets" USING btree ("party_b_id","party_a_id") WHERE onchain_status = 'settled';--> statement-breakpoint
CREATE INDEX "audit_bet_idx" ON "audit_log" USING btree ("bet_id","at") WHERE bet_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_log" USING btree ("subject_user_id","at") WHERE subject_user_id IS NOT NULL;