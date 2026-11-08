/**
 * Drafts (§12.3): compile (COMPILER_PROVIDER + engine), clarifying
 * questions, PATCH chips, read-back audio, spoken "I accept" acceptance and
 * the `create_bet` sign payload.
 */
import { createHash } from 'node:crypto';
import { acceptSigMessage, type Program } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { verifyEd25519 } from '../crypto/keys.js';
import { ApiError } from '../errors.js';
import type { HuddleRecord, HuddleService } from '../huddles/service.js';
import { randomWords } from '../identity/challenges.js';
import { checkWav, type IdentityService, type RequestHints } from '../identity/service.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import type { Collection } from '../persistence/store.js';
import type { AudioBlob, Question } from '../providers/types.js';
import { fromBase64, toBase64 } from '../util/bytes.js';
import { uuid } from '../util/ids.js';
import { acceptPhraseHeard, pickSpeaker, sliceWav } from '../voice/transcript.js';
import { ACCEPT_CHALLENGE_TTL_MS } from '../identity/challenges.js';
import {
  checkOverrides,
  finishProgram,
  hasOverrides,
  parseWithOverrides,
  runCompile,
  sidesFromAnswer,
  toWalletOverrides,
  type Member,
} from './compile.js';
import {
  isFrozen,
  liveAcceptances,
  type DraftOverrides,
  type DraftRecord,
  type DraftView,
} from './records.js';
import { toYaml } from '@verdict/engine';

export const MAX_TRANSCRIPT_CHARS = 4000;
export const MAX_ANSWERS = 16;

export interface CompileBody {
  huddle_id: string;
  transcript?: string;
  audio?: Uint8Array;
  draft_id?: string;
  answers?: { question_id: string; answer: string }[];
}

export class DraftService {
  readonly drafts: Collection<DraftRecord>;
  private readonly ttsCache = new Map<string, Promise<AudioBlob>>();

  constructor(
    private readonly ctx: AppContext,
    readonly huddles: HuddleService,
    readonly identity: IdentityService,
  ) {
    this.drafts = ctx.store.collection<DraftRecord>(COLLECTIONS.drafts);
    ctx.txs.onConfirmed('create_bet', (tx) => {
      const id = tx.meta['draft_id'];
      if (typeof id !== 'string' || !this.drafts.has(id)) return;
      const d = this.drafts.update(id, (x) => {
        if (x.bet && x.bet.tx_id === tx.tx_id) x.bet.status = 'confirmed';
        x.updated_at_ms = ctx.clock.nowMs();
      });
      this.publish(d);
    });
  }

  // ---- helpers -----------------------------------------------------------------

  members(h: HuddleRecord, creatorId: string): Member[] {
    return this.huddles.confirmedUsers(h, creatorId).map((u) => ({ user: u, enrolled: u.enrolled.face || u.enrolled.voice }));
  }

  private names(h: HuddleRecord): Record<string, string> {
    const out: Record<string, string> = {};
    for (const u of this.huddles.joinedUsers(h)) out[u.wallet] = u.display_name;
    return out;
  }

  /**
   * The draft, visible to confirmed members of its huddle only: an
   * unconfirmed joiner (anyone who learned the 6-digit code) sees no terms,
   * readback or question audio until the creator's face scan confirms them.
   */
  requireDraft(id: string, userId: string): { d: DraftRecord; h: HuddleRecord } {
    const d = this.drafts.get(id);
    if (!d) throw new ApiError('NOT_FOUND', `draft ${id}`);
    const h = this.huddles.huddles.get(d.huddle_id);
    if (!h || !h.members.some((m) => m.user_id === userId && m.confirmed)) throw new ApiError('NOT_FOUND', `draft ${id}`);
    return { d, h };
  }

  private audioUrl(path: string): string {
    return `${this.ctx.config.publicUrl}/v1${path}`;
  }

