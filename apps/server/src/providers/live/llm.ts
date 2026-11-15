// Live multimodal chat across the three panel vendors (paid; spend-guarded in fromEnv).
//
// Ported from Verdict packages/backend/src/providers/real/boothLlm.ts (`chat()`: one system +
// multimodal user turn -> model text, per vendor). Differences, all from OUR contracts:
//  - Official SDKs, not raw fetch: @anthropic-ai/sdk 1.6.0, openai 7.53.0, @google/genai 2.32.0
//    (API-CONTRACT §7.1-7.2, pinned by spike 02). Each SDK takes an injectable `fetch`, so tests
//    exercise the real request shapes offline.
//  - Request shapes from spike 02 (youre-on-spikes/02-vision-judge/src/judges/*):
//      anthropic  messages with output_config {effort, format: json_schema (hand-written, enum kept)};
//                 Opus/Sonnet 5.5 add fallbacks:"default" (beta server-side-fallback-2026-07-01).
//      openai     Responses API with zodTextFormat's strict json_schema (sent via responses.create,
//                 same wire body as responses.parse; see callOpenAI), reasoning.effort, detail "high".
//      google     ai.interactions.create, generation_config.thinking_level, response_format
//                 {type:"text", mime_type:"application/json", schema}.
//  - 8 s per-call deadline (API-CONTRACT §7.2) instead of Verdict's 120 s, SDK retries off.
//  - Output is validated with the caller's zod schema; failures return {ok:false}, never throw.
//  - No xai vendor, no video parts (judging is on 8-16 JPEG frames).
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { GoogleGenAI } from '@google/genai';
import type { Env } from '../../env';
import { assertSpendAllowed } from '../spend';
import {
  CHAT_TIMEOUT_MS,
  DEFAULT_CHAT_MODELS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DeadlineError,
  resultFromText,
  withDeadline,
} from '../structured';
import type {
  ChatFailure,
  ChatPart,
  ChatRequest,
  ChatResult,
  ChatVendor,
  LlmProvider,
} from '../types';

export { DEFAULT_CHAT_MODELS };

const KEY_NAMES: Record<ChatVendor, keyof Env> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/** Models that take the server-side refusal fallback (Haiku 5.5 400s on it). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LiveLlmOptions {
  keys: Partial<Record<ChatVendor, string | undefined>>;
  /** Injected into every SDK client (tests). Default: global fetch. */
  fetch?: FetchLike;
  /** Pre-built clients (take precedence over keys/fetch). */
  clients?: { anthropic?: Anthropic; openai?: OpenAI; google?: GoogleGenAI };
  now?: () => number;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const short = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

