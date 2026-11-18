/* eslint-disable @typescript-eslint/no-explicit-any -- fake ElevenLabs stores loose JSON */
// Voice stream unit tests that need no database: the ElevenLabs token client (HTTP mocked),
// tool-secret auth, the tool state (dedupe window, revisions), the /el/tools auth and rate-limit
// paths on a DB-less app, and the agent-as-code sync engine against a fake ElevenLabs.
import { describe, expect, it } from 'vitest';
import { createElevenLabsClient, UpstreamError } from '../src/voice/elevenlabs';
import { toolSecretOk } from '../src/voice/tool-auth';
import {
  EL_TOOLS_BUCKET,
  toolDedupeKey,
  ToolState,
  TOOL_DEDUPE_WINDOW_MS,
} from '../src/voice/tools';
import {
  diffPaths,
  dryRunPlan,
  fetchElHttp,
  isSubset,
  syncAgent,
  type ElHttp,
  type SyncOptions,
} from '../src/voice/agent-sync';
import { createVoiceRoutes } from '../src/voice/routes';
import { buildApp } from '../src/app';
import { createDeps } from '../src/server';
import { testEnv } from './helpers';
import { AGENT_MAX_TOKENS, CLIENT_EVENTS } from '@youre-on/shared/judge/el-config';

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ElevenLabs conversation token client (API-CONTRACT §2.6)', () => {
  it('GETs /v1/convai/conversation/token?agent_id= with xi-api-key and returns {token, conversation_id}', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const el = createElevenLabsClient({
      apiKey: 'sk_test',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return okJson({ token: 'tok_1', conversation_id: 'conv_1', extra: true });
      },
    });
    await expect(el.conversationToken('agent_abc/1')).resolves.toEqual({
      token: 'tok_1',
      conversation_id: 'conv_1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_abc%2F1',
    );
    expect(calls[0]!.init?.method).toBe('GET');
    expect((calls[0]!.init?.headers as Record<string, string>)['xi-api-key']).toBe('sk_test');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a deadline overrun to timeout (3 s by default, §1.8)', async () => {
    const el = createElevenLabsClient({
      apiKey: 'k',
      timeoutMs: 30,
      fetch: (_u, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)),
        ),
    });
    await expect(el.conversationToken('a')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it.each([
    ['HTTP 401', async () => new Response('{"detail":"bad key"}', { status: 401 }), 401],
    ['HTTP 500', async () => new Response('oops', { status: 500 }), 500],
    ['non-JSON', async () => new Response('<html>', { status: 200 }), 200],
    ['wrong shape', async () => okJson({ signed_url: 'x' }), 200],
    ['network error', async () => Promise.reject(new TypeError('fetch failed')), undefined],
  ])('%s -> error', async (_n, fetch, status) => {
    const el = createElevenLabsClient({ apiKey: 'k', fetch });
    const err = await el.conversationToken('a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ kind: 'error', status });
  });

  it('no API key -> not_configured, and nothing is fetched', async () => {
    let n = 0;
    const el = createElevenLabsClient({ apiKey: undefined, fetch: async () => (n++, okJson({})) });
    await expect(el.conversationToken('a')).rejects.toMatchObject({ kind: 'not_configured' });
    expect(n).toBe(0);
  });
});

describe('tool secret (API-CONTRACT §4.2)', () => {
  it('constant-time compare against one or two accepted values', () => {
    expect(toolSecretOk('s3cret', ['s3cret'])).toBe(true);
    expect(toolSecretOk('s3cret', ['old', 's3cret'])).toBe(true);
    expect(toolSecretOk('s3cre', ['s3cret'])).toBe(false);
    expect(toolSecretOk('', ['s3cret'])).toBe(false);
    expect(toolSecretOk(undefined, ['s3cret'])).toBe(false);
    expect(toolSecretOk('anything', [undefined])).toBe(false); // unset secret fails closed
  });
});

describe('ToolState', () => {
  it('replays within the 10 s window only', () => {
    const s = new ToolState();
    s.store('k', 1_000, { ok: true, say: 'x' });
    expect(s.cached('k', 1_000 + TOOL_DEDUPE_WINDOW_MS)).toEqual({ ok: true, say: 'x' });
    expect(s.cached('k', 1_001 + TOOL_DEDUPE_WINDOW_MS)).toBeNull();
  });
  it('revision: +1 per changed proposal, same proposal keeps its rev, per bet', () => {
    const s = new ToolState();
    expect(s.revision('b1', 'h1')).toBe(1);
    expect(s.revision('b1', 'h1')).toBe(1);
    expect(s.revision('b1', 'h2')).toBe(2);
    expect(s.revision('b2', 'h1')).toBe(1);
  });
  it('stays bounded', () => {
    const s = new ToolState(10);
    for (let i = 0; i < 100; i++) s.store(`k${i}`, i, { ok: true });
    expect(s.cached('k99', 99)).not.toBeNull();
    expect(s.cached('k0', 99)).toBeNull();
  });
});