  view(d: DraftRecord): DraftView {
    const users = this.huddles.users;
    const accepted = new Set(liveAcceptances(d).map((a) => a.user_id));
    const p = d.program;
    let participants: DraftView['participants'];
    if (p) {
      participants = p.participants.map((w, i) => {
        const u = users.find((x) => x.wallet === w);
        const isCreator = i === 0;
        return {
          user_id: u?.id ?? '',
          display_name: u?.display_name ?? w,
          side: p.sides[i]!,
          accepted: isCreator || (!!u && accepted.has(u.id)),
          is_creator: isCreator,
        };
      });
    } else {
      const c = users.get(d.creator_user_id);
      participants = c ? [{ user_id: c.id, display_name: c.display_name, side: 0, accepted: true, is_creator: true }] : [];
    }
    return {
      draft_id: d.id,
      huddle_id: d.huddle_id,
      status: d.status,
      kind: d.kind,
      title: d.title,
      questions: d.questions.map((q) => ({ ...q, audio_url: this.audioUrl(`/drafts/${d.id}/questions/${encodeURIComponent(q.id)}/audio`) })),
      ...(p ? { program: p } : {}),
      ...(d.yaml ? { yaml: d.yaml } : {}),
      ...(d.readback ? { readback: d.readback } : {}),
      ...(d.program_hash ? { program_hash: d.program_hash } : {}),
      ...(d.bet?.status === 'confirmed' ? { bet_id: d.bet.address } : {}),
      labels: d.labels,
      participants,
      ...(d.errors.length ? { errors: d.errors } : {}),
      ...(d.warnings.length ? { warnings: d.warnings } : {}),
      frozen: isFrozen(d),
      readback_audio_url: d.readback ? this.audioUrl(`/drafts/${d.id}/readback.mp3`) : null,
      updated_at_ms: d.updated_at_ms,
    };
  }

  /** WS `draft` to the huddle's confirmed members only. */
  publish(d: DraftRecord): void {
    const msg = { type: 'draft' as const, huddle_id: d.huddle_id, draft: this.view(d) };
    void this.ctx.hub.publishPerUser(`huddle:${d.huddle_id}`, (userId) => (this.huddles.isConfirmed(d.huddle_id, userId) ? msg : null));
  }

  /** Drafts of a huddle, newest first (WS snapshots). */
  draftsOf(huddleId: string): DraftRecord[] {
    return this.drafts.filter((d) => d.huddle_id === huddleId).sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  }

  private assertEditable(d: DraftRecord, user: UserRecord): void {
    if (d.creator_user_id !== user.id) throw new ApiError('WRONG_STATE', 'only the draft creator edits it');
    if (d.bet?.status === 'confirmed') throw new ApiError('WRONG_STATE', 'bet already created');
  }

  // ---- compile -----------------------------------------------------------------

