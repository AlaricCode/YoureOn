// Face addressing (Beat 1): the wire contract and the pure math both sides share.
// BRIEF 5e; API-CONTRACT §2.2 (enrollment), §2.4 (face-match); DATA-MODEL §5.3, §7.2, §10.
//
// A face match only ADDRESSES a challenge. It never authorizes anything: the person found still
// reviews the terms and authorizes their own stake on their own phone (D1/D7/D9).
//
// The phone computes the embedding (InsightFace w600k_mbf, 512 floats, L2-normalized) and sends
// only that, never an image. `plain-v0` sends the float32-LE bytes in `ct_b64` over TLS; the
// sealed form (x25519 + chacha20poly1305, API-CONTRACT O8) is not built yet, so servers run with
// FACE_SEAL_REQUIRED=false. Import by subpath: `@youre-on/shared/face`.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod/v4';
import { FaceModelRef, HeadToHead, SealedEmbedding } from './api';
import { Hex32, IsoUtc, UserRef } from './primitives';

// ---------------------------------------------------------------------------------------
// Consent (API-CONTRACT §2.2 GET /v1/face/consent; DATA-MODEL §10 "Consent before capture")
// ---------------------------------------------------------------------------------------

export const FACE_CONSENT_VERSION = 'face-consent-v1';

/**
 * The consent text, version `face-consent-v1` (TASKS D3-M3 step 2). The server serves exactly
 * this from GET /v1/face/consent and only accepts an enrollment whose `consent_text_sha256` is
 * its hash. Changing a single character is a new consent version. Not legal advice. Party-screen
 * copy: no chain or crypto words (copy rule, TASKS D5-M2).
 */
export const FACE_CONSENT_V1_TEXT =
  "Face matching is optional. If you turn it on, You're On uses your face so friends in the same " +
  'room can challenge you by pointing their camera at you. A match only picks who is being ' +
  'challenged. It never moves money or confirms a bet; Face ID does that. ' +
  'Your phone turns three photos of you into a face template (a list of numbers). The photos never ' +
  'leave your phone. We keep one encrypted template, never sell or share it, and only compare it ' +
  'with people in rooms you join. ' +
  'You can turn matching off or delete your template at any time. We delete it automatically ' +
  '180 days after it was last used, 30 days after you turn matching off, or on December 31, 2026, ' +
  'whichever comes first.';

export const FACE_CONSENT_V1_RETENTION =
  'Deleted 180 days after last use, 30 days after you turn it off, or on December 31, 2026.';

/** sha256 hex of UTF-8 text (the consent hash the phone echoes back). */
export const sha256HexOfText = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

export const FACE_CONSENT_V1_SHA256 = sha256HexOfText(FACE_CONSENT_V1_TEXT);

/** DATA-MODEL §10 written retention schedule (the keeper's face-retention sweep). */
export const FACE_RETENTION = {
  /** Destroyed this long after the last match (or enrollment, if never matched). */
  unusedMs: 180 * 24 * 60 * 60 * 1000,
  /** Destroyed this long after matching was turned off (unless turned back on). */
  disabledMs: 30 * 24 * 60 * 60 * 1000,
  /** Hackathon deployment: everything is destroyed at this instant. */
  hardDeadlineIso: '2026-12-31T00:00:00.000Z',
} as const;

// ---------------------------------------------------------------------------------------
// Models (API-CONTRACT §2.2 `accepted_models`; DATA-MODEL §5.3)
// ---------------------------------------------------------------------------------------

/** A face embedding model (defined in ./api, next to SealedEmbedding). */
export { FaceModelRef };

/** The bundled on-device model (apps/mobile/assets/models; non-commercial weights). */
export const FACE_MODEL_W600K = { name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 } as const;
/** The documented fallback (OpenCV SFace, Apache-2.0); no app build ships it yet. */
export const FACE_MODEL_SFACE = { name: 'sface', version: '2021dec', dim: 128 } as const;

export const ACCEPTED_FACE_MODELS: readonly FaceModelRef[] = [FACE_MODEL_W600K, FACE_MODEL_SFACE];

