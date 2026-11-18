// Face enrollment logic (TASKS D3-M3; API-CONTRACT §2.2), ported from Verdict's enroll redesign
// (branch enroll-redesign: consent first, a series of photos with head-turn prompts, a specific
// fix-it line for a bad photo). Pure TS, so vitest runs it in Node; the screens are in ./screens.
//
// What changed from Verdict: no voice step (no voiceprints here, MERGE-PLAN #3), the embedding is
// computed on the phone, and the liveness check runs here before anything is sent (the server only
// sees one averaged, sealed embedding: never an image).
import { FACE_MODEL, l2NormalizeInPlace } from '../face/model';
import type { Landmarks } from '../face/pipeline';

// ---------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------

/** One photo's pose: straight ahead first, then one turn each way (liveness `head_turn`). */
export type Prompt = 'ahead' | 'left' | 'right';

/** Shots per enrollment (API-CONTRACT §2.2 `shots: 3`). */
export const SHOTS = 3;

/** The bubble text over the camera for each prompt (1-3 words). */
export const PROMPT_LABEL: Readonly<Record<Prompt, string>> = {
  ahead: 'Look ahead',
  left: 'Turn left',
  right: 'Turn right',
};

/** The red line when a photo didn't match its prompt (1-3 words). */
export const FURTHER_LABEL: Readonly<Record<Prompt, string>> = {
  ahead: 'Look straight ahead',
  left: 'Turn further left',
  right: 'Turn further right',
};

/** Straight ahead, then left and right in a random order (so a replayed clip can't guess it). */
export function makePrompts(random: () => number = Math.random): Prompt[] {
  return random() < 0.5 ? ['ahead', 'left', 'right'] : ['ahead', 'right', 'left'];
}

// ---------------------------------------------------------------------------------------
// One photo
// ---------------------------------------------------------------------------------------

/**
 * The fields we read from the on-device face detector (react-native-vision-camera-face-detector),
 * in the pixel coordinates of the still it ran on (src/enroll/embedder.ts runs it on an upright
 * copy, so these match the pixels the embedder samples).
 */
export interface DetectedFace {
  readonly yawAngle: number;
  readonly pitchAngle: number;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly frameWidth: number;
  readonly frameHeight?: number | undefined;
  /** Eyes, nose and mouth corners for the ArcFace alignment (src/face/pipeline.ts). */
  readonly landmarks?: Landmarks | undefined;
}

/** A head turn must reach this yaw (degrees). Verdict's on-device threshold. */
export const MIN_TURN_YAW_DEG = 12;
/** "Straight ahead" allows this much yaw / pitch (degrees). */
export const MAX_AHEAD_YAW_DEG = 12;
export const MAX_AHEAD_PITCH_DEG = 20;
/** The face must fill at least this share of the photo width (else: "Move closer"). */
export const MIN_FACE_WIDTH_SHARE = 0.18;

export type ShotProblem = 'no_face' | 'many_faces' | 'too_far' | 'not_ahead' | 'turn_more';

export type ShotCheck =
  | { readonly ok: true; readonly face: DetectedFace }
  | { readonly ok: false; readonly problem: ShotProblem };

/**
 * Checks a photo against its prompt. Only the magnitude of a turn is checked here: the sign of the
 * detector's yaw depends on front-camera mirroring. Direction is checked across the two turns
 * (`checkTurnsOpposite`).
 */
export function checkShot(prompt: Prompt, faces: readonly DetectedFace[]): ShotCheck {
  if (faces.length === 0) return { ok: false, problem: 'no_face' };
  if (faces.length > 1) return { ok: false, problem: 'many_faces' };
  const face = faces[0] as DetectedFace;
  if (face.frameWidth > 0 && face.bounds.width / face.frameWidth < MIN_FACE_WIDTH_SHARE) {
    return { ok: false, problem: 'too_far' };
  }
  if (prompt === 'ahead') {
    const ahead =
      Math.abs(face.yawAngle) <= MAX_AHEAD_YAW_DEG &&
      Math.abs(face.pitchAngle) <= MAX_AHEAD_PITCH_DEG;
    return ahead ? { ok: true, face } : { ok: false, problem: 'not_ahead' };
  }
  return Math.abs(face.yawAngle) >= MIN_TURN_YAW_DEG
    ? { ok: true, face }
    : { ok: false, problem: 'turn_more' };
}

/** The red line under the camera for a photo problem (1-3 words). */
export function problemLabel(prompt: Prompt, problem: ShotProblem): string {
  switch (problem) {
    case 'no_face':
      return 'No face found';
    case 'many_faces':
      return 'One face only';
    case 'too_far':
      return 'Move closer';
    case 'not_ahead':
    case 'turn_more':
      return FURTHER_LABEL[prompt];
  }
}

// ---------------------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------------------

export interface Shot {
  readonly prompt: Prompt;
  readonly yawAngle: number;
  /** The 512-d embedding of this photo (normalised again when the shots are averaged). */
  readonly embedding: Float32Array;
}

/** The two turns must go opposite ways (one left, one right), whatever the mirroring. */
export function checkTurnsOpposite(shots: readonly Shot[]): boolean {
  const turns = shots.filter((s) => s.prompt !== 'ahead');
  if (turns.length < 2) return true;
  const [a, b] = turns as [Shot, Shot];
  return Math.sign(a.yawAngle) !== 0 && Math.sign(a.yawAngle) === -Math.sign(b.yawAngle);
}