  async compile(user: UserRecord, body: CompileBody, hints: RequestHints = {}): Promise<DraftView> {
    const h = this.huddles.requireForConfirmed(body.huddle_id, user.id);
    let d: DraftRecord | null = null;
    if (body.draft_id !== undefined) {
      d = this.requireDraft(body.draft_id, user.id).d;
      if (d.huddle_id !== h.id) throw new ApiError('NOT_FOUND', `draft ${body.draft_id}`);
      this.assertEditable(d, user);
    }
    if ((body.answers?.length ?? 0) > MAX_ANSWERS) throw new ApiError('WRONG_STATE', 'too many answers', 400);

    let text = (body.transcript ?? '').trim();
    let dictationSha: string | null | undefined;
    if (body.audio) {
      checkWav(body.audio);
      dictationSha = createHash('sha256').update(body.audio).digest('hex');
      if (!text) {
        const t = await this.ctx.providers.stt.transcribe(body.audio, {
          mock_transcript: hints.mockTranscript ?? null,
          draft_transcript: d?.transcript ?? null,
        });
        text = t.text.trim();
      }
    } else if (text) {
      dictationSha = null; // typed (h_0 = 32 zero bytes)
    }
    if (text.length > MAX_TRANSCRIPT_CHARS) throw new ApiError('WRONG_STATE', 'transcript too long', 400);
    if (!d && !text) throw new ApiError('DRAFT_INVALID', 'nothing to compile');

    const answers = mergeAnswers(d?.answers ?? [], body.answers ?? []);
    const members = this.members(h, d?.creator_user_id ?? user.id);
    const creator = members[0]!.user;
    // Chip choices made before a program existed + the deterministic "sides" answer.
    const ov: DraftOverrides = { ...(d?.pending_overrides ?? {}) };
    const sidesAnswer = answers.find((a) => a.question_id === 'sides');
    if (sidesAnswer) ov.sides = { ...sidesFromAnswer(sidesAnswer.answer, creator, members), ...(ov.sides ?? {}) };

    const outcome = await runCompile({
      compiler: this.ctx.providers.compiler,
      creator,
      members,
      transcript: text,
      previous: d ? { yaml: d.source_yaml, title: d.title, transcript: d.transcript || null } : null,
      answers,
      overrides: hasOverrides(ov) ? toWalletOverrides(ov, creator, members) : null,
    });

    const now = this.ctx.clock.nowMs();
    const base: DraftRecord = d ?? {
      id: uuid(),
      huddle_id: h.id,
      creator_user_id: user.id,
      status: 'needs_clarification',
      kind: 'rules',
      title: null,
      questions: [],
      source_yaml: null,
      yaml: null,
      program: null,
      program_hash: null,
      readback: null,
      labels: {},
      errors: [],
      warnings: [],
      transcript: '',
      answers: [],
      dictation_sha256: null,
      acceptances: {},
      pending_overrides: null,
      compile_source: null,
      compile_attempts: 0,
      bet: null,
      created_at_ms: now,
      updated_at_ms: now,
    };
    const finished = outcome.program ? finishProgram(outcome.program, outcome.labels, this.names(h)) : null;
    const next: DraftRecord = {
      ...base,
      status: outcome.status,
      kind: outcome.kind,
      title: outcome.title,
      questions: outcome.questions,
      source_yaml: outcome.source_yaml,
      yaml: finished?.yaml ?? null,
      program: finished?.program ?? null,
      program_hash: finished?.program_hash ?? null,
      readback: finished?.readback ?? null,
      labels: finished?.labels ?? outcome.labels,
      errors: outcome.errors,
      warnings: outcome.warnings,
      transcript: [base.transcript, text].filter(Boolean).join(' ').slice(-MAX_TRANSCRIPT_CHARS),
      answers,
      dictation_sha256: dictationSha === undefined ? base.dictation_sha256 : dictationSha,
      acceptances: {}, // any recompile clears acceptances
      pending_overrides: finished ? null : base.pending_overrides,
      compile_source: outcome.source,
      compile_attempts: outcome.attempts,
      bet: null,
      updated_at_ms: now,
    };
    this.drafts.set(next.id, next);
    this.publish(next);
    return this.view(next);
  }

  // ---- PATCH -------------------------------------------------------------------

  patch(user: UserRecord, id: string, o: DraftOverrides): DraftView {
    const { d, h } = this.requireDraft(id, user.id);
    this.assertEditable(d, user);
    checkOverrides(o, d.kind);
    const members = this.members(h, d.creator_user_id);
    const creator = members[0]!.user;
    const now = this.ctx.clock.nowMs();
    let next: DraftRecord;
    if (!d.program) {
      // Nothing to re-canonicalize yet: remember the choices for the next compile.
      next = { ...d, pending_overrides: { ...(d.pending_overrides ?? {}), ...o }, acceptances: {}, updated_at_ms: now };
    } else {
      const r = parseWithOverrides(toYaml(d.program), toWalletOverrides(o, creator, members), creator, members);
      if (!r.ok) {
        next = { ...d, status: 'invalid', errors: r.errors, acceptances: {}, bet: null, updated_at_ms: now };
      } else {
        const f = finishProgram(r.program, d.labels, this.names(h));
        next = {
          ...d,
          status: d.questions.some((q) => q.kind !== 'region') ? 'needs_clarification' : 'ready',
          program: f.program,
          yaml: f.yaml,
          program_hash: f.program_hash,
          readback: f.readback,
          labels: f.labels,
          errors: [],
          warnings: r.warnings,
          acceptances: {},
          bet: null,
          updated_at_ms: now,
        };
      }
    }
    this.drafts.set(id, next);
    this.publish(next);
    return this.view(next);
  }

