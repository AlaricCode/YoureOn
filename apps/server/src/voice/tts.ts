// Stage TTS: the ElevenLabs text-to-speech clip of each line the projector speaks (packages/shared
// stage-voice.ts), the appeal panel's votes included, served to stage sessions at
// GET /v1/stage/tts/:clip_id (src/stage/audio.ts), so the key never leaves the server.
// Spec: docs/planning/API-CONTRACT.md §2.17.
//
// Gate (stageAudioGate): on only with ELEVENLABS_API_KEY and ALLOW_SPEND=true (every clip bills
// characters), and never with STAGE_TTS=off (the kill switch). Off means no clip and no network:
// the stage speaks the same line with the browser's voice.
//
// clip_id = sha256(voice_id \n model \n text). A clip never changes, so the GET is immutable, and
// a repeated line ("Paid. Jake takes $2.00.") is generated once.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TTS_MODEL } from '@youre-on/shared/judge/el-config';
import { CLIP_ID_RE, stageTtsPath, type StageVoiceName } from '@youre-on/shared/stage-voice';
import type { Env } from '../env';
import type { Logger } from '../log';
import {
  createElevenLabsClient,
  UpstreamError,
  type ElevenLabsMediaClient,
  type FetchLike,
} from './elevenlabs';

export type StageAudioOff = 'no_key' | 'off' | 'spend_disabled';
export type StageAudioGate = { on: true } | { on: false; reason: StageAudioOff };

/** Is the stage's ElevenLabs voice (TTS, and SFX_PROVIDER=auto's Sound Effects) on? */
export function stageAudioGate(
  env: Pick<Env, 'ELEVENLABS_API_KEY' | 'ALLOW_SPEND' | 'STAGE_TTS'>,
): StageAudioGate {
  if (env.STAGE_TTS === 'off') return { on: false, reason: 'off' };
  if (!env.ELEVENLABS_API_KEY) return { on: false, reason: 'no_key' };
  if (env.ALLOW_SPEND !== true) return { on: false, reason: 'spend_disabled' };
  return { on: true };
}

/**
 * Premade ElevenLabs voices every account has (the voice library's defaults), one per speaker:
 * the judge (George) and the three appeal seats (Sarah, Brian, Lily). ELEVENLABS_JUDGE_VOICE_ID
 * (the Voice Design judge) and ELEVENLABS_PANEL_VOICE_IDS override them.
 */
export const DEFAULT_STAGE_VOICES: Readonly<Record<StageVoiceName, string>> = {
  judge: 'JBFqnCBsd6RMkjVDRZzb',
  seat_1: 'EXAVITQu4vr4xnSDxMaL',
  seat_2: 'nPczCjzI2devNBz1zQrb',
  seat_3: 'pFZP5JQG7iQjIQuC4Bku',
};

