/**
 * Identity service (§8, §12.3): enrollment with a liveness challenge,
 * encrypted templates keyed to the wallet, Profile commitments via
 * `init_profile`, real delete, closed-set matching (huddle scan, pay by face,
 * pay by voice, "I accept" voice verification) and payments.
 *
 * Mock subjects (§13 IDENTITY_PROVIDER=mock): the mock embedder needs to be
 * told whose face/voice the bytes depict. Enrollment uses the caller; "I
 * accept" uses the caller; huddle scans use the next not-yet-confirmed joined
 * member; pay uses the first closed-set candidate. The `x-mock-subject`
 * header (a user id) overrides this in mock mode only, so tests can present
 * an impostor. Real providers ignore subjects entirely.
 */
import {
  enrollmentTemplate,
  formatUsd,
  MAX_HUDDLE,
  MAX_STAKE_UNITS,
  TAU_VOICE_BPS,
  type Modality,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import { initProfileIx, type IxEnv } from '../chain/ixs.js';
import { associatedTokenAddress, createAtaIdempotentIx, transferCheckedIx } from '../chain/programs.js';
import { ApiError } from '../errors.js';
import { userView, type UserRecord, type UserView } from '../persistence/records.js';
import type { HuddleRecord, HuddleService } from '../huddles/service.js';
import type { SignPayload } from '../tx/service.js';
import { containsPhrase, wavDurationMs } from '../voice/transcript.js';
import { BiometricVault, ZERO_COMMIT_HEX } from './biometrics.js';
import {
  ACCEPT_CHALLENGE_TTL_MS,
  ChallengeStore,
  ENROLL_CHALLENGE_TTL_MS,
  PAY_CHALLENGE_TTL_MS,
  randomFacePrompts,
  randomVoicePhrases,
  type FacePrompt,
} from './challenges.js';
import { checkJpegs, checkLiveness } from './liveness.js';
import { enrolledCandidates, matchObservation, meanEmbedding, type MatchOutcome } from './matching.js';

export { ACCEPT_CHALLENGE_TTL_MS };

export const MAX_WAV_BYTES = 8 * 1024 * 1024;
export const MIN_CLIP_MS = 300;
export const MAX_CLIP_MS = 30_000;
const UTF8 = new TextEncoder();

export interface MatchView {
  user: UserView | null;
  cos_bps: number;
  matched: boolean;
}

export interface RequestHints {
  /** `x-mock-subject` header (mock identity only) */
  mockSubject?: string | null;
  /** `x-mock-transcript` header (mock STT only) */
  mockTranscript?: string | null;
}

/** display_name: 1..32 UTF-8 bytes, no control characters, trimmed. */
export function validDisplayName(v: unknown): string {
  if (typeof v !== 'string') throw new ApiError('WRONG_STATE', 'display_name required', 400);
  const s = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (s === '' || UTF8.encode(s).length > 32 || /[\u0000-\u001f\u007f]/.test(s)) {
    throw new ApiError('WRONG_STATE', 'display_name must be 1..32 UTF-8 bytes', 400);
  }
  return s;
}

export class IdentityService {
  readonly vault: BiometricVault;
  readonly challenges: ChallengeStore;

  constructor(
    private readonly ctx: AppContext,
    private readonly huddles: HuddleService,
  ) {
    this.vault = new BiometricVault(ctx.store, ctx.config.biometricKey, ctx.clock);
    this.challenges = new ChallengeStore(ctx.store, ctx.clock);
  }

  get ixEnv(): IxEnv {
    const c = this.ctx.chain;
    return { programId: c.programId, mint: c.mint, feePayer: c.feePayer, oracle: c.oracle };
  }

  private get mockIdentity(): boolean {
    return this.ctx.providers.identity.name === 'mock';
  }

  /** Subject for the mock embedder: explicit header (mock only) else the default. */
  subject(hints: RequestHints | undefined, fallback: string | null): { subject_user_id: string | null } {
    if (!this.mockIdentity) return { subject_user_id: null };
    const h = hints?.mockSubject;
    return { subject_user_id: typeof h === 'string' && h !== '' ? h : fallback };
  }

  async embed(modality: Modality, bytes: Uint8Array, subject: { subject_user_id: string | null }): Promise<number[]> {
    const p = this.ctx.providers.identity;
    try {
      return modality === 'face' ? await p.embedFace(bytes, subject) : await p.embedVoice(bytes, subject);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('INTERNAL', `embed ${modality}: ${(e as Error).message}`);
    }
  }

  matchView(m: MatchOutcome): MatchView[] {
    return [...m.scores]
      .sort((a, b) => b.cos_bps - a.cos_bps)
      .map((s) => ({ user: userView(s.user), cos_bps: s.cos_bps, matched: m.matched && m.best?.id === s.user.id }));
  }

  // ---- enrollment ----------------------------------------------------------------

  enrollChallenge(user: UserRecord): { challenge_id: string; face_prompts: FacePrompt[]; voice_phrases: string[] } {
    const face_prompts = randomFacePrompts(2);
    const voice_phrases = randomVoicePhrases();
    const c = this.challenges.issue(user.id, { kind: 'enroll', face_prompts, voice_phrases }, ENROLL_CHALLENGE_TTL_MS);
    return { challenge_id: c.id, face_prompts, voice_phrases };
  }

  async enrollFace(user: UserRecord, challengeId: unknown, frames: Uint8Array[], hints?: RequestHints): Promise<{ ok: true; liveness: true }> {
    const c = this.challenges.require(challengeId, user.id, 'enroll');
    if (frames.length < 3 || frames.length > 5) throw new ApiError('WRONG_STATE', 'frames_b64 must have 3..5 frames', 400);
    if (checkJpegs(frames)) throw new ApiError('LIVENESS_FAILED', 'frames must be JPEG');
    const subj = this.subject(hints, user.id);
    const embeddings: number[][] = [];
    for (const f of frames) embeddings.push(await this.embed('face', f, subj));
    const live = checkLiveness(frames, embeddings);
    if (!live.ok) throw new ApiError('LIVENESS_FAILED', live.reason ?? 'liveness');
    this.vault.putPending(user, c.id, 'face', enrollmentTemplate(embeddings));
    return { ok: true, liveness: true };
  }

  async enrollVoice(user: UserRecord, challengeId: unknown, clips: Uint8Array[], hints?: RequestHints): Promise<{ ok: true }> {
    const c = this.challenges.require(challengeId, user.id, 'enroll');
    if (clips.length !== 3) throw new ApiError('WRONG_STATE', 'clips_b64 must have 3 clips', 400);
    const subj = this.subject(hints, user.id);
    const embeddings: number[][] = [];
    for (let i = 0; i < 3; i++) {
      const clip = clips[i]!;
      checkWav(clip);
      const phrase = c.data.voice_phrases[i]!;
      const t = await this.ctx.providers.stt.transcribe(clip, {
        mock_transcript: hints?.mockTranscript ?? null,
        challenge_phrase: phrase,
      });
      if (!containsPhrase(t.text, phrase)) throw new ApiError('PHRASE_NOT_HEARD', `clip ${i}`);
      embeddings.push(await this.embed('voice', clip, subj));
    }
    // All three clips must be the same speaker (closed set of one: the mean).
    const template = enrollmentTemplate(embeddings);
    const consistent = embeddings.every((e) => matchObservation(e, [{ user, template }], 'voice').cos1 >= TAU_VOICE_BPS);
    if (!consistent) throw new ApiError('VOICE_NOT_MATCHED', 'clips are not one speaker');
    this.vault.putPending(user, c.id, 'voice', template);
    return { ok: true };
  }

  /**
   * Seals pending templates (fresh salts, §8.4 commitments), sets the display
   * name and returns the `init_profile` sign payload.
   */
  async completeEnrollment(user: UserRecord, consent: unknown, displayName: unknown): Promise<{ face_commit: string; voice_commit: string; sign: SignPayload }> {
    if (consent !== true) throw new ApiError('WRONG_STATE', 'consent must be true', 400);
    const name = validDisplayName(displayName);
    const face = this.vault.getPending(user, 'face');
    const voice = this.vault.getPending(user, 'voice');
    if (!face && !voice && !user.enrolled.face && !user.enrolled.voice) throw new ApiError('NOT_ENROLLED', 'nothing enrolled');
    let bio = user.biometrics ?? {};
    let next: UserRecord = { ...user, biometrics: bio };
    if (face) bio = this.vault.seal(next, 'face', face);
    next = { ...next, biometrics: bio };
    if (voice) bio = this.vault.seal(next, 'voice', voice);
    const now = this.ctx.clock.nowMs();
    const saved = this.vault.users.update(user.id, (u) => ({
      ...u,
      display_name: name,
      biometrics: bio,
      enrolled: { face: !!bio.face_commit, voice: !!bio.voice_commit },
      updated_at_ms: now,
    }));
    this.vault.clearPending(user.id);
    this.challenges.sweep();
    const commits = this.vault.commits(saved);
    const sign = await this.profileTx(saved, commits.face_commit, commits.voice_commit, 'Save profile');
    return { ...commits, sign };
  }

  /** Erases all biometrics and returns the zero-commitment `init_profile` sign payload. */
  async deleteEnrollment(user: UserRecord): Promise<{ deleted: true; sign: SignPayload }> {
    const erased = this.vault.erase(user.id);
    // Delete means delete (§1 #5): also any stored voice recordings of the user
    // (acceptance WAVs written by older builds: acceptances/<draft>_<user>.wav).
    this.ctx.blobs.deleteBlobsMatching('acceptances', (k) => k.endsWith(`_${user.id}.wav`));
    const sign = await this.profileTx(erased, ZERO_COMMIT_HEX, ZERO_COMMIT_HEX, 'Delete biometrics');
    return { deleted: true, sign };
  }

  private async profileTx(user: UserRecord, face: string, voice: string, summary: string): Promise<SignPayload> {
    const ix = initProfileIx(this.ixEnv, user.wallet, { face_commit: face, voice_commit: voice, display_name: user.display_name });
    const r = await this.ctx.txs.request({ user, kind: 'init_profile', ixs: [ix], summary, meta: { face_commit: face, voice_commit: voice } });
    return r.sign;
  }

  // ---- huddle scan -------------------------------------------------------------

  /**
   * Matches each face crop against the joined members (closed set). Matched
   * members are returned for confirmation. Mock subjects: each crop is the
   * next not-yet-confirmed joined member.
   */
  async scanHuddle(
    h: HuddleRecord,
    faces: { crop: Uint8Array; bbox: [number, number, number, number] }[],
  ): Promise<{ bbox: [number, number, number, number]; user: UserRecord | null; cos_bps: number; matched: boolean }[]> {
    if (faces.length > MAX_HUDDLE) throw new ApiError('WRONG_STATE', `at most ${MAX_HUDDLE} faces`, 400);
    const joined = this.huddles.joinedUsers(h);
    const candidates = enrolledCandidates(this.vault, joined, 'face');
    const pendingSubjects = h.members.filter((m) => !m.confirmed).map((m) => m.user_id);
    const out = [];
    for (const f of faces) {
      if (checkJpegs([f.crop])) throw new ApiError('WRONG_STATE', 'crop must be a JPEG', 400);
      const subj = this.subject(undefined, pendingSubjects.shift() ?? null);
      const e = await this.embed('face', f.crop, subj);
      const m = candidates.length ? matchObservation(e, candidates, 'face') : null;
      out.push({ bbox: f.bbox, user: m?.matched ? m.best : null, cos_bps: m?.cos1 ?? 0, matched: !!m?.matched });
    }
    return out;
  }

  // ---- pay -----------------------------------------------------------------------

  payChallenge(user: UserRecord): { challenge_id: string; face_prompt: FacePrompt } {
    const [face_prompt] = randomFacePrompts(1) as [FacePrompt];
    const c = this.challenges.issue(user.id, { kind: 'pay', face_prompt }, PAY_CHALLENGE_TTL_MS);
    return { challenge_id: c.id, face_prompt };
  }

  async payScan(user: UserRecord, challengeId: unknown, faces: Uint8Array[], hints?: RequestHints): Promise<{ matches: MatchView[]; liveness: boolean }> {
    const c = this.challenges.require(challengeId, user.id, 'pay');
    if (faces.length !== 2) throw new ApiError('WRONG_STATE', 'faces_b64 must have 2 crops', 400);
    const set = this.huddles.recentCoMembers(user.id);
    const candidates = enrolledCandidates(this.vault, set, 'face');
    const subj = this.subject(hints, candidates[0]?.user.id ?? null);
    const embeddings: number[][] = [];
    for (const f of faces) embeddings.push(await this.embed('face', f, subj));
    const live = checkLiveness(faces, embeddings);
    this.challenges.markUsed(c.id);
    if (candidates.length === 0) return { matches: [], liveness: live.ok };
    const m = matchObservation(meanEmbedding(embeddings), candidates, 'face');
    const matches = this.matchView(m);
    if (!live.ok) for (const x of matches) x.matched = false;
    return { matches, liveness: live.ok };
  }

  async payVoice(user: UserRecord, audio: Uint8Array, hints?: RequestHints): Promise<{ matches: MatchView[] }> {
    checkWav(audio);
    const set = this.huddles.recentCoMembers(user.id);
    const candidates = enrolledCandidates(this.vault, set, 'voice');
    if (candidates.length === 0) return { matches: [] };
    const subj = this.subject(hints, candidates[0]!.user.id);
    const e = await this.embed('voice', audio, subj);
    return { matches: this.matchView(matchObservation(e, candidates, 'voice')) };
  }

  /** USDC transfer to a recent huddle co-member; creates the recipient ATA if missing (payer-funded). */
  async pay(user: UserRecord, toUserId: unknown, amountUnits: unknown): Promise<{ sign: SignPayload }> {
    if (typeof toUserId !== 'string') throw new ApiError('WRONG_STATE', 'to_user_id required', 400);
    if (!Number.isSafeInteger(amountUnits) || (amountUnits as number) <= 0 || (amountUnits as number) > MAX_STAKE_UNITS) {
      throw new ApiError('BAD_STAKE', 'amount_units out of range');
    }
    const amount = amountUnits as number;
    const to = this.huddles.recentCoMembers(user.id).find((u) => u.id === toUserId);
    if (!to) throw new ApiError('NOT_FOUND', `recipient ${toUserId} is not a recent huddle member`);
    const balance = await this.ctx.chain.getUsdcBalance(user.wallet);
    if (balance < BigInt(amount)) throw new ApiError('INSUFFICIENT_FUNDS');
    const { mint, feePayer } = this.ctx.chain;
    const ixs = [
      createAtaIdempotentIx(feePayer, to.wallet, mint),
      transferCheckedIx(associatedTokenAddress(user.wallet, mint), mint, associatedTokenAddress(to.wallet, mint), user.wallet, BigInt(amount)),
    ];
    return this.ctx.txs.request({
      user,
      kind: 'pay',
      ixs,
      summary: `Pay ${formatUsd(amount)}`,
      meta: { to_user_id: to.id, amount_units: amount },
    });
  }

  // ---- "I accept" voiceprint -----------------------------------------------------

  /**
   * §8.3 "I accept": the closed set is every confirmed huddle member with a
   * voice template; the best match must be the caller and pass τ/δ.
   */
  async verifyAcceptVoice(
    caller: UserRecord,
    members: UserRecord[],
    speech: Uint8Array,
    hints?: RequestHints,
  ): Promise<{ matched: boolean; cos_bps: number }> {
    if (!this.vault.template(caller.id, 'voice')) throw new ApiError('NOT_ENROLLED', 'no voice template');
    const candidates = enrolledCandidates(this.vault, members, 'voice');
    const e = await this.embed('voice', speech, this.subject(hints, caller.id));
    const m = matchObservation(e, candidates, 'voice');
    const own = m.scores.find((s) => s.user.id === caller.id)?.cos_bps ?? 0;
    return { matched: m.matched && m.best?.id === caller.id, cos_bps: own };
  }
}

/** Validates a PCM16 WAV upload (size, format, duration). */
export function checkWav(bytes: Uint8Array): number {
  if (bytes.length > MAX_WAV_BYTES) throw new ApiError('WRONG_STATE', 'audio too large', 400);
  let ms: number;
  try {
    ms = wavDurationMs(bytes);
  } catch (e) {
    throw new ApiError('WRONG_STATE', `audio must be a PCM16 WAV: ${(e as Error).message}`, 400);
  }
  if (ms < MIN_CLIP_MS || ms > MAX_CLIP_MS) throw new ApiError('PHRASE_NOT_HEARD', `clip length ${ms} ms`);
  return ms;
}