  // ---- audio -------------------------------------------------------------------

  private tts(text: string): Promise<AudioBlob> {
    const key = createHash('sha256').update(`${this.ctx.providers.tts.name}\n${text}`).digest('hex');
    let p = this.ttsCache.get(key);
    if (!p) {
      p = this.ctx.providers.tts.synthesize(text);
      this.ttsCache.set(key, p);
      p.catch(() => this.ttsCache.delete(key));
      if (this.ttsCache.size > 256) this.ttsCache.delete(this.ttsCache.keys().next().value!);
    }
    return p;
  }

  async readbackAudio(user: UserRecord, id: string): Promise<AudioBlob> {
    const { d } = this.requireDraft(id, user.id);
    if (!d.readback) throw new ApiError('WRONG_STATE', 'no read-back yet');
    return this.tts(d.readback.join('. '));
  }

  async questionAudio(user: UserRecord, id: string, qid: string): Promise<AudioBlob> {
    const { d } = this.requireDraft(id, user.id);
    const q: Question | undefined = d.questions.find((x) => x.id === qid);
    if (!q) throw new ApiError('NOT_FOUND', `question ${qid}`);
    return this.tts(q.text);
  }

  // ---- acceptance --------------------------------------------------------------

  private requireCounterparty(d: DraftRecord, user: UserRecord): { program: Program; index: number } {
    if (d.status !== 'ready' || !d.program || !d.program_hash) throw new ApiError('WRONG_STATE', 'draft not ready');
    if (d.kind === 'market') throw new ApiError('WRONG_STATE', 'market bets are accepted by funding');
    if (d.bet?.status === 'confirmed') throw new ApiError('WRONG_STATE', 'bet already created');
    const index = d.program.participants.indexOf(user.wallet);
    if (index < 1) throw new ApiError('WRONG_STATE', 'only counterparties accept');
    return { program: d.program, index };
  }

  acceptChallenge(user: UserRecord, id: string): { challenge_id: string; phrase: string } {
    const { d } = this.requireDraft(id, user.id);
    this.requireCounterparty(d, user);
    const words = randomWords(2) as [string, string];
    const phrase = `I accept ${words[0]} ${words[1]}`;
    const c = this.identity.challenges.issue(
      user.id,
      { kind: 'accept', draft_id: d.id, program_hash: d.program_hash!, words, phrase },
      ACCEPT_CHALLENGE_TTL_MS,
    );
    return { challenge_id: c.id, phrase };
  }

