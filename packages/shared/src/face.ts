// Face enrollment and face match, API-CONTRACT §2.2 and §2.4 (TASKS D3-M3, D4-M1): the wire
// shapes the phone and the server share, the v1 consent text (the server serves it; the phone's
// preview stand-in reuses it), and the room-scoped match rule (DATA-MODEL §7.2).
//
// Biometric data rules (DATA-MODEL §10): only embeddings travel, never images; a probe is never
// stored; "no confident match" returns nothing and stores nothing.
import { z } from 'zod/v4';

import { HeadToHead, SealedEmbedding } from './api';
import { IsoUtc, Uuid, UserRef, sha256Hex } from './primitives';

// ---------------------------------------------------------------------------------------
// Consent (face-consent-v1)
// ---------------------------------------------------------------------------------------

/**
 * DRAFT v1 text (TASKS D3-M3 step 2: E2 writes it; a teammate checks it against the FINDINGS §6
 * step 16 legal re-read). Facts from ARCHITECTURE §6.7 and DATA-MODEL §10. Not legal advice.
 * Changing a single character is a new consent: bump the version.
 */
export const FACE_CONSENT_V1 = {
  consent_version: 'face-consent-v1',
  text:
    "Face matching is optional. If you turn it on, You're On uses your face so friends in the same " +
    'room can challenge you by pointing their camera at you. A match only picks who is being ' +
    'challenged. It never moves money or confirms a bet; Face ID does that. ' +
    'Your phone turns three photos of you into a face template (a list of numbers). The photos never ' +
    'leave your phone. We keep one encrypted template, never sell or share it, and only compare it ' +
    'with people in rooms you join. ' +
    'You can turn matching off or delete your template at any time. We delete it automatically ' +
    '180 days after it was last used, 30 days after you turn matching off, or on December 31, 2026, ' +
    'whichever comes first.',
  retention_summary:
    'Deleted 180 days after last use, 30 days after you turn it off, or on December 31, 2026.',
} as const;

export const FACE_CONSENT_V1_SHA256: string = sha256Hex(FACE_CONSENT_V1.text);

// ---------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------

export const FaceModelRef = z.strictObject({
  name: z.string().min(1).max(40),
  version: z.string().min(1).max(40),
  dim: z.number().int().min(64).max(1024),
});
export type FaceModelRef = z.infer<typeof FaceModelRef>;

/** What the server matches today: the bundled InsightFace buffalo_s w600k_mbf (FINDINGS §3.2). */
export const ACCEPTED_FACE_MODELS: readonly FaceModelRef[] = [
  { name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 },
];

export const isAcceptedModel = (m: FaceModelRef): boolean =>
  ACCEPTED_FACE_MODELS.some((a) => a.name === m.name && a.version === m.version && a.dim === m.dim);

// ---------------------------------------------------------------------------------------
// §2.2 enrollment
// ---------------------------------------------------------------------------------------

export const FaceConsentResponse = z.object({
  consent_version: z.string(),
  text: z.string(),
  text_sha256: z.string(),
  retention_summary: z.string(),
  /** x25519 public key for sealed embeddings; null while only `plain-v0` is served. */
  face_seal_pubkey: z.string().nullable(),
  accepted_models: z.array(FaceModelRef),
});
export type FaceConsentResponse = z.infer<typeof FaceConsentResponse>;

export const FaceEnrollmentRequest = z.strictObject({
  consent: z.strictObject({
    consent_version: z.string().min(1).max(40),
    consent_text_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    consent_at: IsoUtc,
  }),
  liveness: z.strictObject({ method: z.enum(['blink', 'head_turn']), passed_at: IsoUtc }),
  model: FaceModelRef,
  embedding: SealedEmbedding,
  shots: z.number().int().min(1).max(5),
});
export type FaceEnrollmentRequest = z.infer<typeof FaceEnrollmentRequest>;

export const FaceEnrollmentResponse = z.object({
  status: z.literal('active'),
  enrolled_at: IsoUtc,
});
export type FaceEnrollmentResponse = z.infer<typeof FaceEnrollmentResponse>;

