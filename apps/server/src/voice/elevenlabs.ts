// Minimal ElevenLabs REST client for the server (FINDINGS §3.10: "Server: plain fetch or
// @elevenlabs/elevenlabs-js"). Only what the running server needs: the conversation token,
// (for src/providers, behind STT_PROVIDER / SFX_PROVIDER) Scribe speech-to-text and Sound Effects,
// and text-to-speech for the stage's voice (src/voice/tts.ts).
// `fetch` is injectable so tests mock the HTTP call (no key exists yet: PENDING-KEY).
//
// speechToText / soundGeneration are ported from Verdict
// packages/backend/src/providers/real/elevenlabs.ts (ElevenLabsStt, ElevenLabsSfx), re-shaped to
// this client's error type and deadlines (API-CONTRACT §1.8: STT 6 s) and to `scribe_v2` (§2.11).
import { z } from 'zod/v4';
import { ElTokenResponse } from '@youre-on/shared/judge/voice';

export const ELEVENLABS_API = 'https://api.elevenlabs.io';
/** API-CONTRACT §1.8: server-side outbound deadline for the ElevenLabs token. */
export const EL_TOKEN_TIMEOUT_MS = 3_000;
/** API-CONTRACT §1.8: server-side outbound deadline for ElevenLabs STT. */
export const EL_STT_TIMEOUT_MS = 6_000;
/** Sound Effects are generated once per cue and cached, off any latency path. */
export const EL_SFX_TIMEOUT_MS = 30_000;
/**
 * Stage TTS clips are generated as their event goes out. The stage waits for the clip and speaks
 * with the browser's voice once it gives up, so this only bounds a stuck request.
 */
export const EL_TTS_TIMEOUT_MS = 10_000;
/** MP3 every browser decodes (`output_format` query of POST /v1/text-to-speech/{voice_id}). */
export const EL_TTS_OUTPUT_FORMAT = 'mp3_44100_128';
/** API-CONTRACT §2.11 (FINDINGS §4 Verification). */
export const SCRIBE_MODEL_ID = 'scribe_v2';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'timeout' | 'error' | 'not_configured',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface ConversationToken {
  token: string;
  conversation_id: string;
}

export interface ElevenLabsClient {
  /** `GET /v1/convai/conversation/token?agent_id=…` with `xi-api-key` (API-CONTRACT §2.6). */
  conversationToken(agentId: string): Promise<ConversationToken>;
}