export const isAcceptedFaceModel = (m: FaceModelRef): boolean =>
  ACCEPTED_FACE_MODELS.some((a) => a.name === m.name && a.version === m.version && a.dim === m.dim);

// ---------------------------------------------------------------------------------------
// Match rule (API-CONTRACT §2.4; DATA-MODEL §7.2; FINDINGS §3.2 spike 01)
// ---------------------------------------------------------------------------------------

/** Accept the top candidate only at cosine >= this... */
export const FACE_MATCH_MIN_COSINE = 0.3;
/** ...and only when it beats the runner-up by at least this much. */
export const FACE_MATCH_MIN_MARGIN = 0.05;
/** At most this many room candidates are compared (DATA-MODEL §7.2 `LIMIT 50`). */
export const FACE_MATCH_MAX_CANDIDATES = 50;
/** A match ticket addresses one challenge for this long (API-CONTRACT §2.4: 60 s). */
export const MATCH_TICKET_TTL_MS = 60_000;
/** |‖v‖₂ − 1| allowed for an "L2-normalized" float32 embedding. */
export const EMBEDDING_NORM_TOLERANCE = 1e-3;

export interface ScoredCandidate<Id = string> {
  readonly id: Id;
  readonly score: number;
}

export type MatchDecision<Id = string> =
  | { readonly kind: 'match'; readonly id: Id }
  | {
      readonly kind: 'abstain';
      readonly reason: 'no_candidates' | 'below_threshold' | 'ambiguous';
    };

/**
 * The room-scoped top-2 rule. With a single candidate there is no runner-up, so only the
 * threshold applies. Scores that are not finite never match. Pure: the scores never leave the
 * caller (no score is ever returned to a client).
 */
export function decideMatch<Id>(
  candidates: readonly ScoredCandidate<Id>[],
  rule: { minCosine: number; minMargin: number } = {
    minCosine: FACE_MATCH_MIN_COSINE,
    minMargin: FACE_MATCH_MIN_MARGIN,
  },
): MatchDecision<Id> {
  const valid = candidates.filter((c) => Number.isFinite(c.score));
  if (valid.length === 0) return { kind: 'abstain', reason: 'no_candidates' };
  let best = valid[0]!;
  let second = -Infinity;
  for (const c of valid.slice(1)) {
    if (c.score > best.score) {
      second = best.score;
      best = c;
    } else if (c.score > second) {
      second = c.score;
    }
  }
  if (best.score < rule.minCosine) return { kind: 'abstain', reason: 'below_threshold' };
  if (best.score - second < rule.minMargin) return { kind: 'abstain', reason: 'ambiguous' };
  return { kind: 'match', id: best.id };
}

/**
 * DANCE-OFF §3 face assignment (POST /v1/bets/:bet_id/dance/identify): `scores[p][i]` is the
 * cosine of probe face i with party p's enrollment (a party without a usable enrollment is
 * absent). Face i becomes party p only when BOTH hold, each with the face-match rule above
 * (threshold, and the margin over the runner-up when there is one):
 *  - among the parties, p is face i's confident match (it is clearly not the other party), and
 *  - among the faces, i is p's confident match (no other face in the still looks as much like p).
 * So each party gets at most one face, each face at most one party, and an unsure case gets
 * nothing (the phone then uses the left / right rule). Pure; the scores never leave the caller.
 *
 * When that strict rule does not place BOTH parties, the two are told apart as a pair
 * (pairDanceFaces below): a dance off has exactly two dancers, so the question is only which of
 * them is which.
 */
export function decideDanceAssignments(
  scores: Partial<Record<'A' | 'B', readonly number[]>>,
  faceCount: number,
  rule: { minCosine: number; minMargin: number } = {
    minCosine: FACE_MATCH_MIN_COSINE,
    minMargin: FACE_MATCH_MIN_MARGIN,
  },
): { face_index: number; party: 'A' | 'B' }[] {
  const parties = (['A', 'B'] as const).filter((p) => scores[p] !== undefined);
  const out: { face_index: number; party: 'A' | 'B' }[] = [];
  for (const p of parties) {
    const row = scores[p]!;
    const byFace = decideMatch(
      Array.from({ length: faceCount }, (_, i) => ({ id: i, score: row[i] ?? Number.NaN })),
      rule,
    );
    if (byFace.kind !== 'match') continue;
    const i = byFace.id;
    const byParty = decideMatch(
      parties.map((q) => ({ id: q, score: scores[q]![i] ?? Number.NaN })),
      rule,
    );
    if (byParty.kind === 'match' && byParty.id === p) out.push({ face_index: i, party: p });
  }
  if (out.length === 2) return out;
  return pairDanceFaces(scores, faceCount) ?? out;
}