function classify(e: unknown): { status: ChatFailure; message: string } {
  if (e instanceof DeadlineError) return { status: 'timeout', message: e.message };
  if (
    e instanceof Anthropic.APIConnectionTimeoutError ||
    e instanceof OpenAI.APIConnectionTimeoutError
  )
    return { status: 'timeout', message: 'SDK request timed out' };
  if (e instanceof Anthropic.APIError || e instanceof OpenAI.APIError) {
    return { status: 'error', message: short(`HTTP ${e.status ?? '-'}: ${e.message}`) };
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return { status: 'timeout', message: 'request timed out' };
  return { status: 'error', message: short(e instanceof Error ? e.message : String(e)) };
}

export class LiveLlm implements LlmProvider {
  readonly name = 'live' as const;
  private readonly now: () => number;
  private anthropic: Anthropic | undefined;
  private openai: OpenAI | undefined;
  private google: GoogleGenAI | undefined;

  constructor(private readonly o: LiveLlmOptions) {
    this.now = o.now ?? Date.now;
    this.anthropic = o.clients?.anthropic;
    this.openai = o.clients?.openai;
    this.google = o.clients?.google;
  }

  /** Spend guard first (SPEND_DISABLED unless ALLOW_SPEND=true). Keys are checked per call. */
  static fromEnv(env: Env, o: Omit<LiveLlmOptions, 'keys'> = {}): LiveLlm {
    assertSpendAllowed(env, 'LLM_PROVIDER=live');
    return new LiveLlm({
      ...o,
      keys: {
        anthropic: env.ANTHROPIC_API_KEY,
        openai: env.OPENAI_API_KEY,
        google: env.GOOGLE_GENERATIVE_AI_API_KEY,
      },
    });
  }

  /** Vendors with a key or an injected client (a panel seat without one abstains). */
  configured(): ChatVendor[] {
    return (['anthropic', 'openai', 'google'] as const).filter(
      (v) => this.o.clients?.[v] !== undefined || !!this.o.keys[v],
    );
  }

  async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
    const model: string = req.model ?? DEFAULT_CHAT_MODELS[req.vendor];
    const t0 = this.now();
    const base = () => ({ vendor: req.vendor, model, latency_ms: this.now() - t0 });
    if (!this.configured().includes(req.vendor)) {
      return {
        ...base(),
        ok: false,
        status: 'not_configured',
        message: `${KEY_NAMES[req.vendor]} is not set`,
      };
    }
    const timeoutMs = req.timeoutMs ?? CHAT_TIMEOUT_MS;
    try {
      return await withDeadline(timeoutMs, req.signal, async (signal) => {
        switch (req.vendor) {
          case 'anthropic':
            return this.callAnthropic(req, model, signal, timeoutMs, base);
          case 'openai':
            return this.callOpenAI(req, model, signal, timeoutMs, base);
          case 'google':
            return this.callGoogle(req, model, signal, timeoutMs, base);
        }
      });
    } catch (e) {
      return { ...base(), ok: false, ...classify(e) };
    }
  }

  // ---- Anthropic ---------------------------------------------------------------------------

  private anthropicClient(): Anthropic {
    this.anthropic ??= new Anthropic({
      apiKey: this.o.keys.anthropic,
      maxRetries: 0,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
    return this.anthropic;
  }

  private async callAnthropic<T>(
    req: ChatRequest<T>,
    model: string,
    signal: AbortSignal,
    timeoutMs: number,
    base: () => { vendor: ChatVendor; model: string; latency_ms: number },
  ): Promise<ChatResult<T>> {
    const content = req.parts.map((p): Anthropic.Beta.BetaContentBlockParam =>
      p.kind === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: b64(p.data) } }
        : {
            type: 'text',
            text: p.text,
            ...(p.cache ? { cache_control: { type: 'ephemeral' } } : {}),
          },
    );
    const body: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: req.system }],
      messages: [{ role: 'user', content }],
      // = jsonSchemaOutputFormat(schema, {transform:false}) minus its client-side parse hook.
      output_config: {
        effort: req.effort ?? 'low',
        format: { type: 'json_schema', schema: req.output.jsonSchema },
      },
      ...(req.thinking === 'disabled' && model.startsWith('claude-haiku-')
        ? { thinking: { type: 'disabled' } }
        : {}),
      ...(FALLBACK_MODELS.has(model)
        ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
        : {}),
    };
    const res = await this.anthropicClient().beta.messages.create(body, {
      signal,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    const served = { ...base(), model: res.model || model };
    if (res.stop_reason === 'refusal') {
      return { ...served, ok: false, status: 'refusal', message: 'request declined' };
    }
    // Responses can start with thinking blocks: read text blocks by type.
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return resultFromText(served, text, req.output);
  }

  // ---- OpenAI ------------------------------------------------------------------------------

  private openaiClient(): OpenAI {
    this.openai ??= new OpenAI({
      apiKey: this.o.keys.openai,
      maxRetries: 0,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
    return this.openai;
  }

  private async callOpenAI<T>(
    req: ChatRequest<T>,
    model: string,
    signal: AbortSignal,
    timeoutMs: number,
    base: () => { vendor: ChatVendor; model: string; latency_ms: number },
  ): Promise<ChatResult<T>> {
    const content = req.parts.map((p) =>
      p.kind === 'image'
        ? {
            type: 'input_image' as const,
            image_url: `data:${p.mime};base64,${b64(p.data)}`,
            detail: 'high' as const,
          }
        : { type: 'input_text' as const, text: p.text },
    );
    // The wire format is exactly zodTextFormat's (strict json_schema, API-CONTRACT §7.2), sent with
    // responses.create rather than responses.parse: parse runs zod inside the SDK and throws before
    // enum upper-casing, so every vendor is validated by the same resultFromText path instead.
    const zf = zodTextFormat(req.output.schema, req.output.name);
    const res = await this.openaiClient().responses.create(
      {
        model,
        instructions: req.system,
        input: [{ role: 'user', content }],
        reasoning: { effort: req.effort ?? 'low' },
        text: { format: { type: zf.type, name: zf.name, strict: zf.strict, schema: zf.schema } },
        max_output_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
      { signal, timeout: timeoutMs, maxRetries: 0 },
    );
    const served = { ...base(), model: res.model || model };
    let refused = false;
    let text = '';
    for (const item of res.output) {
      if (item.type !== 'message') continue;
      for (const c of item.content) {
        if (c.type === 'refusal') refused = true;
        else if (c.type === 'output_text') text += c.text;
      }
    }
    if (refused) return { ...served, ok: false, status: 'refusal', message: 'request declined' };
    if (res.status === 'incomplete') {
      return { ...served, ok: false, status: 'error', message: 'response incomplete', text };
    }
    return resultFromText(served, text, req.output);
  }

  // ---- Google ------------------------------------------------------------------------------

  private googleClient(timeoutMs: number): GoogleGenAI {
    // Always pass the key explicitly: the SDK would otherwise read GEMINI_API_KEY / GOOGLE_API_KEY,
    // names reserved for other uses (SETUP-CHECKLIST K5).
    this.google ??= new GoogleGenAI({
      apiKey: this.o.keys.google,
      httpOptions: { timeout: timeoutMs, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) },
    });
    return this.google;
  }

  private async callGoogle<T>(
    req: ChatRequest<T>,
    model: string,
    signal: AbortSignal,
    timeoutMs: number,
    base: () => { vendor: ChatVendor; model: string; latency_ms: number },
  ): Promise<ChatResult<T>> {
    const input = req.parts.map((p: ChatPart) =>
      p.kind === 'image'
        ? { type: 'image' as const, data: b64(p.data), mime_type: p.mime }
        : { type: 'text' as const, text: p.text },
    );
    const res = await this.googleClient(timeoutMs).interactions.create(
      {
        model,
        system_instruction: req.system,
        input,
        generation_config: {
          // gemini-3.8-flash errors on "minimal" (spike 02).
          thinking_level: req.effort ?? 'low',
          max_output_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: req.output.jsonSchema,
        },
      },
      { signal, timeout_ms: timeoutMs, retries: { strategy: 'none' } },
    );
    const served = base();
    if (res.status === 'failed' || res.status === 'cancelled') {
      return { ...served, ok: false, status: 'error', message: `interaction ${res.status}` };
    }
    return resultFromText(served, res.output_text ?? '', req.output);
  }
}
