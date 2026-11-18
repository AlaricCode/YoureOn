// GET /v1/demo/voice and the boot line `voice.readiness`: is the voice judge switched on, and
// exactly what does go-live still need? (config only, no ElevenLabs call, no secret values).
// DB-less: postgres.js connects lazily and this route never queries.
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDeps } from '../src/server';
import { voiceReadiness, type VoiceReadiness } from '../src/voice/readiness';
import { createVoiceRoutes } from '../src/voice/routes';
import { testEnv } from './helpers';

const ADMIN = 'demo-admin-for-readiness';
const FULL = {
  ELEVENLABS_API_KEY: 'xi-not-a-real-key',
  ELEVENLABS_AGENT_ID: 'agent_123',
  ELEVENLABS_TOOL_SECRET: 'tool-secret-value',
  ELEVENLABS_WEBHOOK_SECRET: 'wsec-not-a-real-secret',
  ELEVENLABS_JUDGE_VOICE_ID: 'voice_judge',
  PUBLIC_BASE_URL: 'https://youre-on.fly.dev/',
  ALLOW_SPEND: 'true',
};

/** What production has today (fly.toml + REQUIRED_IN_PRODUCTION): the key is pending. */
const FLY_TODAY = {
  ELEVENLABS_TOOL_SECRET: 'tool-secret-value',
  PUBLIC_BASE_URL: 'https://youre-on.fly.dev',
  ALLOW_SPEND: 'true',
};

function app(env: Record<string, string>) {
  const { deps } = createDeps({
    env: testEnv({ DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN, ...env }),
    rateLimit: false,
  });
  const info = vi.fn();
  deps.log = { ...deps.log, info, warn: vi.fn() };
  return { a: buildApp(deps, [createVoiceRoutes()]), info };
}
const get = (a: ReturnType<typeof app>['a'], key: string | null = ADMIN) =>
  a.request('/v1/demo/voice', { headers: key === null ? {} : { 'X-YO-Demo-Key': key } });
const body = async (env: Record<string, string>) =>
  (await (await get(app(env).a)).json()) as VoiceReadiness;

const MISSING = {
  API_KEY: 'ELEVENLABS_API_KEY (fly secrets set; scripts/el-agent.ts uses it too)',
  TOOL_SECRET:
    'ELEVENLABS_TOOL_SECRET (openssl rand -base64 32; scripts/el-agent.ts stores it in ElevenLabs as yo-tool-secret)',
  BASE_URL: 'PUBLIC_BASE_URL (the public https:// URL ElevenLabs calls, https://youre-on.fly.dev)',
  AGENT_ID: 'ELEVENLABS_AGENT_ID (scripts/el-agent.ts prints it)',
  SPEND: 'ALLOW_SPEND=true (a conversation token starts a billed session)',
  webhook: (url: string) =>
    `ELEVENLABS_WEBHOOK_SECRET (the signing secret ElevenLabs shows for the post-call webhook ${url}; transcripts are refused (404) until it is set)`,
};