/** Scribe `POST /v1/speech-to-text` 200 body (the fields we read; extra fields pass through). */
export const ScribeWord = z.looseObject({
  text: z.string(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  type: z.enum(['word', 'spacing', 'audio_event']).nullish(),
  speaker_id: z.string().nullish(),
});
export const ScribeResponse = z.looseObject({
  text: z.string().nullish(),
  language_code: z.string().nullish(),
  words: z.array(ScribeWord).nullish(),
});
export type ScribeResponse = z.infer<typeof ScribeResponse>;

/** Scribe and Sound Effects (paid; only reached through src/providers behind the spend guard). */
export interface ElevenLabsMediaClient {
  /** Diarized, word-timestamped, audio-event-tagged transcript. Deadline EL_STT_TIMEOUT_MS. */
  speechToText(req: {
    audio: Uint8Array;
    mime: string;
    filename?: string;
    signal?: AbortSignal;
  }): Promise<ScribeResponse>;
  /** `POST /v1/sound-generation` -> MP3 bytes. Deadline EL_SFX_TIMEOUT_MS. */
  soundGeneration(req: {
    text: string;
    durationSeconds?: number;
    promptInfluence?: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  /**
   * `POST /v1/text-to-speech/{voice_id}?output_format=…` `{text, model_id}` -> MP3 bytes.
   * Deadline EL_TTS_TIMEOUT_MS.
   */
  textToSpeech(req: {
    voiceId: string;
    text: string;
    modelId: string;
    outputFormat?: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export function createElevenLabsClient(o: {
  apiKey: string | undefined;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  sttTimeoutMs?: number;
  sfxTimeoutMs?: number;
  ttsTimeoutMs?: number;
}): ElevenLabsClient & ElevenLabsMediaClient {
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
  const base = (o.baseUrl ?? ELEVENLABS_API).replace(/\/+$/, '');
  const timeoutMs = o.timeoutMs ?? EL_TOKEN_TIMEOUT_MS;

  /** One request with a deadline; maps failures to UpstreamError and never echoes the body. */
  async function send(
    label: string,
    url: string,
    init: RequestInit & { headers: Record<string, string> },
    ms: number,
    outer?: AbortSignal,
  ): Promise<Response> {
    if (!o.apiKey) throw new UpstreamError('not_configured', 'ELEVENLABS_API_KEY is not set');
    const deadline = AbortSignal.timeout(ms);
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: { 'xi-api-key': o.apiKey, ...init.headers },
        signal: outer ? AbortSignal.any([deadline, outer]) : deadline,
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new UpstreamError('timeout', `${label} timed out after ${ms} ms`);
      throw new UpstreamError('error', `${label} request failed: ${String(e)}`);
    }
    if (!res.ok) {
      // Never echo the body: it may quote the request.
      throw new UpstreamError('error', `${label} HTTP ${res.status}`, res.status);
    }
    return res;
  }

  return {
    async conversationToken(agentId) {
      const url = `${base}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`;
      const res = await send(
        'ElevenLabs token',
        url,
        { method: 'GET', headers: { accept: 'application/json' } },
        timeoutMs,
      );
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new UpstreamError('error', 'ElevenLabs token: response is not JSON', res.status);
      }
      const parsed = ElTokenResponse.safeParse(body);
      if (!parsed.success)
        throw new UpstreamError('error', 'ElevenLabs token: unexpected response shape', res.status);
      return parsed.data;
    },

    async speechToText(req) {
      const form = new FormData();
      form.append('model_id', SCRIBE_MODEL_ID);
      form.append('diarize', 'true');
      form.append('tag_audio_events', 'true');
      form.append('timestamps_granularity', 'word');
      form.append(
        'file',
        new Blob([Uint8Array.from(req.audio)], { type: req.mime }),
        req.filename ?? 'audio.m4a',
      );
      const res = await send(
        'ElevenLabs STT',
        `${base}/v1/speech-to-text`,
        { method: 'POST', headers: { accept: 'application/json' }, body: form },
        o.sttTimeoutMs ?? EL_STT_TIMEOUT_MS,
        req.signal,
      );
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new UpstreamError('error', 'ElevenLabs STT: response is not JSON', res.status);
      }
      const parsed = ScribeResponse.safeParse(body);
      if (!parsed.success)
        throw new UpstreamError('error', 'ElevenLabs STT: unexpected response shape', res.status);
      return parsed.data;
    },

    async soundGeneration(req) {
      const res = await send(
        'ElevenLabs SFX',
        `${base}/v1/sound-generation`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({
            text: req.text,
            ...(req.durationSeconds !== undefined ? { duration_seconds: req.durationSeconds } : {}),
            ...(req.promptInfluence !== undefined ? { prompt_influence: req.promptInfluence } : {}),
          }),
        },
        o.sfxTimeoutMs ?? EL_SFX_TIMEOUT_MS,
        req.signal,
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0)
        throw new UpstreamError('error', 'ElevenLabs SFX returned no audio', res.status);
      return bytes;
    },

    async textToSpeech(req) {
      const format = encodeURIComponent(req.outputFormat ?? EL_TTS_OUTPUT_FORMAT);
      const res = await send(
        'ElevenLabs TTS',
        `${base}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=${format}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text: req.text, model_id: req.modelId }),
        },
        o.ttsTimeoutMs ?? EL_TTS_TIMEOUT_MS,
        req.signal,
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0)
        throw new UpstreamError('error', 'ElevenLabs TTS returned no audio', res.status);
      return bytes;
    },
  };
}
