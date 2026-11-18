// DATA-MODEL §5.12 attempts, §5.13 rulings, plus attempt_frames (added by migration 0005, the
// judge pipeline, Beat 4).
//
// - attempts: one row per recording (attempt_no starts at 1; a REDO adds a row). The evidence
//   record (SCHEMAS CameraEvidence) is stored byte for byte as JCS in evidence_canonical;
//   frame_hashes are what the ruling commits to (SCHEMAS O3, D7).
// - attempt_frames: the JPEG bytes the model was sent, in send order. Object storage
//   (DATA-MODEL §9, Tigris/R2) is not wired yet, so the frames live in Postgres (≤ 12 × 200 KB
//   per attempt) for the stage view and later stages (hearing, appeal). frame_keys on attempts
//   stays '{}' until the object store lands.
// - rulings: record_canonical is the JCS of the SCHEMAS record and ruling_hash = its sha256
//   (CHECKed). hearing_id has no FK yet (the hearing is cut, D-C); appeal_id -> appeals
//   (migration 0008).
// - appeals / appeal_votes (DATA-MODEL §5.15, migration 0008, Beat 5): one appeal per bet, three
//   votes (one per provider). The decided AppealResult itself is the stage='appeal' rulings row
//   (result_ruling_id): its record_canonical is what appeal_ruling_hash commits to.
//
// Deviations from DATA-MODEL, on purpose: attempts gains recorder / max_ms / go_at (to replay
// the POST …/attempts 201 idempotently) and its frame CHECK compares frame_ts_ms with
// frame_hashes (frame_keys may be empty until object storage lands).
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  appealDecidedBy,
  appealStatus,
  attemptStatus,
  chainIx,
  claimResult,
  evidenceSource,
  panelProvider,
  party,
  redoReason,
  rulingOutcome,
  rulingStage,
  rulingVoidReason,
  voteCountedAs,
  voteStatus,
} from './enums';
import { hex32Check } from './checks';
import { bytea, tstz } from './types';
import { bets } from './bets';
import { devices, users } from './users';

export const attempts = pgTable(
  'attempts',
  {
    id: uuid().primaryKey().defaultRandom(),
    bet_id: uuid()
      .notNull()
      .references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    attempt_no: smallint().notNull(),
    recorded_by_user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id),
    recorded_by_device_id: uuid().references((): AnyPgColumn => devices.id),
    /** API-CONTRACT §2.9 `recorder`: the room's judge cam, or the non-performer's own phone. */
    recorder: text().notNull().default('judge_cam'),
    status: attemptStatus().notNull().default('recording'),
    /** 6000 × terms.attempts.count (API-CONTRACT §2.9). */
    max_ms: integer().notNull(),
    /** When the judge cam's 3-2-1 ends. */
    go_at: tstz().notNull(),
    clip_key: text(),
    clip_mime: text(),
    clip_bytes: integer(),
    duration_ms: integer(),
    /** = CameraEvidence.clip_sha256 = the onchain evidence_hash (DATA-MODEL §9). */
    client_clip_hash: text(),
    /** sha256(stored clip bytes), recomputed after the clip upload. */
    evidence_hash: text(),
    /** JCS of the SCHEMAS CameraEvidence record. */
    evidence_canonical: text(),
    frame_keys: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    frame_ts_ms: integer()
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    /** sha256 of each frame = CameraEvidence.frames[i].sha256, in send order. */
    frame_hashes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    started_at: tstz().notNull().defaultNow(),
    uploaded_at: tstz(),
    purged_at: tstz(),
  },
  (t) => [
    uniqueIndex('attempts_bet_no_uq').on(t.bet_id, t.attempt_no),
    check('attempts_no_positive', sql`attempt_no >= 1`),
    check('attempts_recorder', sql`recorder IN ('judge_cam','self')`),
    check('attempts_max_ms', sql`max_ms > 0`),
    check(
      'attempts_clip_mime',
      sql`clip_mime IS NULL OR clip_mime IN ('video/mp4','video/quicktime')`,
    ),
    check('attempts_clip_bytes', sql`clip_bytes IS NULL OR clip_bytes BETWEEN 1 AND 26214400`),
    check('attempts_duration', sql`duration_ms IS NULL OR duration_ms BETWEEN 1 AND 30000`),
    check(
      'attempts_frames',
      sql`cardinality(frame_ts_ms) = cardinality(frame_hashes) AND cardinality(frame_hashes) <= 24
        AND (cardinality(frame_keys) = 0 OR cardinality(frame_keys) = cardinality(frame_hashes))`,
    ),
    check(
      'attempts_frame_hashes_fmt',
      sql.raw(`array_to_string(frame_hashes, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'`),
    ),
    hex32Check('attempts', 'client_clip_hash'),
    hex32Check('attempts', 'evidence_hash'),
  ],
);

