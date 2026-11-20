// The projector's voice, server side. After each bet event goes out (hub.onBetEvent), the line
// the stage speaks for it (shared stage-voice.ts: the ruling, the payout, each appeal vote in its
// seat's voice) becomes an ElevenLabs clip (voice/tts.ts), and a stage.voice frame tells the
// room's stage sessions where it is. The frame goes out at once, before the clip exists:
// GET /v1/stage/tts/:clip_id waits for the generation it started. Only while the stage TTS is
// on, and only a fresh event in a room whose stage is connected (no clip nobody hears); without a
// frame the stage speaks the same line with the browser's voice, so the judge is heard either way.
//
// One judge at a time: in a bet a voice judge hosts (A's phone relayed a judge.line for it), the
// ruling and the payout are the phone's to say (their judge.cue lines are speak:true), so no clip
// and no frame for them (leftToPhoneJudge); the stage applies the same rule to its own history
// and stays quiet too. Appeal votes are still voiced here. Also provides the stage cues' Sound
// Effects clips, cached like the voice clips.
// Spec: docs/planning/API-CONTRACT.md §4.5.
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { betEvents, bets, users } from '@youre-on/db';
import { StageCueKind, type StageAudioResponse } from '@youre-on/shared/api';
import {
  leftToPhoneJudge,
  PHONE_JUDGE_EVENT,
  PHONE_JUDGE_SAYS,
  stageLineFor,
  stageSfxPath,
  VoicedEventType,
  type StageNames,
} from '@youre-on/shared/stage-voice';
import type { AppDeps } from '../context';
import { CUE_PROMPTS } from '../providers/live/voice';
import type { AudioBlob, SfxCue } from '../providers/types';
import type { BetEnvelope } from '../realtime/hub';
import { stageAudioGate, type ClipCache, type StageTts } from '../voice/tts';

/** An event published this long after its ts is a re-publish, not news: not voiced. */
export const VOICE_FRESH_MS = 30_000;
/** Bets whose party names (and phone judge) are remembered: neither changes back during a bet. */
const NAMES_KEPT = 500;

type VoiceDeps = Pick<AppDeps, 'db' | 'hub' | 'log' | 'now' | 'env' | 'providers'>;

/** The cache key of a cue's Sound Effects clip: its prompt (a new prompt is a new clip). */
const sfxKey = (kind: SfxCue) =>
  createHash('sha256')
    .update(`sfx\n${JSON.stringify(CUE_PROMPTS[kind])}`)
    .digest('hex');

