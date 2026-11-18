CREATE TABLE "face_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "enrollment_status" DEFAULT 'active' NOT NULL,
	"embedding_ciphertext" "bytea" NOT NULL,
	"embedding_nonce" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"embedding_dim" smallint NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"consent_version" text NOT NULL,
	"consent_text_sha256" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"liveness_method" "liveness_method" NOT NULL,
	"liveness_passed_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "face_enrollments_user_uq" UNIQUE("user_id"),
	CONSTRAINT "face_enrollments_nonce_len" CHECK (octet_length("face_enrollments"."embedding_nonce") = 12),
	CONSTRAINT "face_enrollments_dim" CHECK ("face_enrollments"."embedding_dim" BETWEEN 64 AND 1024),
	CONSTRAINT "face_enrollments_ct_len" CHECK (octet_length("face_enrollments"."embedding_ciphertext") = "face_enrollments"."embedding_dim" * 4 + 16),
	CONSTRAINT "face_enrollments_consent_before" CHECK ("face_enrollments"."consent_at" <= "face_enrollments"."created_at"),
	CONSTRAINT "face_enrollments_disabled_at" CHECK (("face_enrollments"."status" = 'disabled') = ("face_enrollments"."disabled_at" IS NOT NULL)),
	CONSTRAINT "face_enrollments_consent_text_sha256_fmt" CHECK (consent_text_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD CONSTRAINT "face_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "face_enrollments_match_idx" ON "face_enrollments" USING btree ("model_name","model_version") WHERE "face_enrollments"."status" = 'active';