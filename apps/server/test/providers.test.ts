// Provider layer (src/providers): spend guard, registry, the deterministic mocks, and the live
// adapters driven through the real SDKs with an injected fake fetch. Nothing here reaches the
// network or needs a key, and ALLOW_SPEND is only ever set on synthetic env objects.
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { VisionVerdict } from '@youre-on/shared/ruling';
import { createDeps } from '../src/server';
import { EnvError, loadEnv } from '../src/env';
import {
  createProviders,
  MockProviderInProductionError,
  providerModes,
} from '../src/providers/registry';
import { enforceSpendGuard, spendingModes, SpendDisabledError } from '../src/providers/spend';
import {
  CHAT_TIMEOUT_MS,
  DeadlineError,
  firstJson,
  parseStructured,
  withDeadline,
} from '../src/providers/structured';
import { MockLlm, sampleFromJsonSchema } from '../src/providers/mock/llm';
import { MOCK_CUE_TONES, MockSfx, MockStt } from '../src/providers/mock/voice';
import { LiveLlm } from '../src/providers/live/llm';
import { LiveSfx, LiveStt, scribeToTranscript } from '../src/providers/live/voice';
import {
  createElevenLabsClient,
  UpstreamError,
  type ScribeResponse,
} from '../src/voice/elevenlabs';
import type { ChatRequest, StructuredOutput } from '../src/providers/types';
import { testEnv } from './helpers';

// ---- fixtures ---------------------------------------------------------------------------------

/** Hand-written wire schema for SCHEMAS §5.1 VisionVerdict (enum kept, API-CONTRACT §7.1). */
const VISION_VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    claim_result: { type: 'string', enum: ['MET', 'NOT_MET', 'UNCLEAR'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', maxLength: 280 },
    cited_frames: { type: 'array', items: { type: 'integer', minimum: 0 } },
    contested: { type: 'boolean' },
  },
  required: ['claim_result', 'confidence', 'reason', 'cited_frames', 'contested'],
  additionalProperties: false,
} as const;

const VERDICT_OUTPUT: StructuredOutput<VisionVerdict> = {
  name: 'vision_verdict',
  jsonSchema: VISION_VERDICT_JSON_SCHEMA,
  schema: VisionVerdict,
  upperCase: ['claim_result'],
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const JPEG_B64 = Buffer.from(JPEG).toString('base64');

function verdictReq(over: Partial<ChatRequest<VisionVerdict>> = {}): ChatRequest<VisionVerdict> {
  return {
    vendor: 'anthropic',
    system: 'You are the referee in You’re On.',
    parts: [
      { kind: 'text', text: 'TERMS (canonical JSON):\n{"claim":"lands upright"}', cache: true },
      { kind: 'text', text: 'Frame 1/8 at t=0.00 s:' },
      { kind: 'image', mime: 'image/jpeg', data: JPEG },
      { kind: 'text', text: 'Rule on this attempt.' },
    ],
    output: VERDICT_OUTPUT,
    ...over,
  };
}

const GOOD = {
  claim_result: 'met',
  confidence: 0.92,
  reason: 'Frame 8 shows it standing on its base.',
  cited_frames: [7],
  contested: false,
};

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * A fetch that records calls and answers from `reply`. The Google SDK passes a Request object
 * (headers and body live on it), the others a URL string + init; both are normalised to `init`.
 */
function fakeFetch(reply: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    let call: Call;
    if (input instanceof Request) {
      call = {
        url: input.url,
        init: {
          ...init,
          method: input.method,
          headers: input.headers,
          body: init.body ?? (await input.text()),
          signal: init.signal ?? input.signal,
        },
      };
    } else {
      call = { url: typeof input === 'string' ? input : input.href, init };
    }
    calls.push(call);
    return reply(call, calls.length);
  };
  return { f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Waits for the request's own abort signal (as a well-behaved fetch does). */
const hangUntilAbort = (call: Call) =>
  new Promise<Response>((_, reject) => {
    const s = call.init.signal;
    if (!s) return;
    s.addEventListener('abort', () => reject(s.reason ?? new Error('aborted')), { once: true });
  });

const headersOf = (init: RequestInit) =>
  new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const anthropicMessage = (content: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 20 },
  ...over,
});

