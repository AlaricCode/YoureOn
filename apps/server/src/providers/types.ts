// Provider interfaces for the paid external capabilities the server calls: a multi-vendor
// multimodal LLM (the judge, the camera-check compiler, the appeals panel, the odds suggestion),
// ElevenLabs Scribe speech-to-text (built, but nothing calls it: the hearing it was for is not
// built) and ElevenLabs Sound Effects (the stage cues). One interface per capability, a
// deterministic mock selected by default, and a paid "live" implementation that refuses to run
// without ALLOW_SPEND=true (./spend.ts). LLM output is a caller-supplied structured schema.
// Adapted from Verdict's packages/backend/src/providers/types.ts (docs/MERGE-PLAN.md).
import type { z } from 'zod/v4';
import type { StageCueKind } from '@youre-on/shared/api';
import type { PanelProvider } from '@youre-on/shared/appeal';

// ---- LLM (LLM_PROVIDER) -----------------------------------------------------------------------

/** 'google' = Google's Gemini LLM, unrelated to Gemini the exchange. */
export type ChatVendor = PanelProvider;
export type ChatEffort = 'low' | 'medium' | 'high';

export type ChatPart =
  /** `cache` puts an Anthropic `cache_control` breakpoint after this block (the terms prefix). */
  | { kind: 'text'; text: string; cache?: boolean }
  /** Frames are sent inline as base64, never as URLs. */
  | { kind: 'image'; mime: 'image/jpeg' | 'image/png'; data: Uint8Array };

/**
 * The structured output a call must return. `jsonSchema` is hand-written and sent to Anthropic and
 * Google as-is (the Anthropic zod helper drops `enum`); OpenAI gets `zodTextFormat(schema)`.
 * Whatever the vendor, the text is validated with `schema`.
 */
export interface StructuredOutput<T> {
  /** Schema name, [a-zA-Z0-9_-]{1,64} (OpenAI requires one). */
  name: string;
  jsonSchema: { type: 'object'; [key: string]: unknown };
  schema: z.ZodType<T>;
  /** Top-level string fields upper-cased before validation: enum casing isn't guaranteed. */
  upperCase?: readonly string[];
}

export interface ChatRequest<T> {
  vendor: ChatVendor;
  /** Default per vendor: DEFAULT_CHAT_MODELS. */
  model?: string;
  system: string;
  parts: ChatPart[];
  output: StructuredOutput<T>;
  /**
   * Anthropic output_config.effort, OpenAI reasoning.effort, Google thinking_level. Default 'low'.
   */
  effort?: ChatEffort;
  /** Anthropic Haiku only (thinking can't be disabled on Opus 5.5; Sonnet 5.5 400s on it). */
  thinking?: 'adaptive' | 'disabled';
  /** Default 2048. */
  maxOutputTokens?: number;
  /** Whole-call deadline. Default CHAT_TIMEOUT_MS (the panel's per-vote cap). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Why a call produced no value. `timeout`/`error` map to AppealVote.status; all of them mean
 * REDO/ABSTAIN.
 */
export type ChatFailure = 'timeout' | 'error' | 'refusal' | 'invalid_output' | 'not_configured';

interface ChatResultBase {
  vendor: ChatVendor;
  /** The model that served the response when the vendor reports it, else the one requested. */
  model: string;
  latency_ms: number;
}
export type ChatResult<T> =
  | (ChatResultBase & { ok: true; value: T; text: string })
  | (ChatResultBase & { ok: false; status: ChatFailure; message: string; text?: string });

/**
 * One system + multimodal user turn -> a validated structured value. Never throws for upstream
 * failures (timeouts, HTTP errors, refusals, bad JSON): it returns `{ok:false}` so a panel seat
 * abstains instead of failing the panel.
 */
export interface LlmProvider {
  readonly name: 'mock' | 'live';
  chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>>;
}

// ---- speech-to-text (STT_PROVIDER) --------------------------------------------------------------

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  /** Scribe diarization label ("speaker_0"); diarization only, never speaker verification. */
  speaker: string | null;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  /** Scribe audio-event tags, e.g. "(laughter)" -> {label: "laughter"}. */
  audio_events: { t_ms: number; label: string }[];
  language_code: string | null;
}

export interface SttOptions {
  /** The audio's MIME type, e.g. `audio/mp4` (AAC). */
  mime: string;
  filename?: string;
  /** Mock only: the transcript to return (e.g. from a demo header). Live ignores it. */
  mockTranscript?: string | null;
  signal?: AbortSignal;
}

export interface SttProvider {
  readonly name: 'mock' | 'live';
  /** Throws UpstreamError (voice/elevenlabs.ts) on timeout or upstream failure. */
  transcribe(audio: Uint8Array, opts: SttOptions): Promise<Transcript>;
}

// ---- sound effects (SFX_PROVIDER) ---------------------------------------------------------------

/** The stage's `cue` kinds: gavel, drumroll, buzzer, cheer. */
export type SfxCue = z.infer<typeof StageCueKind>;

export interface AudioBlob {
  mime: 'audio/wav' | 'audio/mpeg';
  bytes: Uint8Array;
}

export interface SfxProvider {
  readonly name: 'mock' | 'live';
  /** The stage's clip for a cue. Generated once per process and cached (the cues never change). */
  cue(kind: SfxCue): Promise<AudioBlob>;
}

// ---- the set on AppDeps -------------------------------------------------------------------------

export interface Providers {
  llm: LlmProvider;
  stt: SttProvider;
  sfx: SfxProvider;
}
