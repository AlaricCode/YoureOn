// SCHEMAS §4 — evidence records. evidence_hash = CameraEvidence.clip_sha256 (camera),
// hashJcs(GeminiSettlementRecord) (gemini) or hashJcs(DanceEvidence) (dance_off).
import { z } from 'zod/v4';
import { DANCE_SCORER_VERSION } from './dance/score';
import { PoseSeries, POSE_MAX_FRAMES, SYNC_OFFSET_MAX_MS } from './dance/pose';
import { GeminiStrike } from './gemini';
import { hashJcs } from './jcs';
import { BetId, DecimalStr, Hex32, IsoUtc, Party } from './primitives';

export const FrameIndex = z.number().int().min(0).max(23);
export const EvidenceFrame = z.strictObject({
  /** Position in frames[]; cited_frames point here. */
  index: FrameIndex,
  /** Offset from clip start. */
  t_ms: z.number().int().nonnegative(),
  /** Of the JPEG bytes sent to the model. */
  sha256: Hex32,
  /**
   * Planning D10: this image is the landing crop (the last frame again, the middle of the
   * full-resolution still, ≤ 1024 px), not a frame of its own. At most one, always last
   * (./judge/frames judgeFramesProblem). Absent on every other frame.
   */
  landing_crop: z.literal(true).optional(),
});
export type EvidenceFrame = z.infer<typeof EvidenceFrame>;

export const CameraEvidence = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('camera'),
  bet_id: BetId,
  /** Recording number; increments on REDO. */
  attempt_no: z.number().int().min(1),
  /** = evidence_hash. Phone hashes at record end; the server re-hashes the upload and flags a mismatch. */
  clip_sha256: Hex32,
  clip_bytes: z.number().int().positive(),
  mime: z.enum(['video/mp4', 'video/quicktime']),
  /** = DATA-MODEL attempts CHECK (≤ 30 s). */
  duration_ms: z.number().int().positive().max(30_000),
  /** Whose device recorded; the judge-cam iPhone is a device of A. */
  recorded_by: Party,
  recorded_at: IsoUtc,
  /**
   * 12 per try (8..12 accepted), 8 of them in the last ~1.2 s, plus one landing crop
   * (./judge/frames, planning D10).
   */
  frames: z.array(EvidenceFrame).min(1).max(24),
});
export type CameraEvidence = z.infer<typeof CameraEvidence>;

export const GeminiSettlementRecord = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('gemini_settlement'),
  bet_id: BetId,
  terms_hash: Hex32,
  /** camelCase: mirrors Gemini's Contract. */
  contract: z.strictObject({
    eventTicker: z.string(),
    instrumentSymbol: z.string(),
    status: z.enum(['settled', 'invalid']),
    /** null iff invalid. */
    resolutionSide: z.enum(['yes', 'no']).nullable(),
    /** e.g. "75550.7195"; arbitrary precision, kept as a string. */
    settlementValue: DecimalStr.nullable(),
    strike: GeminiStrike,
    resolvedAt: IsoUtc.nullable(),
  }),
  /** GET /v1/prediction-markets/events/{eventTicker} */
  source_url: z.url(),
  /** sha256 of the raw HTTP body we parsed. */
  response_sha256: Hex32,
  fetched_at: IsoUtc,
});
export type GeminiSettlementRecord = z.infer<typeof GeminiSettlementRecord>;

// ---- Dance Off (DANCE-OFF §5) ----------------------------------------------------------------

export const DanceKeyMoveGrade = z.enum(['PERFECT', 'GOOD', 'MISS']);
export const DanceFailureReason = z.enum(['coverage_a', 'coverage_b', 'no_frames']);
/** Dance Off key frames: the phone uploads 4; a record commits 1..6. */
export const DANCE_MAX_KEY_FRAMES = 6;
/** Each dance key-frame JPEG is at most this many bytes (≤ 512 px). */
export const DANCE_FRAME_MAX_BYTES = 200_000;

const ScoreX10 = z.number().int().min(0).max(1000);
const Pct = z.number().int().min(0).max(100);

/**
 * The deterministic dance-off record (strict, hashed): evidence_hash = hashJcs(DanceEvidence).
 * The server builds it after re-scoring the uploaded PoseSeries with the shared scorer
 * (dance/evidence buildDanceEvidence); `scores` are never the client's.
 */
export const DanceEvidence = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('dance'),
  bet_id: BetId,
  attempt_no: z.number().int().min(1),
  terms_hash: Hex32,
  routine: z.strictObject({
    id: z.string().min(1).max(32),
    version: z.number().int().min(1),
    sha256: Hex32,
  }),
  scorer_version: z.literal(DANCE_SCORER_VERSION),
  /** hashJcs(PoseSeries) of the uploaded series. */
  pose_sha256: Hex32,
  pose_frames: z.number().int().min(0).max(POSE_MAX_FRAMES),
  sync_offset_ms: z.number().int().min(-SYNC_OFFSET_MAX_MS).max(SYNC_OFFSET_MAX_MS),
  /** Display scores in tenths (0..1000), server-recomputed. */
  scores: z.strictObject({ a: ScoreX10, b: ScoreX10 }),
  winner: Party.nullable(),
  too_close: z.boolean(),
  failed: DanceFailureReason.nullable(),
  key_moves: z
    .array(
      z.strictObject({ id: z.string().min(1).max(24), a: DanceKeyMoveGrade, b: DanceKeyMoveGrade }),
    )
    .max(16),
  checks: z.strictObject({
    coverage_a_pct: Pct,
    coverage_b_pct: Pct,
    max_people: z.number().int().min(0),
    side_swaps: z.number().int().min(0),
  }),
  /** The key frames uploaded (cited by the ruling's frame_hashes, in this order). */
  frames: z.array(EvidenceFrame).min(1).max(DANCE_MAX_KEY_FRAMES),
  /** sha256 of the recorded clip, when the phone kept one. */
  clip_sha256: Hex32.nullable(),
});
export type DanceEvidence = z.infer<typeof DanceEvidence>;

/** evidence_hash of a dance-off ruling. Parse with DanceEvidence first. */
export const danceEvidenceHash = (e: DanceEvidence): string => hashJcs(e);

/** One uploaded key-frame JPEG (multipart part `frame`, in this order). */
export const DanceUploadFrame = z.object({
  index: FrameIndex,
  /** ms since round t0. */
  t_ms: z.number().int().nonnegative(),
  sha256: Hex32,
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  bytes: z.number().int().min(1).max(DANCE_FRAME_MAX_BYTES),
});
export type DanceUploadFrame = z.infer<typeof DanceUploadFrame>;

/**
 * POST /v1/bets/:bet_id/attempts/:n/dance, multipart part `upload` (JSON), followed by the
 * `frame` JPEG parts. The server checks every frame's sha256 and pose_sha256 = hashJcs(series),
 * then re-scores; client_scores are kept only to flag a phone/server mismatch.
 */
export const DanceUpload = z.object({
  routine_id: z.string().min(1).max(32),
  routine_sha256: Hex32,
  series: PoseSeries,
  pose_sha256: Hex32,
  client_scores: z.object({ a: ScoreX10, b: ScoreX10 }),
  clip_sha256: Hex32.nullable(),
  frames: z.array(DanceUploadFrame).min(1).max(DANCE_MAX_KEY_FRAMES),
});
export type DanceUpload = z.infer<typeof DanceUpload>;