export function stageVoiceIds(
  env: Pick<Env, 'ELEVENLABS_JUDGE_VOICE_ID' | 'ELEVENLABS_PANEL_VOICE_IDS'>,
): Record<StageVoiceName, string> {
  const panel = (env.ELEVENLABS_PANEL_VOICE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seats = panel.length === 3 ? panel : null;
  return {
    judge: env.ELEVENLABS_JUDGE_VOICE_ID ?? DEFAULT_STAGE_VOICES.judge,
    seat_1: seats?.[0] ?? DEFAULT_STAGE_VOICES.seat_1,
    seat_2: seats?.[1] ?? DEFAULT_STAGE_VOICES.seat_2,
    seat_3: seats?.[2] ?? DEFAULT_STAGE_VOICES.seat_3,
  };
}

export const clipIdOf = (voiceId: string, model: string, text: string): string =>
  createHash('sha256').update(`${voiceId}\n${model}\n${text}`).digest('hex');

/** Where clips go on disk unless told otherwise. */
export const DEFAULT_CLIP_DIR = join(tmpdir(), 'youre-on-stage-audio');
/** Memory cap: ~600 two-sentence MP3 lines at 128 kbps. */
export const CLIP_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Clip bytes by id: memory (LRU, capped in bytes) in front of an optional directory, so a local
 * restart does not pay for its clips again. Disk errors are logged and ignored: the cache is an
 * optimisation, never a reason to fail a clip.
 */
export class ClipCache {
  private readonly mem = new Map<string, Uint8Array>();
  private bytesHeld = 0;
  private readonly maxBytes: number;
  private readonly dir: string | null;
  private readonly log: Logger | undefined;
  private dirReady: Promise<void> | null = null;

  /** `dir` null: memory only. Default DEFAULT_CLIP_DIR. */
  constructor(o: { maxBytes?: number; dir?: string | null; log?: Logger } = {}) {
    this.maxBytes = o.maxBytes ?? CLIP_CACHE_BYTES;
    this.dir = o.dir === undefined ? DEFAULT_CLIP_DIR : o.dir;
    this.log = o.log;
  }

  get size(): { entries: number; bytes: number } {
    return { entries: this.mem.size, bytes: this.bytesHeld };
  }

  private remember(id: string, bytes: Uint8Array) {
    const old = this.mem.get(id);
    if (old) {
      this.mem.delete(id);
      this.bytesHeld -= old.length;
    }
    if (bytes.length > this.maxBytes) return;
    this.mem.set(id, bytes);
    this.bytesHeld += bytes.length;
    for (const [k, v] of this.mem) {
      if (this.bytesHeld <= this.maxBytes) break;
      this.mem.delete(k);
      this.bytesHeld -= v.length;
    }
  }

  private file(id: string): string | null {
    return this.dir && CLIP_ID_RE.test(id) ? join(this.dir, `${id}.mp3`) : null;
  }

  async get(id: string): Promise<Uint8Array | null> {
    const hit = this.mem.get(id);
    if (hit) {
      this.remember(id, hit); // most recently used
      return hit;
    }
    const f = this.file(id);
    if (!f) return null;
    try {
      const bytes = new Uint8Array(await readFile(f));
      if (bytes.length === 0) return null;
      this.remember(id, bytes);
      return bytes;
    } catch {
      return null; // not on disk (ENOENT), or unreadable
    }
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    this.remember(id, bytes);
    const f = this.file(id);
    if (!f) return;
    try {
      this.dirReady ??= mkdir(this.dir!, { recursive: true }).then(() => undefined);
      await this.dirReady;
      const tmp = `${f}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, f); // never a half-written clip under its real name
    } catch (err) {
      this.dirReady = null;
      this.log?.warn('stage_voice.cache_write_failed', { err: String(err) });
    }
  }
}

interface Line {
  voice: StageVoiceName;
  voice_id: string;
  text: string;
}

export interface StageClip {
  clip_id: string;
  audio_url: string;
  voice_id: string;
}

/** Lines remembered for GET /v1/stage/tts/:clip_id (a pitch day says a few dozen). */
export const MAX_LINES = 2_000;

export class StageTts {
  readonly model: string;
  readonly voices: Readonly<Record<StageVoiceName, string>>;
  private readonly client: Pick<ElevenLabsMediaClient, 'textToSpeech'>;
  private readonly cache: ClipCache;
  private readonly log: Logger;
  private readonly maxLines: number;
  private readonly lines = new Map<string, Line>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  /** ElevenLabs requests sent (each one bills its characters). */
  requests = 0;

  constructor(o: {
    client: Pick<ElevenLabsMediaClient, 'textToSpeech'>;
    model: string;
    voices: Record<StageVoiceName, string>;
    cache: ClipCache;
    log: Logger;
    maxLines?: number;
  }) {
    this.client = o.client;
    this.model = o.model;
    this.voices = { ...o.voices };
    this.cache = o.cache;
    this.log = o.log;
    this.maxLines = o.maxLines ?? MAX_LINES;
  }

  /** Registers a line and starts generating it (unless it is cached). Never throws. */
  clip(voice: StageVoiceName, text: string): StageClip {
    const voice_id = this.voices[voice];
    const clip_id = clipIdOf(voice_id, this.model, text);
    this.lines.delete(clip_id);
    this.lines.set(clip_id, { voice, voice_id, text });
    while (this.lines.size > this.maxLines) {
      const oldest = this.lines.keys().next();
      if (oldest.done) break;
      this.lines.delete(oldest.value);
    }
    this.generate(clip_id).catch(() => undefined); // logged in generate; a GET retries
    return { clip_id, audio_url: stageTtsPath(clip_id), voice_id };
  }

  /**
   * The clip's MP3: cached, in flight, or generated now for a registered line. null for an id
   * this server never registered and has no bytes for. Throws UpstreamError when ElevenLabs fails.
   */
  async bytes(clipId: string): Promise<Uint8Array | null> {
    if (!CLIP_ID_RE.test(clipId)) return null;
    const cached = await this.cache.get(clipId);
    if (cached) return cached;
    if (!this.lines.has(clipId) && !this.inflight.has(clipId)) return null;
    return this.generate(clipId);
  }

  private generate(clipId: string): Promise<Uint8Array> {
    const running = this.inflight.get(clipId);
    if (running) return running;
    const p = (async () => {
      const cached = await this.cache.get(clipId);
      if (cached) return cached;
      const line = this.lines.get(clipId);
      if (!line) throw new UpstreamError('error', 'unknown clip');
      const t0 = Date.now();
      this.requests += 1;
      try {
        const bytes = await this.client.textToSpeech({
          voiceId: line.voice_id,
          text: line.text,
          modelId: this.model,
        });
        await this.cache.put(clipId, bytes);
        this.log.info('stage_voice.tts', {
          clip_id: clipId,
          voice: line.voice,
          chars: line.text.length,
          bytes: bytes.length,
          ms: Date.now() - t0,
        });
        return bytes;
      } catch (err) {
        const e = err instanceof UpstreamError ? err : null;
        this.log.warn('stage_voice.tts_failed', {
          clip_id: clipId,
          voice: line.voice,
          kind: e?.kind ?? 'error',
          status: e?.status ?? null,
          ms: Date.now() - t0,
        });
        throw err;
      }
    })();
    this.inflight.set(clipId, p);
    void p.then(
      () => this.inflight.delete(clipId),
      () => this.inflight.delete(clipId),
    );
    return p;
  }
}

/** The stage TTS service the env asks for, or null when the gate is closed (no client is built). */
export function createStageTts(
  env: Env,
  o: { log: Logger; fetch?: FetchLike; cache?: ClipCache },
): StageTts | null {
  if (!stageAudioGate(env).on) return null;
  return new StageTts({
    client: createElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY, fetch: o.fetch }),
    model: env.STAGE_TTS_MODEL ?? DEFAULT_TTS_MODEL,
    voices: stageVoiceIds(env),
    cache: o.cache ?? new ClipCache({ log: o.log }),
    log: o.log,
  });
}