describe('/el/tools on a DB-less app: auth and rate limit', () => {
  // postgres.js connects lazily, so these paths never touch a database.
  function app(env: Record<string, string> = {}, state = new ToolState()) {
    const { deps } = createDeps({
      env: testEnv({ ELEVENLABS_TOOL_SECRET: 'tool-secret', ...env }),
      rateLimit: true,
    });
    return buildApp(deps, [
      createVoiceRoutes({
        state,
        elevenlabs: { conversationToken: async () => ({ token: 't', conversation_id: 'c' }) },
      }),
    ]);
  }
  const call = (a: ReturnType<typeof app>, headers: Record<string, string>, body: unknown) =>
    a.request('/el/tools/propose_terms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('a bad or missing secret is a 401 (the only non-200)', async () => {
    const a = app();
    expect((await call(a, {}, {})).status).toBe(401);
    expect((await call(a, { 'X-YO-Tool-Secret': 'nope' }, {})).status).toBe(401);
    // header names are case-insensitive
    const r = await call(a, { 'x-yo-tool-secret': 'tool-secret' }, 'not json');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, fix: 'INVALID' });
  });

  it('fails closed when ELEVENLABS_TOOL_SECRET is unset', async () => {
    const { deps } = createDeps({ env: testEnv(), rateLimit: false });
    const a = buildApp(deps, [createVoiceRoutes()]);
    const r = await call(a, { 'X-YO-Tool-Secret': '' }, {});
    expect(r.status).toBe(401);
  });

  it('missing ids -> WRONG_BET, 200', async () => {
    const r = await call(app(), { 'X-YO-Tool-Secret': 'tool-secret' }, { claim: 'x' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: false,
      fix: 'WRONG_BET',
      say: "That's not this bet's docket.",
    });
  });

  it(`more than ${EL_TOOLS_BUCKET.limit}/min per conversation -> SLOW_DOWN (200, not 429); duplicates replay`, async () => {
    // Seed the 10 s dedupe cache so calls replay without touching a database.
    const state = new ToolState();
    const body = { conversation_id: 'conv_rl', bet_id: 'b', claim: 'x' };
    state.store(toolDedupeKey('conv_rl', 'propose_terms', body), Date.now(), { ok: true, rev: 7 });
    state.store(
      toolDedupeKey('conv_other', 'propose_terms', { ...body, conversation_id: 'conv_other' }),
      Date.now(),
      { ok: true, rev: 8 },
    );
    const a = app({}, state);
    const h = { 'X-YO-Tool-Secret': 'tool-secret' };
    const seen: unknown[] = [];
    for (let i = 0; i <= EL_TOOLS_BUCKET.limit; i++) {
      const r = await call(a, h, body);
      expect(r.status).toBe(200);
      seen.push(await r.json());
    }
    expect(
      seen
        .slice(0, EL_TOOLS_BUCKET.limit)
        .every((r) => JSON.stringify(r) === '{"ok":true,"rev":7}'),
    ).toBe(true);
    expect(seen.at(-1)).toMatchObject({ ok: false, fix: 'SLOW_DOWN' });
    // the bucket is per conversation
    const other = await call(a, h, { ...body, conversation_id: 'conv_other' });
    expect(await other.json()).toEqual({ ok: true, rev: 8 });
  });
});

// ---- agent as code ---------------------------------------------------------------------

