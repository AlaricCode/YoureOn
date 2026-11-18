// GET /v1/demo/voice: is the voice judge switched on? (config only, no ElevenLabs call, no
// secret values). DB-less: postgres.js connects lazily and this route never queries.
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
  PUBLIC_BASE_URL: 'https://youre-on.fly.dev/',
  ALLOW_SPEND: 'true',
};

function app(env: Record<string, string>) {
  const { deps } = createDeps({
    env: testEnv({ DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN, ...env }),
    rateLimit: false,
  });
  return buildApp(deps, [createVoiceRoutes()]);
}
const get = (a: ReturnType<typeof app>, key: string | null = ADMIN) =>
  a.request('/v1/demo/voice', { headers: key === null ? {} : { 'X-YO-Demo-Key': key } });

describe('voice readiness', () => {
  it('everything set (production client): ready, the tool URLs, and no secret value anywhere', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const r = await get(app(FULL));
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toEqual({
        ready: true,
        missing: [],
        agent_id: 'agent_123',
        judge_voice_id: null,
        tool_urls: [
          'https://youre-on.fly.dev/el/tools/propose_terms',
          'https://youre-on.fly.dev/el/tools/confirm_terms',
          'https://youre-on.fly.dev/el/tools/get_market_odds',
        ],
        set: {
          ELEVENLABS_API_KEY: true,
          ELEVENLABS_AGENT_ID: true,
          ELEVENLABS_TOOL_SECRET: true,
          PUBLIC_BASE_URL: true,
          ALLOW_SPEND: true,
        },
      });
      const text = JSON.stringify(body);
      expect(text).not.toContain(FULL.ELEVENLABS_API_KEY);
      expect(text).not.toContain(FULL.ELEVENLABS_TOOL_SECRET);
      expect(fetchSpy).not.toHaveBeenCalled(); // config only
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('lists what is missing, as the setting to fix', async () => {
    const body = (await (await get(app({}))).json()) as VoiceReadiness;
    expect(body.ready).toBe(false);
    expect(body.missing).toEqual([
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_AGENT_ID (scripts/el-agent.ts prints it)',
      'ELEVENLABS_TOOL_SECRET',
      'PUBLIC_BASE_URL',
      'ALLOW_SPEND=true',
    ]);
    const noSpend = { ...FULL, ALLOW_SPEND: 'false' };
    const partial = (await (await get(app(noSpend))).json()) as VoiceReadiness;
    expect(partial.missing).toEqual(['ALLOW_SPEND=true']);
  });

  it('is a demo route: 404 without the demo key or outside DEMO_MODE', async () => {
    expect((await get(app(FULL), null)).status).toBe(404);
    expect((await get(app(FULL), 'wrong')).status).toBe(404);
    expect((await get(app({ ...FULL, DEMO_MODE: 'false' }))).status).toBe(404);
  });

  it('an injected client counts as a client (tests, scripts)', () => {
    const env = testEnv({ ...FULL, ALLOW_SPEND: 'false' });
    expect(voiceReadiness(env, true).ready).toBe(true);
    expect(voiceReadiness(env, false).missing).toEqual(['ALLOW_SPEND=true']);
  });
});