export const attemptFrames = pgTable(
  'attempt_frames',
  {
    attempt_id: uuid()
      .notNull()
      .references((): AnyPgColumn => attempts.id, { onDelete: 'cascade' }),
    /** = CameraEvidence.frames[].index (send order). */
    idx: smallint().notNull(),
    t_ms: integer().notNull(),
    sha256: text().notNull(),
    mime: text().notNull().default('image/jpeg'),
    bytes: bytea().notNull(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'attempt_frames_pk', columns: [t.attempt_id, t.idx] }),
    check('attempt_frames_idx', sql`idx BETWEEN 0 AND 23`),
    check('attempt_frames_t_ms', sql`t_ms >= 0`),
    check('attempt_frames_mime', sql`mime = 'image/jpeg'`),
    check('attempt_frames_size', sql`octet_length(bytes) BETWEEN 1 AND 204800`),
    check('attempt_frames_hash', sql`sha256 = encode(sha256(bytes), 'hex')`),
    hex32Check('attempt_frames', 'sha256'),
  ],
);

export const rulings = pgTable(
  'rulings',
  {
    id: uuid().primaryKey().defaultRandom(),
    bet_id: uuid()
      .notNull()
      .references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    stage: rulingStage().notNull(),
    attempt_id: uuid().references((): AnyPgColumn => attempts.id),
    /** FK to hearings comes with the hearing stream. */
    hearing_id: uuid(),
    /** The appeal whose AppealResult this stage='appeal' row holds (migration 0008). */
    appeal_id: uuid().references((): AnyPgColumn => appeals.id),
    model: text().notNull(),
    outcome: rulingOutcome().notNull(),
    claim_result: claimResult(),
    redo_reason: redoReason(),
    void_reason: rulingVoidReason(),
    confidence: numeric({ precision: 3, scale: 2 }),
    reason: text(),
    cited_frames: smallint()
      .array()
      .notNull()
      .default(sql`'{}'::smallint[]`),
    frame_hashes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    evidence_kind: evidenceSource().notNull(),
    evidence_hash: text().notNull(),
    evidence_canonical: text(),
    /** JCS of the SCHEMAS record, byte for byte. Never rebuilt from columns. */
    record_canonical: text().notNull(),
    ruling_hash: text().notNull(),
    onchain_ix: chainIx(),
    /** Frames received -> ruling decided. */
    latency_ms: integer(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rulings_ruling_hash_uq').on(t.ruling_hash),
    uniqueIndex('rulings_attempt_uq')
      .on(t.attempt_id)
      .where(sql`attempt_id IS NOT NULL`),
    uniqueIndex('rulings_hearing_uq')
      .on(t.hearing_id)
      .where(sql`hearing_id IS NOT NULL`),
    uniqueIndex('rulings_appeal_uq')
      .on(t.appeal_id)
      .where(sql`appeal_id IS NOT NULL`),
    // One Gemini settlement ruling per bet (migration 0007): the settlement keeper is idempotent.
    uniqueIndex('rulings_settlement_uq').on(t.bet_id).where(sql.raw(`stage = 'settlement'`)),
    uniqueIndex('rulings_bet_onchain_ix_uq')
      .on(t.bet_id, t.onchain_ix)
      .where(sql`onchain_ix IS NOT NULL`),
    index('rulings_bet_idx').on(t.bet_id, t.created_at),
    check('rulings_attempt_stage', sql.raw(`(stage = 'attempt') = (attempt_id IS NOT NULL)`)),
    check('rulings_hearing_stage', sql.raw(`(stage = 'hearing') = (hearing_id IS NOT NULL)`)),
    check('rulings_appeal_stage', sql.raw(`(stage = 'appeal') = (appeal_id IS NOT NULL)`)),
    check('rulings_redo_reason', sql.raw(`(outcome = 'REDO') = (redo_reason IS NOT NULL)`)),
    check('rulings_void_reason', sql.raw(`(outcome = 'VOID') = (void_reason IS NOT NULL)`)),
    check('rulings_confidence', sql`confidence IS NULL OR confidence BETWEEN 0 AND 1`),
    check('rulings_reason_len', sql`reason IS NULL OR char_length(reason) <= 280`),
    check('rulings_frames_max', sql`cardinality(frame_hashes) <= 24`),
    check('rulings_cited_max', sql`cardinality(cited_frames) <= 8`),
    check(
      'rulings_ruling_hash',
      sql`ruling_hash = encode(sha256(convert_to(record_canonical, 'UTF8')), 'hex')`,
    ),
    check(
      'rulings_evidence_canonical',
      sql`evidence_canonical IS NULL
        OR evidence_hash = encode(sha256(convert_to(evidence_canonical, 'UTF8')), 'hex')`,
    ),
    check(
      'rulings_onchain_ix',
      sql.raw(
        `onchain_ix IS NULL OR (onchain_ix IN ('resolve','resolve_appeal') AND outcome <> 'REDO')`,
      ),
    ),
    hex32Check('rulings', 'evidence_hash'),
    hex32Check('rulings', 'ruling_hash'),
  ],
);

/**
 * DATA-MODEL §5.15 `appeals` (migration 0008): one per bet (the program allows one appeal).
 * filing (the loser's `appeal` tx is out) -> panel_voting (Appealed confirmed) -> decided (the
 * AppealResult is hashed into result_ruling_id); failed = the `appeal` tx never landed (its votes
 * are discarded). A failed row is re-filed in place (bet_id stays UNIQUE).
 */
export const appeals = pgTable(
  'appeals',
  {
    id: uuid().primaryKey().defaultRandom(),
    bet_id: uuid()
      .notNull()
      .references((): AnyPgColumn => bets.id, { onDelete: 'cascade' }),
    /** The loser of a decisive original ruling, or either party of a VOID (onchain Refund). */
    appellant_user_id: uuid()
      .notNull()
      .references((): AnyPgColumn => users.id),
    appellant_party: party().notNull(),
    /** The ruling `resolve` committed (bets.ruling_hash). */
    appealed_ruling_id: uuid()
      .notNull()
      .references((): AnyPgColumn => rulings.id),
    /** = SCHEMAS Appealable. */
    original_outcome: rulingOutcome().notNull(),
    status: appealStatus().notNull().default('filing'),
    filed_at: tstz().notNull().defaultNow(),
    decided_at: tstz(),
    final_outcome: rulingOutcome(),
    decided_by: appealDecidedBy(),
    flipped: boolean(),
    /** The stage='appeal' rulings row holding the hashed AppealResult. */
    result_ruling_id: uuid().references((): AnyPgColumn => rulings.id),
  },
  (t) => [
    uniqueIndex('appeals_bet_uq').on(t.bet_id),
    check('appeals_original_outcome', sql.raw(`original_outcome IN ('A_WINS','B_WINS','VOID')`)),
    check(
      'appeals_final_outcome',
      sql.raw(`final_outcome IS NULL OR final_outcome IN ('A_WINS','B_WINS','VOID')`),
    ),
    check(
      'appeals_decided',
      sql.raw(`(status = 'decided') = (decided_at IS NOT NULL AND final_outcome IS NOT NULL
        AND decided_by IS NOT NULL AND flipped IS NOT NULL AND result_ruling_id IS NOT NULL)`),
    ),
    check(
      'appeals_flipped',
      sql.raw(`flipped IS NULL OR flipped = (final_outcome IS DISTINCT FROM original_outcome)`),
    ),
  ],
);

/**
 * DATA-MODEL §5.15 `appeal_votes` (migration 0008): the three panel votes, one per seat and per
 * provider (SCHEMAS AppealVote). A failed seat (error / timeout) is stored as REDO, confidence
 * 0, reason '' and counts as ABSTAIN.
 */
export const appealVotes = pgTable(
  'appeal_votes',
  {
    id: uuid().primaryKey().defaultRandom(),
    appeal_id: uuid()
      .notNull()
      .references((): AnyPgColumn => appeals.id, { onDelete: 'cascade' }),
    seat: smallint().notNull(),
    provider: panelProvider().notNull(),
    /** "<provider>/<model-id>". */
    model: text().notNull(),
    status: voteStatus().notNull(),
    outcome: rulingOutcome().notNull(),
    counted_as: voteCountedAs().notNull(),
    confidence: numeric({ precision: 3, scale: 2 }).notNull(),
    reason: text().notNull().default(''),
    /** sha256 of the raw model text ('' when there was none). */
    output_sha256: text().notNull(),
    latency_ms: integer(),
    created_at: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('appeal_votes_seat_uq').on(t.appeal_id, t.seat),
    uniqueIndex('appeal_votes_provider_uq').on(t.appeal_id, t.provider),
    check('appeal_votes_seat', sql`seat BETWEEN 0 AND 2`),
    check('appeal_votes_outcome', sql.raw(`outcome IN ('A_WINS','B_WINS','REDO')`)),
    check('appeal_votes_confidence', sql`confidence BETWEEN 0 AND 1`),
    check('appeal_votes_reason_len', sql`char_length(reason) <= 280`),
    check(
      'appeal_votes_failed',
      sql.raw(`status = 'ok' OR (outcome = 'REDO' AND confidence = 0 AND reason = ''
        AND counted_as = 'ABSTAIN')`),
    ),
    check('appeal_votes_latency', sql`latency_ms IS NULL OR latency_ms >= 0`),
    hex32Check('appeal_votes', 'output_sha256'),
  ],
);