/** In-memory ElevenLabs: stores what is POSTed, echoes it back with server-side defaults added. */
function fakeElevenLabs() {
  const store = {
    secrets: [] as any[],
    tools: [] as any[],
    agents: [] as any[],
    writes: [] as string[],
  };
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;
  const http: ElHttp = {
    async request(method, path, body: any) {
      const [p, qs] = path.split('?');
      const search = new URLSearchParams(qs).get('search') ?? '';
      if (method !== 'GET') store.writes.push(`${method} ${p}`);
      if (method === 'GET' && p === '/v1/convai/secrets')
        return { secrets: store.secrets.filter((s) => s.name.startsWith(search)) };
      if (method === 'POST' && p === '/v1/convai/secrets') {
        const s = {
          type: 'stored',
          secret_id: id('sec'),
          name: body.name,
          used_by: {},
          _value: body.value,
        };
        store.secrets.push(s);
        return { type: 'stored', secret_id: s.secret_id, name: s.name };
      }
      if (method === 'PATCH' && p!.startsWith('/v1/convai/secrets/')) {
        const s = store.secrets.find((x) => p!.endsWith(x.secret_id));
        s._value = body.value;
        return { type: 'stored', secret_id: s.secret_id, name: s.name };
      }
      if (method === 'GET' && p === '/v1/convai/tools')
        return {
          tools: store.tools.filter((t) => t.tool_config.name.startsWith(search)),
          has_more: false,
        };
      if (method === 'POST' && p === '/v1/convai/tools') {
        const t = {
          id: id('tool'),
          tool_config: {
            ...body.tool_config,
            assignments: [],
            dynamic_variables: { dynamic_variable_placeholders: {} },
          },
          access_info: {},
          usage_stats: {},
        };
        store.tools.push(t);
        return t;
      }
      if (method === 'PATCH' && p!.startsWith('/v1/convai/tools/')) {
        const t = store.tools.find((x) => p!.endsWith(x.id));
        t.tool_config = { ...body.tool_config, assignments: [] };
        return t;
      }
      if (method === 'GET' && p === '/v1/convai/agents')
        return {
          agents: store.agents
            .filter((a) => a.name.startsWith(search))
            .map((a) => ({ agent_id: a.agent_id, name: a.name, archived: false })),
          has_more: false,
        };
      if (method === 'POST' && p === '/v1/convai/agents/create') {
        const a = {
          agent_id: id('agent'),
          ...structuredClone(body),
          metadata: { created_at_unix_secs: 1 },
        };
        a.conversation_config.vad = { background_voice_detection: false };
        a.conversation_config.agent.prompt.rag = { enabled: false };
        store.agents.push(a);
        return { agent_id: a.agent_id };
      }
      if (p!.startsWith('/v1/convai/agents/')) {
        const a = store.agents.find((x) => p!.endsWith(x.agent_id));
        if (method === 'GET') return structuredClone(a);
        if (method === 'PATCH') {
          Object.assign(a, structuredClone(body));
          return a;
        }
      }
      throw new Error(`fake ElevenLabs: unhandled ${method} ${path}`);
    },
  };
  return { http, store };
}

const OPTS: SyncOptions = {
  baseUrl: 'https://youre-on.fly.dev/',
  toolSecret: 'Zk9-value-of-the-secret',
};