describe('voice readiness', () => {
  it('everything set (production client): ready, the tool and webhook URLs, and no secret value anywhere', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const r = await get(app(FULL).a);
      expect(r.status).toBe(200);
      const b = await r.json();
      expect(b).toEqual({
        ready: true,
        judge_ready: true,
        missing: [],
        optional: [],
        agent_id: 'agent_123',
        judge_voice_id: 'voice_judge',
        tool_urls: [
          'https://youre-on.fly.dev/el/tools/propose_terms',
          'https://youre-on.fly.dev/el/tools/confirm_terms',
          'https://youre-on.fly.dev/el/tools/get_market_odds',
          'https://youre-on.fly.dev/el/tools/request_review',
          'https://youre-on.fly.dev/el/tools/suggest_odds',
        ],
        webhook_url: 'https://youre-on.fly.dev/webhooks/elevenlabs',
        set: {
          ELEVENLABS_API_KEY: true,
          ELEVENLABS_AGENT_ID: true,
          ELEVENLABS_TOOL_SECRET: true,
          ELEVENLABS_WEBHOOK_SECRET: true,
          PUBLIC_BASE_URL: true,
          ALLOW_SPEND: true,
        },
      });
      const text = JSON.stringify(b);
      for (const secret of [
        FULL.ELEVENLABS_API_KEY,
        FULL.ELEVENLABS_TOOL_SECRET,
        FULL.ELEVENLABS_WEBHOOK_SECRET,
      ])
        expect(text).not.toContain(secret);
      expect(fetchSpy).not.toHaveBeenCalled(); // config only
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('nothing set: every go-live step, in order, as the setting to fix', async () => {
    const b = await body({});
    expect(b).toMatchObject({ ready: false, judge_ready: false, webhook_url: null });
    expect(b.missing).toEqual([
      MISSING.API_KEY,
      MISSING.TOOL_SECRET,
      MISSING.BASE_URL,
      MISSING.AGENT_ID,
      MISSING.SPEND,
      MISSING.webhook('<PUBLIC_BASE_URL>/webhooks/elevenlabs'),
    ]);
    expect(b.optional).toEqual([expect.stringMatching(/^ELEVENLABS_JUDGE_VOICE_ID \(/)]);
  });

  it('production today (key pending): exactly the key, the agent id and the webhook secret', async () => {
    const b = await body(FLY_TODAY);
    expect(b.missing).toEqual([
      MISSING.API_KEY,
      MISSING.AGENT_ID,
      MISSING.webhook('https://youre-on.fly.dev/webhooks/elevenlabs'),
    ]);
    expect(b.tool_urls).toHaveLength(4);
  });

  it('the judge can be ready while the post-call webhook is not (ready needs both)', async () => {
    const { ELEVENLABS_WEBHOOK_SECRET: _omit, ...noWebhook } = FULL;
    const b = await body(noWebhook);
    expect(b).toMatchObject({ ready: false, judge_ready: true });
    expect(b.missing).toEqual([MISSING.webhook('https://youre-on.fly.dev/webhooks/elevenlabs')]);
    const noSpend = await body({ ...FULL, ALLOW_SPEND: 'false' });
    expect(noSpend).toMatchObject({ ready: false, judge_ready: false, missing: [MISSING.SPEND] });
  });

  it('a base URL ElevenLabs cannot reach is named (the same rule as scripts/el-agent.ts)', async () => {
    expect((await body({ ...FULL, PUBLIC_BASE_URL: 'http://youre-on.fly.dev' })).missing).toEqual([
      'PUBLIC_BASE_URL must be https:// (ElevenLabs calls it from the internet)',
    ]);
    expect((await body({ ...FULL, PUBLIC_BASE_URL: 'https://localhost:8080' })).missing).toEqual([
      'PUBLIC_BASE_URL https://localhost:8080 is not reachable from ElevenLabs',
    ]);
  });

  it('the boot line voice.readiness carries the same list', () => {
    const { info } = app(FLY_TODAY);
    expect(info).toHaveBeenCalledWith('voice.readiness', {
      ready: false,
      judge_ready: false,
      missing: [
        MISSING.API_KEY,
        MISSING.AGENT_ID,
        MISSING.webhook('https://youre-on.fly.dev/webhooks/elevenlabs'),
      ],
      optional: [expect.stringMatching(/^ELEVENLABS_JUDGE_VOICE_ID/)],
      webhook_url: 'https://youre-on.fly.dev/webhooks/elevenlabs',
    });
  });

  it('is a demo route: 404 without the demo key or outside DEMO_MODE', async () => {
    expect((await get(app(FULL).a, null)).status).toBe(404);
    expect((await get(app(FULL).a, 'wrong')).status).toBe(404);
    expect((await get(app({ ...FULL, DEMO_MODE: 'false' }).a)).status).toBe(404);
  });

  it('an injected client counts as a client (tests, scripts)', () => {
    const env = testEnv({ ...FULL, ALLOW_SPEND: 'false' });
    expect(voiceReadiness(env, true).ready).toBe(true);
    expect(voiceReadiness(env, false).missing).toEqual([MISSING.SPEND]);
  });
});
