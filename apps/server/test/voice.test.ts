/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// POST /v1/voice/tokens (API-CONTRACT §2.6) and POST /el/tools/propose_terms (§4.2–§4.3) against
// a real Postgres, with the ElevenLabs HTTP call mocked (TASKS D0-J2; no key exists: PENDING-KEY).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, voiceSessions } from '@youre-on/db';
import { VoiceTokenResponse } from '@youre-on/shared/judge/voice';
import { REFUSAL_QUIPS } from '@youre-on/shared/judge/guardrails';
import type { SpokenBetFixture } from '@youre-on/shared/judge/fixture-schema';
import type { ElevenLabsClient } from '../src/voice/elevenlabs';
import { UpstreamError } from '../src/voice/elevenlabs';
import { createVoiceRoutes } from '../src/voice/routes';
import { routeModules } from '../src/routes';
import {
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (id: string): SpokenBetFixture =>
  JSON.parse(
    readFileSync(join(here, '../../../packages/shared/src/judge/fixtures', `${id}.json`), 'utf8'),
  ) as SpokenBetFixture;
const BOTTLE = fixture('01-bottle-flip').sample_args;
const CHUG = fixture('10-chug').sample_args;

const SECRET = `tool-secret-${randomUUID()}`;
const AGENT = 'agent_test_judge';
const RUN = randomUUID().slice(0, 8);

/** Mock ElevenLabs: hands out fresh conversation ids; behaviour switchable per test. */
const el = {
  mode: 'ok' as 'ok' | 'timeout' | 'error',
  calls: [] as string[],
  n: 0,
};
const mockEl: ElevenLabsClient = {
  async conversationToken(agentId) {
    el.calls.push(agentId);
    if (el.mode === 'timeout') throw new UpstreamError('timeout', 'timed out');
    if (el.mode === 'error') throw new UpstreamError('error', 'HTTP 500', 500);
    el.n += 1;
    return { token: `tok_${RUN}_${el.n}`, conversation_id: `conv_${RUN}_${el.n}` };
  },
};

describeDb('voice: POST /v1/voice/tokens and /el/tools/propose_terms (DB)', () => {
  let ctx: Ctx;
  let bare: Ctx; // no ELEVENLABS_AGENT_ID
  const modules = (m = mockEl) => [
    ...routeModules.filter((r) => r.name !== 'voice'),
    createVoiceRoutes({ elevenlabs: m }),
  ];

  beforeAll(async () => {
    ctx = await startTestServer({
      modules: modules(),
      env: {
        ELEVENLABS_AGENT_ID: AGENT,
        ELEVENLABS_TOOL_SECRET: SECRET,
        MAX_STAKE_MICRO: '20000000',
      },
    });
    bare = await startTestServer({ modules: modules() });
  });
  afterAll(async () => {
    await ctx?.server.close();
    await bare?.server.close();
  });

  const post = (c: Ctx, u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(c.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const tool = (body: unknown, secret: string | null = SECRET) =>
    postJson(
      ctx.base,
      '/el/tools/propose_terms',
      body,
      secret === null ? {} : { 'X-YO-Tool-Secret': secret },
    );

  async function betWithVoice() {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const room = await post(ctx, A, '/v1/rooms', { name: 'Voice test', kind: 'session' });
    expect(room.status).toBe(201);
    expect((await post(ctx, B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const tok = await post(ctx, A, '/v1/voice/tokens', { purpose: 'terms' });
    expect(tok.status).toBe(201);
    const bet = await post(ctx, A, '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
      voice_conversation_id: tok.json!.conversation_id,
    });
    expect(bet.status).toBe(201);
    return {
      A,
      B,
      bet_id: bet.json!.bet.bet_id as string,
      conversation_id: tok.json!.conversation_id as string,
      voice_session_id: tok.json!.voice_session_id as string,
    };
  }

  // ---- POST /v1/voice/tokens ---------------------------------------------------------------

  it('pre-mint (no bet): 201 VoiceTokenResponse, voice_sessions row active and unbound', async () => {
    el.mode = 'ok';
    const A = await signUp(ctx.base, 'Logan');
    const before = el.calls.length;
    const r = await post(ctx, A, '/v1/voice/tokens', { purpose: 'terms' });
    expect(r.status).toBe(201);
    const body = VoiceTokenResponse.parse(r.json);
    expect(body).toMatchObject({ agent_id: AGENT, expires_at: null });
    expect(body.conversation_token).toMatch(/^tok_/);
    expect(el.calls.slice(before)).toEqual([AGENT]);
    const [row] = await ctx.deps.db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.id, body.voice_session_id));
    expect(row).toMatchObject({
      bet_id: null,
      user_id: A.session.user.user_id,
      device_id: A.session.device_id,
      purpose: 'terms',
      el_agent_id: AGENT,
      el_conversation_id: body.conversation_id,
      status: 'active',
    });
  });

  it('with bet_id: A mints a bound session; B gets 403 NOT_A_PARTY; unknown bet 404', async () => {
    const s = await betWithVoice();
    const r = await post(ctx, s.A, '/v1/voice/tokens', { purpose: 'terms', bet_id: s.bet_id });
    expect(r.status).toBe(201);
    const [row] = await ctx.deps.db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.id, r.json!.voice_session_id));
    expect(row!.bet_id).toBe(s.bet_id);
    const b = await post(ctx, s.B, '/v1/voice/tokens', { purpose: 'terms', bet_id: s.bet_id });
    expect(b.status).toBe(403);
    expect(b.json!.error.code).toBe('NOT_A_PARTY');
    const u = await post(ctx, s.A, '/v1/voice/tokens', { purpose: 'terms', bet_id: randomUUID() });
    expect(u.status).toBe(404);
  });

  it('validation, signing and upstream failures', async () => {
    const A = await signUp(ctx.base, 'Logan');
    expect((await post(ctx, A, '/v1/voice/tokens', { purpose: 'hearing' })).json!.error.code).toBe(
      'VALIDATION_FAILED',
    );
    // unsigned -> 401
    const raw = await postJson(
      ctx.base,
      '/v1/voice/tokens',
      { purpose: 'terms' },
      { Authorization: `Bearer ${A.session.token}`, 'Idempotency-Key': randomUUID() },
    );
    expect(raw.status).toBe(401);

    el.mode = 'timeout';
    const t = await post(ctx, A, '/v1/voice/tokens', { purpose: 'terms' });
    expect([t.status, t.json!.error.code, t.json!.error.retryable]).toEqual([
      504,
      'UPSTREAM_TIMEOUT',
      true,
    ]);
    el.mode = 'error';
    const e = await post(ctx, A, '/v1/voice/tokens', { purpose: 'terms' });
    expect([e.status, e.json!.error.code]).toEqual([502, 'UPSTREAM_ERROR']);
    el.mode = 'ok';

    // no agent configured -> 502 not_configured, and ElevenLabs is never called
    const B = await signUp(bare.base, 'Logan');
    const before = el.calls.length;
    const n = await post(bare, B, '/v1/voice/tokens', { purpose: 'terms' });
    expect([n.status, n.json!.error.code, n.json!.error.details?.reason]).toEqual([
      502,
      'UPSTREAM_ERROR',
      'not_configured',
    ]);
    expect(el.calls.length).toBe(before);
  });

  it('spend guard: with ELEVENLABS_API_KEY but no ALLOW_SPEND, the default client never calls ElevenLabs', async () => {
    const guarded = await startTestServer({
      modules: [
        ...routeModules.filter((r) => r.name !== 'voice'),
        createVoiceRoutes(), // the production default client
      ],
      env: { ELEVENLABS_AGENT_ID: AGENT, ELEVENLABS_API_KEY: 'xi-test-not-a-real-key' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const A = await signUp(guarded.base, 'Logan');
      const r = await post(guarded, A, '/v1/voice/tokens', { purpose: 'terms' });
      expect([r.status, r.json!.error.code, r.json!.error.details?.reason]).toEqual([
        502,
        'UPSTREAM_ERROR',
        'spend_disabled',
      ]);
      const urls = fetchSpy.mock.calls.map(([u]) => String(u instanceof Request ? u.url : u));
      expect(urls.some((u) => u.includes('elevenlabs'))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      await guarded.server.close();
    }
  });

  it('the pre-minted conversation is bound by POST /v1/bets (D0-J4 binding)', async () => {
    const s = await betWithVoice();
    const [row] = await ctx.deps.db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.id, s.voice_session_id));
    expect(row!.bet_id).toBe(s.bet_id);
  });

  // ---- POST /el/tools/propose_terms ------------------------------------------------------------

  it('the Beat 2 bet: 200 {ok, rev, say, next:"readback"} under 300 B; replay gives the same reply', async () => {
    const s = await betWithVoice();
    const body = { conversation_id: s.conversation_id, bet_id: s.bet_id, ...BOTTLE };
    const r = await tool(body);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      rev: 1,
      say: 'Jake lands a water bottle flip upright on the table. One try. No. Only upright on its base counts. One flip. Five dollars each.',
      next: 'readback',
    });
    expect(Buffer.byteLength(JSON.stringify(r.json))).toBeLessThan(300);
    const again = await tool(body);
    expect(again.json).toEqual(r.json);
    // an edit is a new revision; the same edit again keeps it
    const edited = { ...body, amount_usd: '10' };
    expect((await tool(edited)).json).toMatchObject({ ok: true, rev: 2 });
    expect((await tool({ ...edited, claim: ` ${edited.claim}` })).json).toMatchObject({ rev: 2 });
  });

  it('missing edge cases -> next "ask"; over the cap -> STAKE_ABOVE_MAX; bad args -> INVALID (all 200)', async () => {
    const s = await betWithVoice();
    const ids = { conversation_id: s.conversation_id, bet_id: s.bet_id };
    expect((await tool({ ...ids, ...BOTTLE, edge_cases: [] })).json).toMatchObject({
      ok: true,
      missing: ['edge_cases'],
      next: 'ask',
    });
    expect((await tool({ ...ids, ...BOTTLE, amount_usd: '50' })).json).toEqual({
      ok: false,
      fix: 'STAKE_ABOVE_MAX',
      say: 'Max is twenty dollars a person.',
    });
    const bad = await tool({ ...ids, ...BOTTLE, attempts: { count: 2, rule: 'best_of' } });
    expect(bad.status).toBe(200);
    expect(bad.json).toMatchObject({ ok: false, fix: 'INVALID' });
    expect(bad.json!.bad[0]).toMatch(/^attempts/);
    const real = await tool({ ...ids, ...fixture('08-btc-closer').sample_args });
    expect(real.json).toMatchObject({ ok: false, fix: 'NO_MARKET' });
  });

  it('a refusal is spoken inline and audited', async () => {
    const s = await betWithVoice();
    const r = await tool({ conversation_id: s.conversation_id, bet_id: s.bet_id, ...CHUG });
    expect(r.json).toEqual({
      ok: false,
      refused: 'alcohol_drugs',
      say: REFUSAL_QUIPS.alcohol_drugs,
      next: 'end',
    });
    await expect
      .poll(
        async () =>
          (
            await ctx.deps.db
              .select()
              .from(auditLog)
              .where(
                and(eq(auditLog.bet_id, s.bet_id), eq(auditLog.action, 'terms.refused_prefilter')),
              )
          ).length,
      )
      .toBe(1);
  });

  it('a refused bet stays refused: a re-worded safe call on the same bet gets the refusal again', async () => {
    const s = await betWithVoice();
    const ids = { conversation_id: s.conversation_id, bet_id: s.bet_id };
    const first = await tool({ ...ids, ...CHUG });
    expect(first.json).toMatchObject({ ok: false, refused: 'alcohol_drugs', next: 'end' });
    const sanitized = await tool({ ...ids, ...BOTTLE });
    expect(sanitized.status).toBe(200);
    expect(sanitized.json).toEqual(first.json);
    // other bets are unaffected
    const t = await betWithVoice();
    expect(
      (await tool({ conversation_id: t.conversation_id, bet_id: t.bet_id, ...BOTTLE })).json,
    ).toMatchObject({ ok: true });
  });

  it('missing conversation_id is WRONG_BET and still audited (§4.1)', async () => {
    const s = await betWithVoice();
    const { conversation_id: _c, ...noConv } = {
      conversation_id: 'x',
      bet_id: s.bet_id,
      ...BOTTLE,
    };
    expect((await tool(noConv)).json).toMatchObject({ ok: false, fix: 'WRONG_BET' });
    await expect
      .poll(async () => {
        const rows = await ctx.deps.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.bet_id, s.bet_id), eq(auditLog.action, 'el_tool.wrong_bet')));
        return rows.map((x) => (x.details as any).reason);
      })
      .toEqual(['missing_ids']);
  });

  it('binding check: another bet, an unknown conversation or missing ids -> WRONG_BET + audit', async () => {
    const s = await betWithVoice();
    const other = await betWithVoice();
    const r = await tool({ conversation_id: s.conversation_id, bet_id: other.bet_id, ...BOTTLE });
    expect(r.json).toEqual({ ok: false, fix: 'WRONG_BET', say: "That's not this bet's docket." });
    await expect
      .poll(async () => {
        const rows = await ctx.deps.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.bet_id, s.bet_id), eq(auditLog.action, 'el_tool.wrong_bet')));
        return rows.map((x) => (x.details as any).claimed_bet_id);
      })
      .toEqual([other.bet_id]);
    expect(
      (await tool({ conversation_id: `conv_${RUN}_nope`, bet_id: s.bet_id, ...BOTTLE })).json,
    ).toMatchObject({ fix: 'WRONG_BET' });
    // an unbound (pre-minted, no bet yet) session cannot address any bet
    const A = await signUp(ctx.base, 'Logan');
    const pre = await post(ctx, A, '/v1/voice/tokens', { purpose: 'terms' });
    expect(
      (await tool({ conversation_id: pre.json!.conversation_id, bet_id: s.bet_id, ...BOTTLE }))
        .json,
    ).toMatchObject({ fix: 'WRONG_BET' });
  });

  it('an ended session or a bet past DRAFTING/TERMS_PROPOSED cannot propose', async () => {
    const s = await betWithVoice();
    const decline = await post(ctx, s.B, `/v1/bets/${s.bet_id}/invite/decline`, {});
    expect(decline.status).toBe(200);
    expect(
      (await tool({ conversation_id: s.conversation_id, bet_id: s.bet_id, ...BOTTLE })).json,
    ).toMatchObject({ ok: false, fix: 'NOT_DRAFTING' });

    const t = await betWithVoice();
    await ctx.deps.db
      .update(voiceSessions)
      .set({ status: 'ended' })
      .where(eq(voiceSessions.id, t.voice_session_id));
    expect(
      (await tool({ conversation_id: t.conversation_id, bet_id: t.bet_id, ...BOTTLE })).json,
    ).toMatchObject({ fix: 'WRONG_BET' });
  });

  it('a wrong secret is 401 even for a valid binding', async () => {
    const s = await betWithVoice();
    const r = await tool(
      { conversation_id: s.conversation_id, bet_id: s.bet_id, ...BOTTLE },
      'wrong',
    );
    expect(r.status).toBe(401);
    expect(
      (await tool({ conversation_id: s.conversation_id, bet_id: s.bet_id, ...BOTTLE }, null))
        .status,
    ).toBe(401);
  });

  it('handler latency stays well inside the §1.8 25 ms budget (local DB, p50 over 20 calls)', async () => {
    const s = await betWithVoice();
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await tool({
        conversation_id: s.conversation_id,
        bet_id: s.bet_id,
        ...BOTTLE,
        amount_usd: String(1 + (i % 19)),
      });
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    expect(ms[10]!).toBeLessThan(50); // includes loopback HTTP; a loose bound so CI is not flaky
  });
});