const openaiResponse = (content: unknown[]) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 1,
  model: 'gpt-6.1-terra',
  status: 'completed',
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content }],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});

const neverFetch = async (): Promise<Response> => {
  throw new Error('network must not be called');
};

// ---- spend guard + env --------------------------------------------------------------------------

describe('spend guard (ALLOW_SPEND)', () => {
  it('defaults: ALLOW_SPEND=false and every provider mock', () => {
    const env = testEnv();
    expect(env.ALLOW_SPEND).toBe(false);
    // SFX 'auto' is the mock unless the stage's voice is on (the key + ALLOW_SPEND, stage-tts.test.ts)
    expect([env.LLM_PROVIDER, env.STT_PROVIDER, env.SFX_PROVIDER]).toEqual([
      'mock',
      'mock',
      'auto',
    ]);
    expect(providerModes(createProviders(env)).sfx).toBe('mock');
    expect(spendingModes(env)).toEqual([]);
    expect(() => enforceSpendGuard(env)).not.toThrow();
  });

  it('lists every live mode and refuses them without ALLOW_SPEND=true', () => {
    const env = testEnv({ LLM_PROVIDER: 'live', SFX_PROVIDER: 'live' });
    expect(spendingModes(env)).toEqual(['LLM_PROVIDER=live', 'SFX_PROVIDER=live']);
    const err = (() => {
      try {
        enforceSpendGuard(env);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SpendDisabledError);
    expect((err as SpendDisabledError).code).toBe('SPEND_DISABLED');
    expect((err as SpendDisabledError).modes).toEqual(['LLM_PROVIDER=live', 'SFX_PROVIDER=live']);
    // An overridden capability is not checked.
    expect(() => enforceSpendGuard(env, ['LLM_PROVIDER', 'SFX_PROVIDER'])).not.toThrow();
  });

  it('only the exact string "true" allows spend; junk values fail env validation', () => {
    expect(() => testEnv({ ALLOW_SPEND: '1' })).toThrow(EnvError);
    expect(() => testEnv({ LLM_PROVIDER: 'anthropic' })).toThrow(EnvError);
    expect(testEnv({ ALLOW_SPEND: 'true' }).ALLOW_SPEND).toBe(true);
  });

  it('every live factory asserts the guard itself (defence in depth)', () => {
    const env = testEnv({ ELEVENLABS_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    expect(() => LiveLlm.fromEnv(env)).toThrow(SpendDisabledError);
    expect(() => LiveStt.fromEnv(env)).toThrow(SpendDisabledError);
    expect(() => LiveSfx.fromEnv(env)).toThrow(SpendDisabledError);
    const allowed = testEnv({ ALLOW_SPEND: 'true' });
    expect(() => LiveStt.fromEnv(allowed)).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => LiveSfx.fromEnv(allowed)).toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe('provider registry', () => {
  it('builds mocks by default, and AppDeps carries them', () => {
    const p = createProviders(testEnv());
    expect(providerModes(p)).toEqual({ llm: 'mock', stt: 'mock', sfx: 'mock' });
    const { deps } = createDeps({ env: testEnv(), rateLimit: false });
    expect(providerModes(deps.providers)).toEqual({ llm: 'mock', stt: 'mock', sfx: 'mock' });
  });

  it('createDeps fails at boot with SPEND_DISABLED for a live mode without ALLOW_SPEND', () => {
    expect(() => createDeps({ env: testEnv({ STT_PROVIDER: 'live' }), rateLimit: false })).toThrow(
      SpendDisabledError,
    );
  });

  it('builds live providers only with ALLOW_SPEND=true, without any network call', () => {
    const env = testEnv({
      ALLOW_SPEND: 'true',
      LLM_PROVIDER: 'live',
      STT_PROVIDER: 'live',
      SFX_PROVIDER: 'live',
      ELEVENLABS_API_KEY: 'k',
    });
    const p = createProviders(env, { fetch: neverFetch });
    expect(providerModes(p)).toEqual({ llm: 'live', stt: 'live', sfx: 'live' });
  });

  it('NODE_ENV=production boots, but the mock LLM / STT refuse every call (no fake rulings)', async () => {
    const env = testEnv({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://example.test',
      // REQUIRED_IN_PRODUCTION (env.ts): never used by this test.
      SOLANA_DEVNET_RPC: 'http://127.0.0.1:1',
      FEE_PAYER_SECRET_KEY: 'unused',
      JUDGE_AUTHORITY_SECRET_KEY: 'unused',
      ELEVENLABS_TOOL_SECRET: 'unused',
      ANTHROPIC_API_KEY: 'unused',
      DEMO_ADMIN_TOKEN: 'unused',
    });
    const p = createProviders(env);
    expect(providerModes(p)).toEqual({ llm: 'mock', stt: 'mock', sfx: 'mock' });
    const req: ChatRequest<z.infer<typeof VisionVerdict>> = {
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'rule' }] }],
      output: { name: 'v', schema: VisionVerdict },
    } as unknown as ChatRequest<z.infer<typeof VisionVerdict>>;
    await expect(p.llm.chat(req)).rejects.toBeInstanceOf(MockProviderInProductionError);
    await expect(
      p.stt.transcribe(new Uint8Array(1), { mime: 'audio/mp4', mockTranscript: 'I win' }),
    ).rejects.toMatchObject({ code: 'MOCK_PROVIDER_IN_PRODUCTION', variable: 'STT_PROVIDER' });
    expect((await p.sfx.cue('gavel')).mime).toBe('audio/wav');
    // an explicit override is the caller's choice
    const llm = new MockLlm();
    expect(createProviders(env, { overrides: { llm } }).llm).toBe(llm);
  });

  it('production needs ANTHROPIC_API_KEY only when LLM_PROVIDER=live', () => {
    const base = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://example.test',
      SOLANA_DEVNET_RPC: 'http://127.0.0.1:1',
      FEE_PAYER_SECRET_KEY: 'unused',
      JUDGE_AUTHORITY_SECRET_KEY: 'unused',
      ELEVENLABS_TOOL_SECRET: 'unused',
      DEMO_ADMIN_TOKEN: 'unused',
      DATABASE_URL: 'postgres://x@localhost/x',
    };
    expect(() => loadEnv(base)).not.toThrow();
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'live', ALLOW_SPEND: 'true' })).toThrow(
      /ANTHROPIC_API_KEY: required in production/,
    );
    expect(() =>
      loadEnv({ ...base, LLM_PROVIDER: 'live', ALLOW_SPEND: 'true', ANTHROPIC_API_KEY: 'k' }),
    ).not.toThrow();
  });

  it('overrides replace a capability and skip its guard', () => {
    const llm = new MockLlm();
    const p = createProviders(testEnv({ LLM_PROVIDER: 'live' }), { overrides: { llm } });
    expect(p.llm).toBe(llm);
    const { deps } = createDeps({
      env: testEnv({ LLM_PROVIDER: 'live' }),
      rateLimit: false,
      providers: { llm },
    });
    expect(deps.providers.llm).toBe(llm);
  });
});