/** Cosine similarity of two vectors of the same length. */
export function cosine(a: Float32Array, b: Float32Array): number {
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

/**
 * Same-person check across the series (Verdict did this on the server as `identity_changed`):
 * each turned photo must match the straight-ahead one at least this well. Lower than the match
 * threshold (0.30) because turned faces score lower against a frontal one.
 */
export const MIN_SAME_PERSON_COSINE = 0.2;

export function samePersonAcrossShots(shots: readonly Shot[]): boolean {
  const ahead = shots.find((s) => s.prompt === 'ahead');
  if (!ahead) return false;
  return shots.every(
    (s) => s === ahead || cosine(ahead.embedding, s.embedding) >= MIN_SAME_PERSON_COSINE,
  );
}

/** Averages the L2-normalised shots, then L2-normalises the mean (API-CONTRACT §2.2). */
export function averageEmbedding(shots: readonly Shot[]): Float32Array {
  if (shots.length === 0) throw new Error('no shots');
  const out = new Float32Array(FACE_MODEL.dim);
  for (const s of shots) {
    if (s.embedding.length !== FACE_MODEL.dim) {
      throw new Error(`embedding has ${s.embedding.length} values, expected ${FACE_MODEL.dim}`);
    }
    const v = Float32Array.from(s.embedding);
    l2NormalizeInPlace(v);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (v[i] as number);
  }
  l2NormalizeInPlace(out);
  return out;
}

export type SeriesProblem = 'turns_same_way' | 'not_same_person';

/** The red line when the whole series failed; the photos start over (1-3 words). */
export const SERIES_PROBLEM_LABEL: Readonly<Record<SeriesProblem, string>> = {
  turns_same_way: 'Turn both ways',
  not_same_person: "Photos didn't match",
};

/** Checks a complete series before anything is sent. */
export function checkSeries(shots: readonly Shot[]): SeriesProblem | null {
  if (!checkTurnsOpposite(shots)) return 'turns_same_way';
  if (!samePersonAcrossShots(shots)) return 'not_same_person';
  return null;
}

// ---------------------------------------------------------------------------------------
// The request (API-CONTRACT §2.2)
// ---------------------------------------------------------------------------------------

export interface FaceConsent {
  readonly consent_version: string;
  readonly text: string;
  readonly text_sha256: string;
  readonly retention_summary: string;
}

export interface SealedEmbedding {
  readonly alg: 'x25519-hkdf-sha256-chacha20poly1305-v1' | 'plain-v0';
  readonly epk_b64: string | null;
  readonly nonce_b64: string | null;
  readonly ct_b64: string;
}

export interface FaceEnrollmentRequest {
  readonly consent: {
    readonly consent_version: string;
    readonly consent_text_sha256: string;
    readonly consent_at: string;
  };
  readonly liveness: { readonly method: 'head_turn'; readonly passed_at: string };
  readonly model: { readonly name: string; readonly version: string; readonly dim: number };
  readonly embedding: SealedEmbedding;
  readonly shots: number;
}

/** Float32 little-endian bytes, base64 (the `ct_b64` plaintext of API-CONTRACT §2.2). */
export function float32LeBase64(v: Float32Array): string {
  const bytes = new Uint8Array(v.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i] as number, true);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * `plain-v0` (TLS only) while the server runs with FACE_SEAL_REQUIRED=false. The sealed form
 * (x25519 + chacha20poly1305 to the consent's `face_seal_pubkey`) is a follow-up: pin
 * @noble/ciphers first (API-CONTRACT §2.2).
 */
export function plainEmbedding(v: Float32Array): SealedEmbedding {
  return { alg: 'plain-v0', epk_b64: null, nonce_b64: null, ct_b64: float32LeBase64(v) };
}

export function buildEnrollmentRequest(args: {
  consent: FaceConsent;
  consentAt: Date;
  passedAt: Date;
  embedding: SealedEmbedding;
}): FaceEnrollmentRequest {
  return {
    consent: {
      consent_version: args.consent.consent_version,
      consent_text_sha256: args.consent.text_sha256,
      consent_at: args.consentAt.toISOString(),
    },
    liveness: { method: 'head_turn', passed_at: args.passedAt.toISOString() },
    model: { name: FACE_MODEL.name, version: FACE_MODEL.version, dim: FACE_MODEL.dim },
    embedding: args.embedding,
    shots: SHOTS,
  };
}

/**
 * The finished series as the POST /v1/face/enrollment body: the shots averaged, `passed_at` now.
 * `now` is the server-corrected clock (rt.clock.now on the phone), and `consentAt` must come from
 * it too: the server refuses either time more than REQUEST_CLOCK_SKEW_MS (60 s) ahead of its own,
 * so on a phone whose clock runs fast, Date.now here would fail every enrollment with "Consent
 * needed" while every signed request (already on the corrected clock) still works.
 */
export function seriesEnrollmentRequest(args: {
  consent: FaceConsent;
  consentAt: Date;
  shots: readonly Shot[];
  now: () => number;
}): FaceEnrollmentRequest {
  return buildEnrollmentRequest({
    consent: args.consent,
    consentAt: args.consentAt,
    passedAt: new Date(args.now()),
    embedding: plainEmbedding(averageEmbedding(args.shots)),
  });
}

/** Server error codes on face routes → the red line on the face step (API-CONTRACT §1.6). */
export function enrollErrorLabel(code: string): string {
  switch (code) {
    case 'FACE_CONSENT_REQUIRED':
      return 'Consent needed';
    case 'FACE_MODEL_UNSUPPORTED':
    case 'FACE_SEAL_INVALID':
      return 'Update the app';
    case 'RATE_LIMITED':
      return 'Try again later';
    default:
      return "Couldn't save";
  }
}
