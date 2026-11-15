// SCHEMAS §4 — evidence records. evidence_hash = CameraEvidence.clip_sha256 (camera) or
// hashJcs(GeminiSettlementRecord) (gemini).
import { z } from 'zod/v4';
import { GeminiStrike } from './gemini';
import { BetId, DecimalStr, Hex32, IsoUtc, Party } from './primitives';

export const FrameIndex = z.number().int().min(0).max(23);
export const EvidenceFrame = z.strictObject({
  /** Position in frames[]; cited_frames point here. */
  index: FrameIndex,
  /** Offset from clip start. */
  t_ms: z.number().int().nonnegative(),
  /** Of the JPEG bytes sent to the model. */
  sha256: Hex32,
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
  /** ~8 per try, always including the final frames. */
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