export class StageVoice {
  private readonly names = new Map<string, StageNames>();
  /** Bets a voice judge hosts (a judge.line went out; bet events are append-only). */
  private readonly phoneJudged = new Set<string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly deps: VoiceDeps,
    /** null: the stage TTS is off (stageAudioGate). */
    readonly tts: StageTts | null,
    private readonly sfxCache: ClipCache | null = null,
  ) {}

  /** hub.onBetEvent listener. Never throws or blocks the fan-out. */
  readonly onBetEvent = (env: BetEnvelope, roomId: string | null): void => {
    if (!this.tts || !roomId) return;
    if (env.type === PHONE_JUDGE_EVENT) return this.rememberPhoneJudge(env.bet_id);
    if (!VoicedEventType.safeParse(env.type).success) return;
    if (!this.deps.hub.hasStage(roomId)) return;
    const ts = typeof env.ts === 'string' ? Date.parse(env.ts) : NaN;
    if (Number.isFinite(ts) && Math.abs(this.deps.now() - ts) > VOICE_FRESH_MS) return;
    const p = this.voice(env, roomId).catch((err: unknown) =>
      this.deps.log.warn('stage_voice.failed', {
        bet_id: env.bet_id,
        seq: env.seq,
        type: env.type,
        err: String(err),
      }),
    );
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  };

  private async voice(env: BetEnvelope, roomId: string): Promise<void> {
    // judge.cue lines carry the names in their [EVENT] values
    const names = env.type === 'judge.cue' ? { A: null, B: null } : await this.namesOf(env.bet_id);
    const line = stageLineFor({ type: env.type, payload: env.payload }, names);
    if (!line) return;
    // (only the phone judge's types cost a lookup: an appeal vote is always the stage's)
    const phone = PHONE_JUDGE_SAYS.has(env.type) && (await this.phoneJudge(env.bet_id));
    if (leftToPhoneJudge(env.type, phone)) {
      this.deps.log.info('stage_voice.phone_judge', {
        bet_id: env.bet_id,
        seq: env.seq,
        type: env.type,
      });
      return;
    }
    const clip = this.tts!.clip(line.voice, line.text);
    this.deps.hub.publishToStage(roomId, {
      op: 'stage.voice',
      bet_id: env.bet_id,
      seq: env.seq,
      type: VoicedEventType.parse(env.type),
      voice: line.voice,
      text: line.text,
      clip_id: clip.clip_id,
      audio_url: clip.audio_url,
    });
    this.deps.log.info('stage_voice.line', {
      bet_id: env.bet_id,
      seq: env.seq,
      type: env.type,
      voice: line.voice,
      clip_id: clip.clip_id,
    });
  }

  private rememberPhoneJudge(betId: string): void {
    if (this.phoneJudged.has(betId)) return;
    if (this.phoneJudged.size >= NAMES_KEPT)
      this.phoneJudged.delete(this.phoneJudged.values().next().value!);
    this.phoneJudged.add(betId);
  }

  /** Does a voice judge host the bet (has it relayed a judge.line)? */
  private async phoneJudge(betId: string): Promise<boolean> {
    if (this.phoneJudged.has(betId)) return true;
    const [row] = await this.deps.db
      .select({ seq: betEvents.seq })
      .from(betEvents)
      .where(and(eq(betEvents.bet_id, betId), eq(betEvents.type, PHONE_JUDGE_EVENT)))
      .limit(1);
    if (row) this.rememberPhoneJudge(betId);
    return row !== undefined;
  }

  private async namesOf(betId: string): Promise<StageNames> {
    const known = this.names.get(betId);
    if (known) return known;
    const [b] = await this.deps.db
      .select({ a: bets.party_a_id, b: bets.party_b_id })
      .from(bets)
      .where(eq(bets.id, betId))
      .limit(1);
    if (!b) return { A: null, B: null };
    const rows = await this.deps.db
      .select({ id: users.id, name: users.display_name })
      .from(users)
      .where(inArray(users.id, [b.a, b.b]));
    const name = (id: string) => rows.find((r) => r.id === id)?.name ?? null;
    const out = { A: name(b.a), B: name(b.b) };
    if (this.names.size >= NAMES_KEPT) this.names.delete(this.names.keys().next().value!);
    this.names.set(betId, out);
    return out;
  }

  /** Resolves once every line in flight has been sent (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Cue clips come from ElevenLabs (else the stage synthesizes its own). */
  get sfxLive(): boolean {
    return this.deps.providers.sfx.name === 'live';
  }

  /** GET /v1/stage/audio. */
  status(): StageAudioResponse {
    const gate = stageAudioGate(this.deps.env);
    return {
      tts: this.tts !== null,
      tts_off: this.tts ? null : gate.on ? 'off' : gate.reason,
      model: this.tts?.model ?? null,
      sfx: this.sfxLive
        ? {
            gavel: stageSfxPath('gavel'),
            drumroll: stageSfxPath('drumroll'),
            buzzer: stageSfxPath('buzzer'),
            cheer: stageSfxPath('cheer'),
          }
        : null,
    };
  }

  /** A cue's clip: the cache, else providers.sfx (which generates it once per process). */
  async sfx(kind: SfxCue): Promise<AudioBlob> {
    const key = sfxKey(kind);
    const hit = await this.sfxCache?.get(key);
    if (hit) return { mime: 'audio/mpeg', bytes: hit };
    const blob = await this.deps.providers.sfx.cue(kind);
    if (blob.mime === 'audio/mpeg') await this.sfxCache?.put(key, blob.bytes);
    return blob;
  }

  /**
   * Generates the four cue clips in the background (startServer), when they are live, so the
   * first gavel does not wait on ElevenLabs.
   */
  prewarm(): void {
    if (!this.sfxLive) return;
    for (const kind of StageCueKind.options)
      this.sfx(kind).then(
        (b) => this.deps.log.info('stage_voice.sfx_ready', { kind, bytes: b.bytes.length }),
        (err: unknown) => this.deps.log.warn('stage_voice.sfx_failed', { kind, err: String(err) }),
      );
  }
}