  async accept(
    user: UserRecord,
    id: string,
    body: { challenge_id: unknown; audio: Uint8Array; accept_sig: Uint8Array },
    hints: RequestHints = {},
  ): Promise<{ accepted: true; cos_bps: number; participant_index: number }> {
    const { d, h } = this.requireDraft(id, user.id);
    const { index } = this.requireCounterparty(d, user);
    const c = this.identity.challenges.require(body.challenge_id, user.id, 'accept');
    if (c.data.draft_id !== d.id || c.data.program_hash !== d.program_hash) throw new ApiError('CHALLENGE_EXPIRED', 'terms changed');
    checkWav(body.audio);
    if (body.accept_sig.length !== 64 || !verifyEd25519(body.accept_sig, acceptSigMessage(d.program_hash!, body.audio), user.wallet)) {
      throw new ApiError('WRONG_STATE', 'accept_sig does not verify', 400);
    }
    // Scribe: who said the phrase (diarization) …
    const t = await this.ctx.providers.stt.transcribe(body.audio, {
      mock_transcript: hints.mockTranscript ?? null,
      challenge_phrase: c.data.phrase,
    });
    const pick = pickSpeaker(t, (text) => acceptPhraseHeard(text, c.data.words));
    if (!pick) throw new ApiError('PHRASE_NOT_HEARD');
    // … ECAPA voiceprint on that speaker's audio, closed set = confirmed huddle members.
    const speech = sliceWav(body.audio, pick.segments);
    const v = await this.identity.verifyAcceptVoice(user, this.huddles.confirmedUsers(h), speech, hints);
    if (!v.matched) throw new ApiError('VOICE_NOT_MATCHED', `cos ${v.cos_bps}`);

    const now = this.ctx.clock.nowMs();
    const wavSha = createHash('sha256').update(body.audio).digest('hex');
    // Only the WAV's sha256 enters the acceptance leaf; the recording itself is not kept
    // (biometric data minimization, spec §1 #5).
    const next = this.drafts.update(d.id, (x) => {
      x.acceptances[user.id] = {
        user_id: user.id,
        participant_index: index,
        program_hash: d.program_hash!,
        wav_sha256: wavSha,
        accept_sig_b64: toBase64(body.accept_sig),
        cos_bps: v.cos_bps,
        at_ms: now,
      };
      x.updated_at_ms = now;
    });
    this.identity.challenges.markUsed(c.id);
    this.publish(next);
    return { accepted: true, cos_bps: v.cos_bps, participant_index: index };
  }

  // ---- agent ---------------------------------------------------------------------

  async agentSession(user: UserRecord, huddleId: string, draftId: string | null): Promise<{ mode: 'mock' | 'elevenlabs'; signed_url: string | null }> {
    this.huddles.requireForConfirmed(huddleId, user.id);
    if (draftId !== null) {
      const { d } = this.requireDraft(draftId, user.id);
      if (d.huddle_id !== huddleId) throw new ApiError('NOT_FOUND', `draft ${draftId}`);
    }
    return this.ctx.providers.agent.createSession({ huddle_id: huddleId, draft_id: draftId, user_id: user.id });
  }

  /**
   * ElevenLabs Agent compile tool (POST /webhooks/elevenlabs/tool): compiles
   * on behalf of the draft's creator, or the huddle creator for a new draft.
   */
  async compileTool(body: { draft_id?: string; huddle_id: string; transcript: string }): Promise<DraftView> {
    const h = this.huddles.huddles.get(body.huddle_id);
    if (!h) throw new ApiError('NOT_FOUND', `huddle ${body.huddle_id}`);
    let actorId = h.creator_user_id;
    if (body.draft_id) {
      const d = this.drafts.get(body.draft_id);
      if (!d || d.huddle_id !== h.id) throw new ApiError('NOT_FOUND', `draft ${body.draft_id}`);
      actorId = d.creator_user_id;
    }
    const actor = this.huddles.user(actorId);
    return this.compile(actor, {
      huddle_id: h.id,
      transcript: body.transcript,
      ...(body.draft_id ? { draft_id: body.draft_id } : {}),
    });
  }
}

function mergeAnswers(
  prev: { question_id: string; answer: string }[],
  next: { question_id: string; answer: string }[],
): { question_id: string; answer: string }[] {
  const m = new Map(prev.map((a) => [a.question_id, a.answer]));
  for (const a of next) m.set(a.question_id, a.answer);
  return [...m.entries()].map(([question_id, answer]) => ({ question_id, answer }));
}

export function decodeB64(s: unknown, what: string): Uint8Array {
  if (typeof s !== 'string') throw new ApiError('WRONG_STATE', `${what} required`, 400);
  try {
    return fromBase64(s);
  } catch {
    throw new ApiError('WRONG_STATE', `${what} must be base64`, 400);
  }
}
