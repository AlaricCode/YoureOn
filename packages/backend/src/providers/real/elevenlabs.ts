/**
 * ElevenLabs providers (paid; §13 spend guard):
 *  - Agent (Conversational AI): signed WebSocket URL for the app; the agent
 *    calls our compile tool at POST /v1/webhooks/elevenlabs/tool.
 *  - Scribe STT: diarized words → per-speaker segments + audio events.
 *    Scribe only diarizes; speaker *verification* is our ECAPA model (§8.1).
 *  - TTS: read-back / questions / announcer.
 *  - Sound Effects: the start signal (≤ 1.5 s, D-8).
 *
 * Constructing a provider from the Config asserts ALLOW_SPEND=1 and the API
 * key. Passing an `ElevenLabsClient` instead (tests, with an injected fetch)
 * skips the guard because the caller already holds credentials.
 */
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import type { AgentProvider, AudioBlob, SfxProvider, SttContext, SttProvider, Transcript, TranscriptSegment, TtsProvider } from '../types.js';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
export const SCRIBE_MODEL_ID = 'scribe_v1';
export const TTS_MODEL_ID = 'eleven_multilingual_v2';
/** A stock ElevenLabs voice ("Rachel"); override with the client option. */
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
export const START_SFX_PROMPT = 'single short bright referee whistle blast, clean, no echo';
export const START_SFX_SECONDS = 1;

export type FetchFn = typeof fetch;

export interface ElevenLabsClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
  voiceId?: string;
  agentId?: string | null;
  timeoutMs?: number;
}

export class ElevenLabsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

export class ElevenLabsClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly voiceId: string;
  readonly agentId: string | null;
  private readonly f: FetchFn;
  private readonly timeoutMs: number;

  constructor(o: ElevenLabsClientOptions) {
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.voiceId = o.voiceId ?? DEFAULT_VOICE_ID;
    this.agentId = o.agentId ?? null;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  /** Builds a client from the config after the spend guard (SPEND_DISABLED unless ALLOW_SPEND=1). */
  static fromConfig(cfg: Config, role: string): ElevenLabsClient {
    assertSpendAllowed(cfg, `${role}=elevenlabs`);
    if (!cfg.apiKeys.elevenlabs) throw new Error(`${role}=elevenlabs requires ELEVENLABS_API_KEY`);
    return new ElevenLabsClient({ apiKey: cfg.apiKeys.elevenlabs, agentId: cfg.apiKeys.elevenlabsAgentId });
  }

  async request(path: string, init: { method: 'GET' | 'POST'; body?: string | FormData; json?: boolean; accept?: string }): Promise<Response> {
    const headers: Record<string, string> = { 'xi-api-key': this.apiKey };
    if (init.json) headers['content-type'] = 'application/json';
    if (init.accept) headers['accept'] = init.accept;
    const r = await this.f(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new ElevenLabsError(r.status, `ElevenLabs ${init.method} ${path} → HTTP ${r.status} ${text.slice(0, 200)}`);
    }
    return r;
  }

  async audio(path: string, body: unknown): Promise<AudioBlob> {
    const r = await this.request(path, { method: 'POST', body: JSON.stringify(body), json: true, accept: 'audio/mpeg' });
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length === 0) throw new ElevenLabsError(502, `ElevenLabs ${path} returned no audio`);
    return { mime: 'audio/mpeg', bytes };
  }
}

function clientOf(x: Config | ElevenLabsClient, role: string): ElevenLabsClient {
  return x instanceof ElevenLabsClient ? x : ElevenLabsClient.fromConfig(x, role);
}

// ---- Scribe ------------------------------------------------------------------------

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type?: 'word' | 'spacing' | 'audio_event';
  speaker_id?: string | null;
}

interface ScribeResponse {
  text?: string;
  words?: ScribeWord[];
}

/** Scribe words → contiguous per-speaker segments (ms) and audio events. */
export function scribeToTranscript(r: ScribeResponse): Transcript {
  const words = Array.isArray(r.words) ? r.words : [];
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
  const text = typeof r.text === 'string' ? r.text : segments.map((s) => s.text).join(' ');
  return { text, segments, audio_events };
}

export class ElevenLabsStt implements SttProvider {
  readonly name = 'elevenlabs';
  readonly client: ElevenLabsClient;
  constructor(cfg: Config | ElevenLabsClient) {
    this.client = clientOf(cfg, 'STT_PROVIDER');
  }

  /** Scribe with diarization and audio-event tags. Mock hints in `ctx` are ignored. */
  async transcribe(audio: Uint8Array, _ctx?: SttContext): Promise<Transcript> {
    const form = new FormData();
    form.append('model_id', SCRIBE_MODEL_ID);
    form.append('diarize', 'true');
    form.append('tag_audio_events', 'true');
    form.append('timestamps_granularity', 'word');
    form.append('file', new Blob([Uint8Array.from(audio)], { type: 'audio/wav' }), 'audio.wav');
    const r = await this.client.request('/v1/speech-to-text', { method: 'POST', body: form });
    return scribeToTranscript((await r.json()) as ScribeResponse);
  }
}

// ---- TTS / SFX ---------------------------------------------------------------------

export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly client: ElevenLabsClient;
  constructor(cfg: Config | ElevenLabsClient) {
    this.client = clientOf(cfg, 'TTS_PROVIDER');
  }
  async synthesize(text: string): Promise<AudioBlob> {
    const t = text.trim().slice(0, 2500);
    if (!t) throw new Error('TTS: empty text');
    return this.client.audio(`/v1/text-to-speech/${encodeURIComponent(this.client.voiceId)}?output_format=mp3_44100_128`, {
      text: t,
      model_id: TTS_MODEL_ID,
    });
  }
}

export class ElevenLabsSfx implements SfxProvider {
  readonly name = 'elevenlabs';
  readonly client: ElevenLabsClient;
  private cached: Promise<AudioBlob> | null = null;
  constructor(cfg: Config | ElevenLabsClient) {
    this.client = clientOf(cfg, 'SFX_PROVIDER');
  }
  /** Generated once per process and reused (the start sound never changes). */
  async startSound(): Promise<AudioBlob> {
    this.cached ??= this.client
      .audio('/v1/sound-generation', { text: START_SFX_PROMPT, duration_seconds: START_SFX_SECONDS, prompt_influence: 0.6 })
      .catch((e) => {
        this.cached = null;
        throw e;
      });
    return this.cached;
  }
}

// ---- Agent ---------------------------------------------------------------------------

export class ElevenLabsAgent implements AgentProvider {
  readonly name = 'elevenlabs';
  readonly client: ElevenLabsClient;
  constructor(cfg: Config | ElevenLabsClient) {
    this.client = clientOf(cfg, 'AGENT_PROVIDER');
    if (!this.client.agentId) throw new Error('AGENT_PROVIDER=elevenlabs requires ELEVENLABS_AGENT_ID');
  }
  /**
   * Signed URL for a private agent conversation. The app passes huddle_id /
   * draft_id as dynamic variables when it opens the socket; the agent's
   * compile tool posts them back to /v1/webhooks/elevenlabs/tool.
   */
  async createSession(): Promise<{ mode: 'elevenlabs'; signed_url: string | null }> {
    const r = await this.client.request(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(this.client.agentId!)}`, {
      method: 'GET',
    });
    const j = (await r.json()) as { signed_url?: unknown };
    if (typeof j.signed_url !== 'string' || !/^wss:\/\//.test(j.signed_url)) throw new ElevenLabsError(502, 'ElevenLabs: no signed_url');
    return { mode: 'elevenlabs', signed_url: j.signed_url };
  }
}
