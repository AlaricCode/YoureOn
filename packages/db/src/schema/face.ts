// DATA-MODEL §5.3 face_enrollments (migration 0006). One row per user who opted in to face
// matching. No images, ever: the row holds one AES-256-GCM encrypted, L2-normalized float32-LE
// embedding (ciphertext ‖ 16-byte tag) under a KEK named by `key_id` (DATA-MODEL §10). Only the
// server's face module (apps/server/src/face) reads or writes it. Deletion is a hard DELETE.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { enrollmentStatus, livenessMethod } from './enums';
import { hex32Check } from './checks';
import { bytea, tstz } from './types';
import { users } from './users';

export const faceEnrollments = pgTable(
  'face_enrollments',
  {
    id: uuid().primaryKey().defaultRandom(),
    user_id: uuid()
      .notNull()
      .unique('face_enrollments_user_id_uq')
      .references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
    status: enrollmentStatus().notNull().default('active'),
    embedding_ciphertext: bytea().notNull(),
    embedding_nonce: bytea().notNull(),
    key_id: text().notNull(),
    embedding_dim: smallint().notNull(),
    model_name: text().notNull(),
    model_version: text().notNull(),
    consent_version: text().notNull(),
    consent_text_sha256: text().notNull(),
    consent_at: tstz().notNull(),
    liveness_method: livenessMethod().notNull(),
    liveness_passed_at: tstz().notNull(),
    /** Day of the last match against this user (truncated to the day); drives retention. */
    last_used_at: tstz(),
    disabled_at: tstz(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    check('face_enrollments_nonce_len', sql`octet_length(embedding_nonce) = 12`),
    check('face_enrollments_dim', sql`embedding_dim BETWEEN 64 AND 1024`),
    check(
      'face_enrollments_ciphertext_len',
      sql`octet_length(embedding_ciphertext) = embedding_dim * 4 + 16`,
    ),
    check('face_enrollments_consent_before_capture', sql`consent_at <= created_at`),
    check('face_enrollments_disabled_at', sql`(status = 'disabled') = (disabled_at IS NOT NULL)`),
    hex32Check('face_enrollments', 'consent_text_sha256'),
    // §7.2 candidate query: active rows of one model, joined by user_id.
    index('face_enrollments_active_model_idx')
      .on(t.model_name, t.model_version, t.user_id)
      .where(sql`status = 'active'`),
  ],
);