export const FaceEnrollmentPatch = z.strictObject({ status: z.enum(['active', 'disabled']) });
export type FaceEnrollmentPatch = z.infer<typeof FaceEnrollmentPatch>;

export const FaceStatus = z.enum(['none', 'active', 'disabled']);
export type FaceStatus = z.infer<typeof FaceStatus>;

/** §2.1 GET /v1/me */
export const MeResponse = z.object({
  user: UserRef,
  age_attested_18plus: z.boolean(),
  face: z.object({ status: FaceStatus, consent_version: z.string().nullable() }),
  devices: z.array(
    z.object({
      device_id: Uuid,
      role: z.string(),
      app_version: z.string().nullable(),
      last_seen_at: IsoUtc.nullable(),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------------------------------------------------------------------------------------
// §2.4 face match
// ---------------------------------------------------------------------------------------

export const FaceMatchRequest = z.strictObject({
  probe: SealedEmbedding,
  model: FaceModelRef,
  capture: z.strictObject({
    captured_at: IsoUtc,
    eye_distance_px: z.number().nonnegative().nullable(),
    yaw_deg: z.number().min(-90).max(90).nullable(),
  }),
});
export type FaceMatchRequest = z.infer<typeof FaceMatchRequest>;

export const FaceMatchResponse = z.object({
  match: z
    .object({
      user: UserRef,
      match_ticket: z.string().min(1).max(512),
      ticket_expires_at: IsoUtc,
      head_to_head: HeadToHead,
    })
    .nullable(),
});
export type FaceMatchResponse = z.infer<typeof FaceMatchResponse>;

/** A match ticket lives 60 s and can only address one challenge (§2.4). */
export const MATCH_TICKET_TTL_MS = 60_000;

// ---------------------------------------------------------------------------------------
// Match rule (DATA-MODEL §7.2, FINDINGS §3.2)
// ---------------------------------------------------------------------------------------

export const FACE_MATCH_RULE = {
  /** top-1 cosine must reach this… */
  minCosine: 0.3,
  /** …and beat top-2 by at least this; otherwise abstain. */
  minMargin: 0.05,
  /** Room candidate cap (DATA-MODEL §7.2 LIMIT 50). */
  maxCandidates: 50,
} as const;

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`cosine: length ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Picks the candidate a probe matches, or null to abstain. Accept top-1 only if its cosine is at
 * least `minCosine` and it beats top-2 by at least `minMargin`. With a single candidate there is
 * no runner-up, so top-2 counts as 0 (an unrelated face scores about 0). No score leaves here.
 */
export function decideFaceMatch<T>(
  probe: Float32Array,
  candidates: readonly { id: T; embedding: Float32Array }[],
  rule: { minCosine: number; minMargin: number } = FACE_MATCH_RULE,
): T | null {
  let best: { id: T; cos: number } | null = null;
  let second = 0;
  for (const c of candidates) {
    const cos = cosine(probe, c.embedding);
    if (!best || cos > best.cos) {
      if (best) second = Math.max(second, best.cos);
      best = { id: c.id, cos };
    } else {
      second = Math.max(second, cos);
    }
  }
  if (!best) return null;
  if (best.cos < rule.minCosine) return null;
  if (best.cos - second < rule.minMargin) return null;
  return best.id;
}

/** float32 little-endian bytes ⇄ Float32Array, the plaintext of every embedding. */
export function float32FromLe(bytes: Uint8Array): Float32Array {
  if (bytes.length % 4 !== 0) throw new Error('float32 bytes: length not a multiple of 4');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function float32ToLe(v: Float32Array): Uint8Array {
  const bytes = new Uint8Array(v.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i] as number, true);
  return bytes;
}

/** True when every value is finite and the vector has (about) unit length. */
export function isUnitVector(v: Float32Array, tolerance = 1e-3): boolean {
  let n = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) return false;
    n += x * x;
  }
  return Math.abs(Math.sqrt(n) - 1) <= tolerance;
}
