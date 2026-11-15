// Live ElevenLabs voice providers (paid; spend-guarded in fromEnv), on top of the shared client
// in src/voice/elevenlabs.ts.
//
// Ported from Verdict packages/backend/src/providers/real/elevenlabs.ts lines ~100-202:
//  - scribeToTranscript: Scribe words -> contiguous per-speaker segments (ms) + audio events.
//    Scribe only diarizes; we never verify speakers (no voiceprints, ARCHITECTURE §6).
//  - ElevenLabsSfx's once-per-process cached generation, here one clip per stage cue
//    (API-CONTRACT §2.6 cue kinds) instead of Verdict's single start whistle.
import type { Env } from '../../env';
import {
  createElevenLabsClient,
  type ElevenLabsMediaClient,
  type ScribeResponse,
} from '../../voice/elevenlabs';
import { assertSpendAllowed } from '../spend';
import type {
  AudioBlob,
  SfxCue,
  SfxProvider,
  SttOptions,
  SttProvider,
  Transcript,
  TranscriptSegment,
} from '../types';

/** Scribe words -> per-speaker segments and audio events. */
export function scribeToTranscript(r: ScribeResponse): Transcript {
  const words = r.words ?? [];
  const segments: TranscriptSegment[] = [];
  const audio_events: Transcript['audio_events'] = [];
  let cur: TranscriptSegment | null = null;
  for (const w of words) {
    const start = Math.max(0, Math.round((w.start ?? 0) * 1000));
    const end = Math.max(start, Math.round((w.end ?? w.start ?? 0) * 1000));
    if (w.type === 'audio_event') {
      audio_events.push({ t_ms: start, label: w.text.replace(/^[([]|[)\]]$/g, '').trim() });
      continue;
    }
    if (w.type === 'spacing') {
      if (cur) cur.text += w.text;
      continue;
    }
    const speaker = w.speaker_id ?? null;
    if (!cur || cur.speaker !== speaker) {
      if (cur) segments.push(cur);
      cur = { start_ms: start, end_ms: end, speaker, text: w.text };
    } else {
      cur.text += cur.text.endsWith(' ') || w.text.startsWith(' ') ? w.text : ` ${w.text}`;
      cur.end_ms = end;
    }
  }
  if (cur) segments.push(cur);
  for (const s of segments) s.text = s.text.replace(/\s+/g, ' ').trim();
  const text = typeof r.text === 'string' ? r.text.trim() : segments.map((s) => s.text).join(' ');
  return { text, segments, audio_events, language_code: r.language_code ?? null };
}

export class LiveStt implements SttProvider {
  readonly name = 'live' as const;
  constructor(private readonly client: Pick<ElevenLabsMediaClient, 'speechToText'>) {}

  static fromEnv(
    env: Env,
    o: { fetch?: Parameters<typeof createElevenLabsClient>[0]['fetch'] } = {},
  ) {
    assertSpendAllowed(env, 'STT_PROVIDER=live');
    if (!env.ELEVENLABS_API_KEY) throw new Error('STT_PROVIDER=live requires ELEVENLABS_API_KEY');
    return new LiveStt(createElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY, fetch: o.fetch }));
  }

  /** `mockTranscript` is ignored. Throws UpstreamError (timeout after 6 s, HTTP error, bad shape). */
  async transcribe(audio: Uint8Array, opts: SttOptions): Promise<Transcript> {
    const r = await this.client.speechToText({
      audio,
      mime: opts.mime,
      filename: opts.filename,
      signal: opts.signal,
    });
    return scribeToTranscript(r);
  }
}

/** Sound Effects prompts per stage cue. Short clips; the stage plays them (API-CONTRACT §2.6). */
export const CUE_PROMPTS: Record<SfxCue, { text: string; durationSeconds: number }> = {
  gavel: { text: 'single wooden judge gavel strike, close, dry, no echo', durationSeconds: 1 },
  drumroll: { text: 'short snare drum roll building tension, ends abruptly', durationSeconds: 2.5 },
  buzzer: { text: 'game show wrong-answer buzzer, short, loud', durationSeconds: 1 },
  cheer: { text: 'small crowd cheering and clapping, celebratory, short', durationSeconds: 2 },
};
const PROMPT_INFLUENCE = 0.6;

export class LiveSfx implements SfxProvider {
  readonly name = 'live' as const;
  private readonly cache = new Map<SfxCue, Promise<AudioBlob>>();
  constructor(private readonly client: Pick<ElevenLabsMediaClient, 'soundGeneration'>) {}

  static fromEnv(
    env: Env,
    o: { fetch?: Parameters<typeof createElevenLabsClient>[0]['fetch'] } = {},
  ) {
    assertSpendAllowed(env, 'SFX_PROVIDER=live');
    if (!env.ELEVENLABS_API_KEY) throw new Error('SFX_PROVIDER=live requires ELEVENLABS_API_KEY');
    return new LiveSfx(createElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY, fetch: o.fetch }));
  }

  /** Generated once per cue per process; a failed generation is not cached (the next call retries). */
  cue(kind: SfxCue): Promise<AudioBlob> {
    let p = this.cache.get(kind);
    if (!p) {
      const prompt = CUE_PROMPTS[kind];
      p = this.client
        .soundGeneration({
          text: prompt.text,
          durationSeconds: prompt.durationSeconds,
          promptInfluence: PROMPT_INFLUENCE,
        })
        .then((bytes): AudioBlob => ({ mime: 'audio/mpeg', bytes }));
      p.catch(() => this.cache.delete(kind));
      this.cache.set(kind, p);
    }
    return p;
  }
}