/** A dancer's face must look at least this much like their own enrollment to be paired. */
export const DANCE_PAIR_MIN_COSINE = 0.12;
/** The best pairing must beat every other pairing's total by this much. */
export const DANCE_PAIR_MIN_MARGIN = 0.12;

/**
 * Which face is A and which is B, decided together. The faces in a dance still are small (the
 * dancers stand back so their whole bodies fit), so each one's cosine with its own enrollment
 * is often under the room-scan threshold and the strict rule placed nobody: on real devices the
 * names never left their fixed sides. But only two answers are possible here, and the right one
 * is usually far ahead of the wrong one: the pairing (A = face i, B = face j, i ≠ j) with the
 * highest total is taken when both of its faces clear a low floor and its total beats every
 * other pairing's by a margin. Otherwise null (the left / right rule). Pure.
 */
export function pairDanceFaces(
  scores: Partial<Record<'A' | 'B', readonly number[]>>,
  faceCount: number,
  rule: { minCosine: number; minMargin: number } = {
    minCosine: DANCE_PAIR_MIN_COSINE,
    minMargin: DANCE_PAIR_MIN_MARGIN,
  },
): { face_index: number; party: 'A' | 'B' }[] | null {
  const a = scores.A;
  const b = scores.B;
  if (!a || !b || faceCount < 2) return null;
  let best: { i: number; j: number; total: number } | null = null;
  let second = -Infinity;
  for (let i = 0; i < faceCount; i++) {
    for (let j = 0; j < faceCount; j++) {
      if (i === j) continue;
      const total = (a[i] ?? Number.NaN) + (b[j] ?? Number.NaN);
      if (!Number.isFinite(total)) continue;
      if (best === null || total > best.total) {
        if (best !== null) second = best.total;
        best = { i, j, total };
      } else if (total > second) {
        second = total;
      }
    }
  }
  if (best === null) return null;
  if ((a[best.i] as number) < rule.minCosine || (b[best.j] as number) < rule.minCosine) return null;
  if (best.total - second < rule.minMargin) return null;
  return [
    { face_index: best.i, party: 'A' },
    { face_index: best.j, party: 'B' },
  ];
}

// ---------------------------------------------------------------------------------------
// Embedding bytes (plain-v0 `ct_b64` plaintext and the at-rest plaintext: float32 LE)
// ---------------------------------------------------------------------------------------

/** Float32 little-endian bytes of `v` (4 bytes per value). */
export function embeddingToBytes(v: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(v.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i] as number, true);
  return bytes;
}

