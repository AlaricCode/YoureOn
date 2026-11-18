-- Migration 0005 (judge pipeline, Beat 4): attempts, attempt_frames, rulings (DATA-MODEL §5.12,
-- §5.13) and devices.judge_room_id (the room a judge_cam device is bound to, API-CONTRACT §2.15).
-- Numbered 0005 on purpose: 0004 belongs to the server-chain stream. Nothing here depends on
-- 0004, so the two apply in either order; the journal `when` (1795000000000) is set later than
-- 0004's so drizzle's migrator (which skips entries older than the last applied one) applies both.
CREATE TABLE "attempt_frames" (
	"attempt_id" uuid NOT NULL,
	"idx" smallint NOT NULL,
	"t_ms" integer NOT NULL,
	"sha256" text NOT NULL,
	"mime" text DEFAULT 'image/jpeg' NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_frames_pk" PRIMARY KEY("attempt_id","idx"),
	CONSTRAINT "attempt_frames_idx" CHECK (idx BETWEEN 0 AND 23),
	CONSTRAINT "attempt_frames_t_ms" CHECK (t_ms >= 0),
	CONSTRAINT "attempt_frames_mime" CHECK (mime = 'image/jpeg'),
	CONSTRAINT "attempt_frames_size" CHECK (octet_length(bytes) BETWEEN 1 AND 204800),
	CONSTRAINT "attempt_frames_hash" CHECK (sha256 = encode(sha256(bytes), 'hex')),
	CONSTRAINT "attempt_frames_sha256_fmt" CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"attempt_no" smallint NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_by_device_id" uuid,
	"recorder" text DEFAULT 'judge_cam' NOT NULL,
	"status" "attempt_status" DEFAULT 'recording' NOT NULL,
	"max_ms" integer NOT NULL,
	"go_at" timestamp with time zone NOT NULL,
	"clip_key" text,
	"clip_mime" text,
	"clip_bytes" integer,
	"duration_ms" integer,
	"client_clip_hash" text,
	"evidence_hash" text,
	"evidence_canonical" text,
	"frame_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"frame_ts_ms" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"frame_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "attempts_no_positive" CHECK (attempt_no >= 1),
	CONSTRAINT "attempts_recorder" CHECK (recorder IN ('judge_cam','self')),
	CONSTRAINT "attempts_max_ms" CHECK (max_ms > 0),
	CONSTRAINT "attempts_clip_mime" CHECK (clip_mime IS NULL OR clip_mime IN ('video/mp4','video/quicktime')),
	CONSTRAINT "attempts_clip_bytes" CHECK (clip_bytes IS NULL OR clip_bytes BETWEEN 1 AND 26214400),
	CONSTRAINT "attempts_duration" CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 30000),
	CONSTRAINT "attempts_frames" CHECK (cardinality(frame_ts_ms) = cardinality(frame_hashes) AND cardinality(frame_hashes) <= 24
        AND (cardinality(frame_keys) = 0 OR cardinality(frame_keys) = cardinality(frame_hashes))),
	CONSTRAINT "attempts_frame_hashes_fmt" CHECK (array_to_string(frame_hashes, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
	CONSTRAINT "attempts_client_clip_hash_fmt" CHECK (client_clip_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attempts_evidence_hash_fmt" CHECK (evidence_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "rulings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"stage" "ruling_stage" NOT NULL,
	"attempt_id" uuid,
	"hearing_id" uuid,
	"appeal_id" uuid,
	"model" text NOT NULL,
	"outcome" "ruling_outcome" NOT NULL,
	"claim_result" "claim_result",
	"redo_reason" "redo_reason",
	"void_reason" "ruling_void_reason",
	"confidence" numeric(3, 2),
	"reason" text,
	"cited_frames" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"frame_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_kind" "evidence_source" NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence_canonical" text,
	"record_canonical" text NOT NULL,
	"ruling_hash" text NOT NULL,
	"onchain_ix" "chain_ix",
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rulings_attempt_stage" CHECK ((stage = 'attempt') = (attempt_id IS NOT NULL)),
	CONSTRAINT "rulings_hearing_stage" CHECK ((stage = 'hearing') = (hearing_id IS NOT NULL)),
	CONSTRAINT "rulings_appeal_stage" CHECK ((stage = 'appeal') = (appeal_id IS NOT NULL)),
	CONSTRAINT "rulings_redo_reason" CHECK ((outcome = 'REDO') = (redo_reason IS NOT NULL)),
	CONSTRAINT "rulings_void_reason" CHECK ((outcome = 'VOID') = (void_reason IS NOT NULL)),
	CONSTRAINT "rulings_confidence" CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
	CONSTRAINT "rulings_reason_len" CHECK (reason IS NULL OR char_length(reason) <= 280),
	CONSTRAINT "rulings_frames_max" CHECK (cardinality(frame_hashes) <= 24),
	CONSTRAINT "rulings_cited_max" CHECK (cardinality(cited_frames) <= 8),
	CONSTRAINT "rulings_ruling_hash" CHECK (ruling_hash = encode(sha256(convert_to(record_canonical, 'UTF8')), 'hex')),
	CONSTRAINT "rulings_evidence_canonical" CHECK (evidence_canonical IS NULL
        OR evidence_hash = encode(sha256(convert_to(evidence_canonical, 'UTF8')), 'hex')),
	CONSTRAINT "rulings_onchain_ix" CHECK (onchain_ix IS NULL OR (onchain_ix IN ('resolve','resolve_appeal') AND outcome <> 'REDO')),
	CONSTRAINT "rulings_evidence_hash_fmt" CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rulings_ruling_hash_fmt" CHECK (ruling_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "judge_room_id" uuid;--> statement-breakpoint
ALTER TABLE "attempt_frames" ADD CONSTRAINT "attempt_frames_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_recorded_by_device_id_devices_id_fk" FOREIGN KEY ("recorded_by_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rulings" ADD CONSTRAINT "rulings_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rulings" ADD CONSTRAINT "rulings_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_bet_no_uq" ON "attempts" USING btree ("bet_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "rulings_ruling_hash_uq" ON "rulings" USING btree ("ruling_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "rulings_attempt_uq" ON "rulings" USING btree ("attempt_id") WHERE attempt_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rulings_hearing_uq" ON "rulings" USING btree ("hearing_id") WHERE hearing_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rulings_appeal_uq" ON "rulings" USING btree ("appeal_id") WHERE appeal_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rulings_bet_onchain_ix_uq" ON "rulings" USING btree ("bet_id","onchain_ix") WHERE onchain_ix IS NOT NULL;--> statement-breakpoint
CREATE INDEX "rulings_bet_idx" ON "rulings" USING btree ("bet_id","created_at");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_judge_room_id_rooms_id_fk" FOREIGN KEY ("judge_room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_judge_room_role" CHECK (judge_room_id IS NULL OR role = 'judge_cam');