describe('agent as code (scripts/el-agent.ts engine, D0-J2)', () => {
  it('first run creates secret, tools and agent; a second run is a no-op', async () => {
    const { http, store } = fakeElevenLabs();
    const first = await syncAgent(http, OPTS);
    expect(first.actions.map((a) => `${a.resource}:${a.name}:${a.action}`)).toEqual([
      'secret:yo-tool-secret:create',
      'tool:propose_terms:create',
      'tool:confirm_terms:create',
      'tool:get_market_odds:create',
      'tool:suggest_odds:create',
      'tool:request_attempt:create',
      'tool:show_terms_card:create',
      'tool:cue:create',
      'agent:youre-on-judge:create',
    ]);
    expect(store.secrets[0]._value).toBe('Zk9-value-of-the-secret');
    const writes = store.writes.length;

    const second = await syncAgent(http, OPTS);
    expect(second.actions.every((a) => a.action === 'noop')).toBe(true);
    expect(store.writes.length).toBe(writes); // no POST/PATCH at all
    expect(second.agent_id).toBe(first.agent_id);
    expect(second.tool_ids).toEqual(first.tool_ids);
  });

  it('the agent carries the D0-J2 settings', async () => {
    const { http, store } = fakeElevenLabs();
    const r = await syncAgent(http, OPTS);
    const a = store.agents[0];
    const prompt = a.conversation_config.agent.prompt;
    expect(prompt.llm).toBe('claude-haiku-5-5');
    expect(prompt).toHaveProperty('temperature', null); // omitted from the LLM request
    expect(prompt.backup_llm_config).toEqual({ preference: 'disabled' });
    expect(prompt.max_tokens).toBe(AGENT_MAX_TOKENS); // room for adaptive thinking + a full tool call
    expect(prompt.enable_parallel_tool_calls).toBe(false);
    expect(prompt.tool_ids).toEqual(Object.values(r.tool_ids));
    expect(a.platform_settings.call_limits.bursting_enabled).toBe(false);
    expect(a.platform_settings.auth.enable_auth).toBe(true);
    expect(a.platform_settings.privacy.record_voice).toBe(false);
    expect(a.conversation_config.tts).toMatchObject({
      model_id: 'eleven_v4_turbo',
      agent_output_audio_format: 'pcm_16000',
      speed: 1.05,
    });
    expect(a.conversation_config.asr).toMatchObject({ provider: 'scribe_realtime' });
    expect(a.conversation_config.turn).toMatchObject({
      turn_eagerness: 'eager',
      speculative_turn: true,
    });
    expect(a.conversation_config.turn.soft_timeout_config.timeout_seconds).toBeGreaterThanOrEqual(
      1,
    );
    expect(a.conversation_config.turn.soft_timeout_config.timeout_seconds).toBeLessThanOrEqual(1.2);
    expect(a.conversation_config.turn.turn_timeout).toBeGreaterThanOrEqual(20);
    expect(a.conversation_config.conversation.max_duration_seconds).toBe(1200);
    for (const e of [
      'agent_response',
      'user_transcript',
      'agent_tool_request',
      'agent_tool_response',
      'client_tool_call',
      'interruption',
      'vad_score',
    ])
      expect(CLIENT_EVENTS).toContain(e);
    // no client overrides (a token holder must not pick a costlier LLM / TTS model), sent as
    // explicit false so a sync turns them off on the existing agent
    expect(a.platform_settings.overrides.conversation_config_override).toEqual({
      agent: { first_message: false, prompt: { llm: false } },
      tts: { model_id: false },
    });
  });

  it('webhook tools: Fly URL, secret header by secret_id, force pre-tool speech on propose_terms, §4.2 settings', async () => {
    const { http, store } = fakeElevenLabs();
    const r = await syncAgent(http, OPTS);
    const pt = store.tools.find((t) => t.tool_config.name === 'propose_terms').tool_config;
    expect(pt.api_schema.url).toBe('https://youre-on.fly.dev/el/tools/propose_terms');
    expect(pt.api_schema.method).toBe('POST');
    expect(pt.api_schema.request_headers).toEqual({
      'X-YO-Tool-Secret': { secret_id: r.secret_id },
    });
    expect(pt).toMatchObject({
      pre_tool_speech: 'force',
      response_timeout_secs: 5,
      execution_mode: 'immediate',
      interruption_mode: 'allow',
      tool_error_handling_mode: 'passthrough',
    });
    const ra = store.tools.find((t) => t.tool_config.name === 'request_attempt').tool_config;
    expect(ra).toMatchObject({ type: 'client', expects_response: true, response_timeout_secs: 5 });
  });

  it('a changed setting is PATCHed (only that resource) and reported by path', async () => {
    const { http, store } = fakeElevenLabs();
    await syncAgent(http, OPTS);
    store.writes.length = 0;
    const r = await syncAgent(http, { ...OPTS, agent: { ttsModel: 'eleven_flash_v2' } });
    const agent = r.actions.find((a) => a.resource === 'agent')!;
    expect(agent.action).toBe('update');
    expect(agent.changed).toEqual(['conversation_config.tts.model_id']);
    expect(store.writes).toEqual([`PATCH /v1/convai/agents/${r.agent_id}`]);
    // and the next run is a no-op again
    store.writes.length = 0;
    await syncAgent(http, { ...OPTS, agent: { ttsModel: 'eleven_flash_v2' } });
    expect(store.writes).toEqual([]);
  });

  it('a new base URL updates the webhook tools; --rotate-secret PATCHes the secret', async () => {
    const { http, store } = fakeElevenLabs();
    await syncAgent(http, OPTS);
    store.writes.length = 0;
    const r = await syncAgent(http, {
      ...OPTS,
      baseUrl: 'https://other.fly.dev',
      toolSecret: 'new',
      rotateSecret: true,
    });
    expect(r.actions.find((a) => a.name === 'propose_terms')).toMatchObject({
      action: 'update',
      changed: ['api_schema.url'],
    });
    expect(store.writes.sort()).toEqual(
      [
        `PATCH /v1/convai/secrets/${r.secret_id}`,
        `PATCH /v1/convai/tools/${r.tool_ids.propose_terms}`,
        `PATCH /v1/convai/tools/${r.tool_ids.confirm_terms}`,
        `PATCH /v1/convai/tools/${r.tool_ids.get_market_odds}`,
        `PATCH /v1/convai/tools/${r.tool_ids.suggest_odds}`,
      ].sort(),
    );
    expect(store.secrets[0]._value).toBe('new');
  });

  it('--rotate-secret is never a no-op (the stored value is write-only); without it a rerun is', async () => {
    const { http, store } = fakeElevenLabs();
    await syncAgent(http, { ...OPTS, rotateSecret: true });
    store.writes.length = 0;
    const again = await syncAgent(http, { ...OPTS, rotateSecret: true });
    expect(store.writes).toEqual([`PATCH /v1/convai/secrets/${again.secret_id}`]);
    store.writes.length = 0;
    const check = await syncAgent(http, OPTS);
    expect(store.writes).toEqual([]);
    expect(check.actions.every((a) => a.action === 'noop')).toBe(true);
  });

  it('an agent synced before Beat 6 gains get_market_odds: the tool is created, the agent PATCHed', async () => {
    const { http, store } = fakeElevenLabs();
    const before = await syncAgent(http, {
      ...OPTS,
      webhookTools: ['propose_terms', 'confirm_terms'],
    });
    expect(before.tool_ids).not.toHaveProperty('get_market_odds');
    store.writes.length = 0;
    const r = await syncAgent(http, OPTS); // the default tool set
    expect(r.actions.find((a) => a.name === 'get_market_odds')).toMatchObject({ action: 'create' });
    const agent = r.actions.find((a) => a.resource === 'agent')!;
    expect(agent.action).toBe('update');
    expect(agent.changed).toEqual(
      expect.arrayContaining([
        'conversation_config.agent.prompt.tool_ids',
        'conversation_config.agent.prompt.prompt',
      ]),
    );
    // get_market_odds and (odds) suggest_odds
    expect(store.writes).toEqual([
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      `PATCH /v1/convai/agents/${before.agent_id}`,
    ]);
    const tool = store.tools.find((t) => t.tool_config.name === 'get_market_odds').tool_config;
    expect(tool.api_schema.url).toBe('https://youre-on.fly.dev/el/tools/get_market_odds');
    expect(tool.pre_tool_speech).toBe('force');
    const prompt = store.agents[0].conversation_config.agent.prompt;
    expect(prompt.tool_ids).toContain(r.tool_ids.get_market_odds);
    expect(prompt.prompt).toContain('- get_market_odds:');
    // and the run after that is a no-op
    store.writes.length = 0;
    await syncAgent(http, OPTS);
    expect(store.writes).toEqual([]);
  });

  it('refuses to guess when two resources share a name', async () => {
    const { http, store } = fakeElevenLabs();
    await syncAgent(http, OPTS);
    store.tools.push(structuredClone(store.tools[0]));
    await expect(syncAgent(http, OPTS)).rejects.toThrow(/share the name/);
  });

  it('dry run needs no HTTP and prints the first-run bodies with placeholders', () => {
    const plan = dryRunPlan(OPTS);
    expect(plan.map((a) => `${a.method} ${a.path}`)).toEqual([
      'POST /v1/convai/secrets',
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      'POST /v1/convai/tools',
      'POST /v1/convai/agents/create',
    ]);
    expect(JSON.stringify(plan)).not.toContain('Zk9-value-of-the-secret'); // the secret value is never printed
    expect(plan[0]!.body).toEqual({
      type: 'new',
      name: 'yo-tool-secret',
      value: '<ELEVENLABS_TOOL_SECRET>',
    });
  });

  it('isSubset / diffPaths', () => {
    expect(isSubset({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2, d: 3 }], e: 4 })).toBe(true);
    expect(isSubset({ b: [1] }, { b: [1, 2] })).toBe(false);
    expect(isSubset({ t: null }, {})).toBe(true);
    expect(diffPaths({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })).toEqual(['a.c']);
  });

  it('fetchElHttp sends xi-api-key and JSON, and redacts secrets from errors', async () => {
    const seen: RequestInit[] = [];
    const http = fetchElHttp({
      apiKey: 'sk_x',
      redact: ['tool-secret'],
      fetch: async (_u, i) => {
        seen.push(i!);
        return new Response('{"detail":"value tool-secret is invalid"}', { status: 422 });
      },
    });
    const err = await http
      .request('POST', '/v1/convai/secrets', { value: 'tool-secret' })
      .catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 422');
    expect(String(err)).not.toContain('tool-secret');
    expect((seen[0]!.headers as Record<string, string>)['xi-api-key']).toBe('sk_x');
    expect((seen[0]!.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
