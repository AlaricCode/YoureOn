// DATA-MODEL §5.3 face_enrollments (TASKS D3-M3, D4-M1). One row per opted-in user; no images,
// ever. The embedding is stored only as AES-256-GCM ciphertext (apps/server/src/face/crypto.ts,
// DATA-MODEL §10): ciphertext ‖ 16-byte tag of the float32-LE, L2-normalised vector.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { enrollmentStatus, livenessMethod } from './enums';
import { hex32Check } from './checks';
import { bytea, tstz } from './types';
import { users } from './users';

export const faceEnrollments = pgTable(
  'face_enrollments',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Re-enrolling deletes the old row and inserts a new one. */
    user_id: uuid()
      .notNull()
      .unique('face_enrollments_user_uq')
      .references(() => users.id, { onDelete: 'cascade' }),
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
    /** Day-truncated date of the last match against this user; drives retention (§10). */
    last_used_at: tstz(),
    disabled_at: tstz(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    check('face_enrollments_nonce_len', sql`octet_length(${t.embedding_nonce}) = 12`),
    check('face_enrollments_dim', sql`${t.embedding_dim} BETWEEN 64 AND 1024`),
    check(
      'face_enrollments_ct_len',
      sql`octet_length(${t.embedding_ciphertext}) = ${t.embedding_dim} * 4 + 16`,
    ),
    check('face_enrollments_consent_before', sql`${t.consent_at} <= ${t.created_at}`),
    check(
      'face_enrollments_disabled_at',
      sql`(${t.status} = 'disabled') = (${t.disabled_at} IS NOT NULL)`,
    ),
    hex32Check('face_enrollments', 'consent_text_sha256'),
    index('face_enrollments_match_idx')
      .on(t.model_name, t.model_version)
      .where(sql`${t.status} = 'active'`),
  ],
);