/** Float32 little-endian bytes -> values. Throws unless the length is a multiple of 4. */
export function bytesToEmbedding(bytes: Uint8Array): Float32Array {
  if (bytes.length % 4 !== 0) throw new Error(`embedding byte length ${bytes.length} is not 4k`);
  const out = new Float32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Why `v` is not a usable `dim`-d L2-normalized embedding, or null when it is. */
export function embeddingProblem(v: ArrayLike<number>, dim: number): string | null {
  if (v.length !== dim) return `has ${v.length} values, expected ${dim}`;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number;
    if (!Number.isFinite(x)) return `value ${i} is not finite`;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (Math.abs(norm - 1) > EMBEDDING_NORM_TOLERANCE) return 'is not L2-normalized';
  return null;
}

/** Cosine similarity (in float64). Throws on a length mismatch or a zero vector. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`length ${a.length} vs ${b.length}`);
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
  if (!(na > 0 && nb > 0)) throw new Error('cosine of a zero vector');
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------------------
// Wire shapes (API-CONTRACT §2.2, §2.4). Tolerant z.object: unknown keys are stripped.
// ---------------------------------------------------------------------------------------

export const FACE_CONSENT_PATH = '/v1/face/consent';
export const FACE_ENROLLMENT_PATH = '/v1/face/enrollment';
export const faceMatchPath = (roomId: string): string =>
  `/v1/rooms/${encodeURIComponent(roomId)}/face-match`;

/** GET /v1/face/consent */
export const FaceConsentResponse = z.object({
  consent_version: z.string(),
  text: z.string(),
  text_sha256: Hex32,
  retention_summary: z.string(),
  /** x25519 public key (base64) for sealed embeddings; null while only plain-v0 is accepted. */
  face_seal_pubkey: z.string().nullable(),
  accepted_models: z.array(FaceModelRef),
});
export type FaceConsentResponse = z.infer<typeof FaceConsentResponse>;

export const LivenessMethod = z.enum(['blink', 'head_turn']);
export type LivenessMethod = z.infer<typeof LivenessMethod>;

/** POST /v1/face/enrollment */
export const FaceEnrollmentRequest = z.object({
  consent: z.object({
    consent_version: z.string().min(1).max(64),
    consent_text_sha256: Hex32,
    consent_at: IsoUtc,
  }),
  liveness: z.object({ method: LivenessMethod, passed_at: IsoUtc }),
  model: FaceModelRef,
  embedding: SealedEmbedding,
  /** Stills averaged on the phone (API-CONTRACT §2.2: 3). */
  shots: z.number().int().min(1).max(10),
});
export type FaceEnrollmentRequest = z.infer<typeof FaceEnrollmentRequest>;

/** POST /v1/face/enrollment -> 201 */
export const FaceEnrollmentResponse = z.object({
  status: z.literal('active'),
  enrolled_at: IsoUtc,
});
export type FaceEnrollmentResponse = z.infer<typeof FaceEnrollmentResponse>;

export const FaceStatus = z.enum(['none', 'active', 'disabled']);
export type FaceStatus = z.infer<typeof FaceStatus>;

/**
 * GET /v1/face/enrollment (and the body of PATCH): the caller's own enrollment, without any
 * vector data. Same fields as GET /v1/me `face` (API-CONTRACT §2.1), plus model and dates.
 */
export const FaceEnrollmentStatusResponse = z.object({
  status: FaceStatus,
  consent_version: z.string().nullable(),
  model: FaceModelRef.nullable(),
  enrolled_at: IsoUtc.nullable(),
  disabled_at: IsoUtc.nullable(),
});
export type FaceEnrollmentStatusResponse = z.infer<typeof FaceEnrollmentStatusResponse>;

/** PATCH /v1/face/enrollment */
export const FaceEnrollmentPatchRequest = z.object({ status: z.enum(['active', 'disabled']) });
export type FaceEnrollmentPatchRequest = z.infer<typeof FaceEnrollmentPatchRequest>;

/**
 * How the scan was taken: `tap` (one photo per tap, the default when absent) or `live` (the
 * camera re-matching faces as it pans). Each has its own rate-limit bucket (API-CONTRACT §1.7);
 * the one-in-flight guard is shared.
 */
export const FaceMatchMode = z.enum(['tap', 'live']);
export type FaceMatchMode = z.infer<typeof FaceMatchMode>;

/** §1.7 per-user face-match buckets: `face-match` (tap) and `face-match/live`. */
export const FACE_MATCH_BUCKETS = {
  tap: { limit: 30, windowMs: 60_000 },
  live: { limit: 60, windowMs: 60_000 },
} as const;

/** POST /v1/rooms/:room_id/face-match */
export const FaceMatchRequest = z.object({
  probe: SealedEmbedding,
  model: FaceModelRef,
  /** Absent = 'tap'. Older servers strip it (and charge the tap bucket). */
  mode: FaceMatchMode.optional(),
  /** Capture metadata for latency and quality logs; never required, never stored. */
  capture: z
    .object({
      captured_at: IsoUtc.optional(),
      eye_distance_px: z.number().nonnegative().optional(),
      yaw_deg: z.number().optional(),
    })
    .nullish(),
});
export type FaceMatchRequest = z.infer<typeof FaceMatchRequest>;

/** One of `{match: {...}}` or `{match: null}`. No score is ever returned. */
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