// ---- structured output + deadline ---------------------------------------------------------------

describe('structured output helpers', () => {
  it('firstJson tolerates fences and prose', () => {
    expect(firstJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(firstJson('ruling {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => firstJson('no json here')).toThrow(/no JSON/);
  });

  it('upper-cases enum fields before zod (casing is not guaranteed)', () => {
    const r = parseStructured(JSON.stringify(GOOD), VERDICT_OUTPUT);
    expect(r).toEqual({ ok: true, value: { ...GOOD, claim_result: 'MET' } });
  });

  it('reports validation failures without throwing', () => {
    const r = parseStructured(JSON.stringify({ ...GOOD, confidence: 3 }), VERDICT_OUTPUT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/vision_verdict failed validation: confidence/);
  });

  it('withDeadline rejects at the deadline even if the work ignores its signal', async () => {
    const t0 = Date.now();
    await expect(withDeadline(30, undefined, () => new Promise(() => {}))).rejects.toBeInstanceOf(
      DeadlineError,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('withDeadline forwards an outer abort and passes results through', async () => {
    await expect(withDeadline(1_000, undefined, async () => 7)).resolves.toBe(7);
    const outer = new AbortController();
    const p = withDeadline(1_000, outer.signal, (signal) =>
      hangUntilAbort({ url: '', init: { signal } }),
    );
    outer.abort(new Error('caller gave up'));
    await expect(p).rejects.toThrow('caller gave up');
  });

  it('the default per-call deadline is the panel cap, 8 s', () => {
    expect(CHAT_TIMEOUT_MS).toBe(8_000);
  });
});

// ---- mocks ---------------------------------------------------------------------------------------

describe('MockLlm', () => {
  it('default answer is sampled from the JSON schema and passes the zod schema', async () => {
    expect(sampleFromJsonSchema(VISION_VERDICT_JSON_SCHEMA)).toEqual({
      claim_result: 'MET',
      confidence: 0.9,
      reason: 'mock reason',
      cited_frames: [],
      contested: false,
    });
    const r = await new MockLlm().chat(verdictReq({ vendor: 'google' }));
    expect(r).toMatchObject({
      ok: true,
      vendor: 'google',
      model: 'mock/gemini-3.8-flash',
      value: { claim_result: 'MET' },
    });
  });

  it('is scriptable per request, including failures and bad output', async () => {
    const llm = new MockLlm((req) =>
      req.vendor === 'openai'
        ? { fail: 'timeout' }
        : req.vendor === 'google'
          ? { text: 'I think it landed' }
          : { value: { ...GOOD, claim_result: 'not_met' } },
    );
    const a = await llm.chat(verdictReq());
    expect(a.ok && a.value.claim_result).toBe('NOT_MET');
    expect(await llm.chat(verdictReq({ vendor: 'openai' }))).toMatchObject({
      ok: false,
      status: 'timeout',
    });
    expect(await llm.chat(verdictReq({ vendor: 'google' }))).toMatchObject({
      ok: false,
      status: 'invalid_output',
    });
    expect(llm.calls.map((c) => c.vendor)).toEqual(['anthropic', 'openai', 'google']);
  });
});

describe('mock voice', () => {
  it('MockStt echoes mockTranscript only (no spoken-accept fallback)', async () => {
    const stt = new MockStt();
    const t = await stt.transcribe(new Uint8Array(4), {
      mime: 'audio/mp4',
      mockTranscript: ' it hit the cap ',
    });
    expect(t).toEqual({
      text: 'it hit the cap',
      segments: [{ start_ms: 0, end_ms: 1400, speaker: 'speaker_0', text: 'it hit the cap' }],
      audio_events: [],
      language_code: 'en',
    });
    expect((await stt.transcribe(new Uint8Array(4), { mime: 'audio/mp4' })).segments).toEqual([]);
  });

  it('MockSfx returns a valid, distinct, cached WAV per cue', async () => {
    const sfx = new MockSfx();
    const gavel = await sfx.cue('gavel');
    expect(gavel.mime).toBe('audio/wav');
    const b = Buffer.from(gavel.bytes);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.toString('ascii', 8, 12)).toBe('WAVE');
    expect(b.readUInt32LE(40)).toBe(MOCK_CUE_TONES.gavel.ms * 16 * 2); // 16 kHz mono, 2 bytes/sample
    expect((await sfx.cue('gavel')).bytes).toBe(gavel.bytes);
    expect(Buffer.from((await sfx.cue('cheer')).bytes).equals(b)).toBe(false);
  });
});

// ---- live LLM through the real SDKs, fake fetch ------------------------------------------------

describe('LiveLlm: Anthropic (@anthropic-ai/sdk 1.6.0)', () => {
  it('sends the pinned request shape and returns the validated verdict', async () => {
    const { f, calls } = fakeFetch(() =>
      json(
        anthropicMessage([
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: JSON.stringify(GOOD) },
        ]),
      ),
    );
    const llm = new LiveLlm({ keys: { anthropic: 'sk-ant-test' }, fetch: f });
    const r = await llm.chat(verdictReq());
    expect(r).toMatchObject({
      ok: true,
      vendor: 'anthropic',
      model: 'claude-opus-5-5',
      value: { ...GOOD, claim_result: 'MET' },
    });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = headersOf(init);
    // SDK 1.6.0 sends the API key as a bearer token, with retries off.
    expect(h.get('authorization')).toBe('Bearer sk-ant-test');
    expect(h.get('x-stainless-retry-count')).toBe('0');
    expect(h.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = bodyOf(init);
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(2048);
    expect(body.fallbacks).toBe('default');
    expect(body.thinking).toBeUndefined(); // Opus 5.5 can't disable thinking
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: VISION_VERDICT_JSON_SCHEMA },
    });
    expect(body.system).toEqual([{ type: 'text', text: 'You are the referee in You’re On.' }]);
    expect(body.messages[0].content).toEqual([
      {
        type: 'text',
        text: 'TERMS (canonical JSON):\n{"claim":"lands upright"}',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'Frame 1/8 at t=0.00 s:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_B64 } },
      { type: 'text', text: 'Rule on this attempt.' },
    ]);
  });

  it('Haiku: thinking disabled when asked, no fallbacks beta', async () => {
    const { f, calls } = fakeFetch(() =>
      json(
        anthropicMessage([{ type: 'text', text: JSON.stringify(GOOD) }], {
          model: 'claude-haiku-5-5',
        }),
      ),
    );
    const llm = new LiveLlm({ keys: { anthropic: 'k' }, fetch: f });
    const r = await llm.chat(verdictReq({ model: 'claude-haiku-5-5', thinking: 'disabled' }));
    expect(r.ok && r.model).toBe('claude-haiku-5-5');
    const body = bodyOf(calls[0]!.init);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.fallbacks).toBeUndefined();
    expect(headersOf(calls[0]!.init).get('anthropic-beta')).toBeNull();
  });

  it('maps refusal, HTTP errors (no SDK retry) and bad JSON to non-throwing failures', async () => {
    const refusal = fakeFetch(() => json(anthropicMessage([], { stop_reason: 'refusal' })));
    expect(
      await new LiveLlm({ keys: { anthropic: 'k' }, fetch: refusal.f }).chat(verdictReq()),
    ).toMatchObject({ ok: false, status: 'refusal' });

    const http = fakeFetch(() =>
      json({ type: 'error', error: { type: 'api_error', message: 'boom' } }, 500),
    );
    const r = await new LiveLlm({ keys: { anthropic: 'k' }, fetch: http.f }).chat(verdictReq());
    expect(r).toMatchObject({ ok: false, status: 'error' });
    expect(!r.ok && r.message).toMatch(/HTTP 500/);
    expect(http.calls).toHaveLength(1);

    const bad = fakeFetch(() =>
      json(anthropicMessage([{ type: 'text', text: '{"claim_result":1}' }])),
    );
    expect(
      await new LiveLlm({ keys: { anthropic: 'k' }, fetch: bad.f }).chat(verdictReq()),
    ).toMatchObject({ ok: false, status: 'invalid_output' });
  });

  it('times out at the per-call deadline', async () => {
    const { f } = fakeFetch(hangUntilAbort);
    const t0 = Date.now();
    const r = await new LiveLlm({ keys: { anthropic: 'k' }, fetch: f }).chat(
      verdictReq({ timeoutMs: 50 }),
    );
    expect(r).toMatchObject({ ok: false, status: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('LiveLlm: OpenAI (openai 7.53.0 responses.parse + zodTextFormat)', () => {
  it('sends the pinned request shape and validates output_text', async () => {
    const { f, calls } = fakeFetch(() =>
      json(openaiResponse([{ type: 'output_text', text: JSON.stringify(GOOD), annotations: [] }])),
    );
    const llm = new LiveLlm({ keys: { openai: 'sk-test' }, fetch: f });
    const r = await llm.chat(verdictReq({ vendor: 'openai' }));
    expect(r).toMatchObject({ ok: true, vendor: 'openai', model: 'gpt-6.1-terra' });
    expect(r.ok && r.value.claim_result).toBe('MET');
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headersOf(init).get('authorization')).toBe('Bearer sk-test');
    const body = bodyOf(init);
    expect(body.model).toBe('gpt-6.1-terra');
    expect(body.instructions).toBe('You are the referee in You’re On.');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.max_output_tokens).toBe(2048);
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'vision_verdict',
      strict: true,
    });
    expect(body.text.format.schema.properties.claim_result.enum).toEqual([
      'MET',
      'NOT_MET',
      'UNCLEAR',
    ]);
    expect(body.input[0].content[2]).toEqual({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${JPEG_B64}`,
      detail: 'high',
    });
  });

  it('maps a refusal content item and HTTP errors', async () => {
    const refusal = fakeFetch(() => json(openaiResponse([{ type: 'refusal', refusal: 'no' }])));
    expect(
      await new LiveLlm({ keys: { openai: 'k' }, fetch: refusal.f }).chat(
        verdictReq({ vendor: 'openai' }),
      ),
    ).toMatchObject({ ok: false, status: 'refusal' });
    const http = fakeFetch(() => json({ error: { message: 'rate limited' } }, 429));
    const r = await new LiveLlm({ keys: { openai: 'k' }, fetch: http.f }).chat(
      verdictReq({ vendor: 'openai' }),
    );
    expect(r).toMatchObject({ ok: false, status: 'error' });
    expect(http.calls).toHaveLength(1);
  });
});

describe('LiveLlm: Google (@google/genai 2.32.0 interactions.create)', () => {
  it('sends the pinned request shape and validates output_text', async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        id: 'int_1',
        status: 'completed',
        model: 'gemini-3.8-flash',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(GOOD) }] }],
      }),
    );
    const llm = new LiveLlm({ keys: { google: 'g-test' }, fetch: f });
    const r = await llm.chat(verdictReq({ vendor: 'google' }));
    expect(r).toMatchObject({ ok: true, vendor: 'google', model: 'gemini-3.8-flash' });
    const { url, init } = calls[0]!;
    expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions/);
    expect(headersOf(init).get('x-goog-api-key')).toBe('g-test');
    const body = bodyOf(init);
    expect(body.model).toBe('gemini-3.8-flash');
    expect(body.system_instruction).toBe('You are the referee in You’re On.');
    expect(body.generation_config).toEqual({ thinking_level: 'low', max_output_tokens: 2048 });
    expect(body.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: VISION_VERDICT_JSON_SCHEMA,
    });
    expect(body.input[2]).toEqual({ type: 'image', data: JPEG_B64, mime_type: 'image/jpeg' });
  });

  it('a failed interaction and a 5xx (SDK retries off) are errors', async () => {
    const failed = fakeFetch(() => json({ id: 'int_2', status: 'failed', steps: [] }));
    expect(
      await new LiveLlm({ keys: { google: 'k' }, fetch: failed.f }).chat(
        verdictReq({ vendor: 'google' }),
      ),
    ).toMatchObject({ ok: false, status: 'error' });
    const http = fakeFetch(() => json({ error: { code: 503, message: 'overloaded' } }, 503));
    const r = await new LiveLlm({ keys: { google: 'k' }, fetch: http.f }).chat(
      verdictReq({ vendor: 'google' }),
    );
    expect(r).toMatchObject({ ok: false, status: 'error' });
    expect(http.calls).toHaveLength(1);
  });
});

describe('LiveLlm: configuration', () => {
  it('a vendor without a key is not_configured and makes no request', async () => {
    const llm = new LiveLlm({ keys: { anthropic: 'k' }, fetch: neverFetch });
    expect(llm.configured()).toEqual(['anthropic']);
    expect(await llm.chat(verdictReq({ vendor: 'openai' }))).toMatchObject({
      ok: false,
      status: 'not_configured',
      message: 'OPENAI_API_KEY is not set',
    });
  });

  it('three seats in parallel stay within one deadline when one hangs', async () => {
    const answer = (call: Call): Response | Promise<Response> => {
      if (call.url.includes('anthropic'))
        return json(anthropicMessage([{ type: 'text', text: JSON.stringify(GOOD) }]));
      if (call.url.includes('openai')) return hangUntilAbort(call);
      return json({
        id: 'i',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(GOOD) }] }],
      });
    };
    const { f } = fakeFetch(answer);
    const llm = new LiveLlm({ keys: { anthropic: 'a', openai: 'o', google: 'g' }, fetch: f });
    const t0 = Date.now();
    const votes = await Promise.all(
      (['anthropic', 'openai', 'google'] as const).map((vendor) =>
        llm.chat(verdictReq({ vendor, timeoutMs: 80 })),
      ),
    );
    expect(votes.map((v) => (v.ok ? 'ok' : v.status))).toEqual(['ok', 'timeout', 'ok']);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

// ---- ElevenLabs Scribe + Sound Effects (src/voice/elevenlabs.ts), fake fetch ----------------------

const SCRIBE = {
  language_code: 'en',
  text: 'It hit the cap. No way!',
  words: [
    { text: 'It', start: 0.1, end: 0.2, type: 'word', speaker_id: 'speaker_0' },
    { text: ' ', start: 0.2, end: 0.25, type: 'spacing', speaker_id: 'speaker_0' },
    { text: 'hit', start: 0.25, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
    { text: 'the', start: 0.45, end: 0.5, type: 'word', speaker_id: 'speaker_0' },
    { text: 'cap.', start: 0.5, end: 0.8, type: 'word', speaker_id: 'speaker_0' },
    { text: '(laughter)', start: 0.9, end: 1.2, type: 'audio_event', speaker_id: null },
    { text: 'No', start: 1.3, end: 1.4, type: 'word', speaker_id: 'speaker_1' },
    { text: 'way!', start: 1.45, end: 1.7, type: 'word', speaker_id: 'speaker_1' },
  ],
} satisfies ScribeResponse;

describe('scribeToTranscript', () => {
  it('groups words into per-speaker segments and extracts audio events', () => {
    expect(scribeToTranscript(SCRIBE)).toEqual({
      text: 'It hit the cap. No way!',
      language_code: 'en',
      segments: [
        { start_ms: 100, end_ms: 800, speaker: 'speaker_0', text: 'It hit the cap.' },
        { start_ms: 1300, end_ms: 1700, speaker: 'speaker_1', text: 'No way!' },
      ],
      audio_events: [{ t_ms: 900, label: 'laughter' }],
    });
    expect(scribeToTranscript({})).toEqual({
      text: '',
      segments: [],
      audio_events: [],
      language_code: null,
    });
  });
});

describe('ElevenLabs Scribe STT', () => {
  it('POSTs multipart scribe_v2 with diarization and returns a Transcript', async () => {
    const { f, calls } = fakeFetch(() => json(SCRIBE));
    const stt = new LiveStt(createElevenLabsClient({ apiKey: 'xi-test', fetch: f }));
    const t = await stt.transcribe(new Uint8Array([1, 2, 3]), {
      mime: 'audio/mp4',
      mockTranscript: 'ignored by live',
    });
    expect(t.segments.map((s) => s.speaker)).toEqual(['speaker_0', 'speaker_1']);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(headersOf(init).get('xi-api-key')).toBe('xi-test');
    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('tag_audio_events')).toBe('true');
    expect(form.get('timestamps_granularity')).toBe('word');
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/mp4');
    expect(file.name).toBe('audio.m4a');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('times out (UpstreamError timeout), never echoes error bodies, rejects bad shapes', async () => {
    const hang = fakeFetch(hangUntilAbort);
    const slow = createElevenLabsClient({ apiKey: 'k', fetch: hang.f, sttTimeoutMs: 30 });
    await expect(
      slow.speechToText({ audio: new Uint8Array(1), mime: 'audio/mp4' }),
    ).rejects.toMatchObject({ kind: 'timeout' });

    const http = fakeFetch(() => new Response('secret transcript echo', { status: 500 }));
    const err = await createElevenLabsClient({ apiKey: 'k', fetch: http.f })
      .speechToText({ audio: new Uint8Array(1), mime: 'audio/mp4' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).message).toBe('ElevenLabs STT HTTP 500');

    const bad = fakeFetch(() => json({ words: 'nope' }));
    await expect(
      createElevenLabsClient({ apiKey: 'k', fetch: bad.f }).speechToText({
        audio: new Uint8Array(1),
        mime: 'audio/mp4',
      }),
    ).rejects.toMatchObject({ kind: 'error' });

    const nokey = fakeFetch(() => json(SCRIBE));
    await expect(
      createElevenLabsClient({ apiKey: undefined, fetch: nokey.f }).speechToText({
        audio: new Uint8Array(1),
        mime: 'audio/mp4',
      }),
    ).rejects.toMatchObject({ kind: 'not_configured' });
    expect(nokey.calls).toHaveLength(0);
  });
});

describe('ElevenLabs Sound Effects', () => {
  const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);

  it('POSTs /v1/sound-generation per cue and caches each clip', async () => {
    const { f, calls } = fakeFetch(() => new Response(MP3, { status: 200 }));
    const sfx = new LiveSfx(createElevenLabsClient({ apiKey: 'k', fetch: f }));
    const [a, b] = await Promise.all([sfx.cue('gavel'), sfx.cue('gavel')]);
    expect(a).toEqual({ mime: 'audio/mpeg', bytes: MP3 });
    expect(b).toBe(a);
    await sfx.cue('cheer');
    expect(calls).toHaveLength(2);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/sound-generation');
    expect(headersOf(init).get('accept')).toBe('audio/mpeg');
    expect(bodyOf(init)).toEqual({
      text: 'single wooden judge gavel strike, close, dry, no echo',
      duration_seconds: 1,
      prompt_influence: 0.6,
    });
  });

  it('a failed or empty generation is not cached', async () => {
    const { f, calls } = fakeFetch((_c, n) =>
      n === 1
        ? new Response(new Uint8Array(0), { status: 200 })
        : new Response(MP3, { status: 200 }),
    );
    const sfx = new LiveSfx(createElevenLabsClient({ apiKey: 'k', fetch: f }));
    await expect(sfx.cue('buzzer')).rejects.toThrow('ElevenLabs SFX returned no audio');
    await expect(sfx.cue('buzzer')).resolves.toEqual({ mime: 'audio/mpeg', bytes: MP3 });
    expect(calls).toHaveLength(2);
  });
});

// Type-level: the provider contract is generic in the output schema.
const _typecheck = async (llm: MockLlm) => {
  const r = await llm.chat({
    vendor: 'anthropic',
    system: 's',
    parts: [],
    output: {
      name: 'x',
      jsonSchema: { type: 'object' },
      schema: z.object({ n: z.number() }),
    },
  });
  if (r.ok) r.value.n satisfies number;
};
void _typecheck;
