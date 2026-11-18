/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// Demo-day safety valves and the head-to-head record, over HTTP + Postgres + LiteSVM running the
// real escrow.so (the custodial LOCK_SIGNER=server demo):
//   - POST/GET /v1/demo/toggles: cached_ruling at runtime, audited, in /v1/demo/health
//   - POST /v1/demo/warmup: the judge (mock LLM, the real prompt + schema + stored JPEG), the
//     RPC (LiteSVM getLatestBlockhash), the Gemini relay (the REPLAY feed), voice readiness; no
//     network, no bet, no money; one per 10 s
//   - judge stats in /v1/demo/health (judge_llm, llm_last_ok, judge_no_success / judge_failing)
//   - POST /v1/demo/seed-h2h: 4-7 is_seed history the face-match reply reads, kept by demo reset
//     (a real locked rehearsal bet is refunded and deleted next to it), replaced on re-seed
//   - GET /v1/users/:user_id/head-to-head: auth and counts
// The toggle flipping a real ruling with no restart is in e2e-beats.test.ts (its judge-cam path).
//
// This suite runs in its OWN database (<DATABASE_URL db>_valves): it owns nonce_pool and calls
// POST /v1/demo/reset (which deletes every non-seed bet). Skips without DATABASE_URL or escrow.so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { auditLog, bets, chainTxs, noncePool } from '@youre-on/db';
import { HeadToHead, type Session } from '@youre-on/shared/api';
import { ESCROW_PROGRAM_ADDRESS, findBetPda } from '@youre-on/shared/escrow-client';
import { embeddingToBytes, FACE_MODEL_W600K, FACE_CONSENT_V1_SHA256 } from '@youre-on/shared/face';
import { betIdToBytes } from '@youre-on/shared/primitives';
import {
  createPoolNonce,
  HAVE_SO,
  newEnv,
  send,
  setNow,
  USDC,
  type Env as SvmEnv,
} from '../../../packages/shared/test/escrow/harness';
import type { ChainRuntime } from '../src/chain/tx';
import { createLogger } from '../src/log';
import { createGeminiClient } from '../src/markets/gemini';
import { createReplayClient, createRoutedClient } from '../src/markets/replay';
import { MarketService } from '../src/markets/service';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { JUDGE_SYSTEM_PROMPT } from '../src/judge/prompt';
import { warmupFrame } from '../src/demo/warmup';
import { seedWinners } from '../src/demo/seed-h2h';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import type { ChatRequest } from '../src/providers/types';
import { liteSvmClient } from './litesvm-client';
import {
  DB_URL,
  getChallenge,
  newKey,
  ownDatabase,
  postJson,
  signedHeaders,
  signupBody,
  startTestServer,
  type Ctx,
  type SignedUp,
  type TestKey,
} from './helpers';

const run = DB_URL && HAVE_SO ? describe : describe.skip;
const ADMIN = 'demo-admin-token-for-valves';
const STAGE_KEY = 'stage-key-for-valves';
const DIM = 512;

/** e_i: a synthetic "face" whose cosines we control exactly (as face.test.ts). */
const basis = (i: number) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};
const probeNear = (i: number, c: number) => {
  const v = new Float32Array(DIM);
  v[i] = c;
  v[500] = Math.sqrt(1 - c * c);
  return v;
};
const sealed = (v: Float32Array) => ({
  alg: 'plain-v0' as const,
  epk_b64: null,
  nonce_b64: null,
  ct_b64: Buffer.from(embeddingToBytes(v)).toString('base64'),
});

describe('seedWinners (pure)', () => {
  it('4-7 is the DATA-MODEL §11 pattern (bets 2, 5, 7, 10); others spread evenly', () => {
    const w = seedWinners(4, 7);
    expect(w.map((x, i) => (x ? i + 1 : 0)).filter(Boolean)).toEqual([2, 5, 7, 10]);
    for (const [a, b] of [
      [2, 1],
      [0, 3],
      [5, 0],
      [7, 4],
      [0, 0],
    ] as const) {
      const r = seedWinners(a, b);
      expect(r).toHaveLength(a + b);
      expect(r.filter(Boolean)).toHaveLength(a);
    }
  });
});

run('demo valves: toggles, warmup, judge health, seeded head-to-head (HTTP + LiteSVM)', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let lc: Lifecycle;
  let offset = 0;
  const now = () => Date.now() + offset;
  let keyA: TestKey;
  let keyB: TestKey;
  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;
  let A: SignedUp | undefined;
  let B: SignedUp | undefined;
  let C: SignedUp;
  let markets: MarketService;
  let llm: MockLlm;
  let reply: (req: ChatRequest<unknown>) => MockReply | null = () => null;

  const install = () => {
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => rt,
        signer: 'server',
        send: { pollMs: 5, resendMs: 50, timeoutMs: 2_000 },
        timers: false,
      }),
    );
  };
  /** Past the warm-up bucket (the limiter runs on the server clock). */
  const pastWarmupWindow = () => {
    offset += 10_001;
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
  };

  const ata = async (s: KeyPairSigner) =>
    (
      await findAssociatedTokenPda({
        owner: s.address,
        mint: svm.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
    )[0];
  async function mint(owner: KeyPairSigner, amount: bigint) {
    await send(svm.svm, svm.s, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: svm.s,
        owner: owner.address,
        mint: svm.mint,
      }),
      getMintToCheckedInstruction({
        mint: svm.mint,
        token: await ata(owner),
        mintAuthority: svm.s,
        amount,
        decimals: 6,
      }),
    ]);
  }

  beforeAll(async () => {
    const dbUrl = await ownDatabase(DB_URL!, 'valves');
    const log = createLogger('silent');
    markets = new MarketService({
      // The REPLAY feed (a recorded real round on the current window); the live client would
      // fail: no network in this suite.
      client: createRoutedClient({
        live: createGeminiClient({
          fetch: (async () => {
            throw new TypeError('no network in tests');
          }) as typeof fetch,
        }),
        replay: createReplayClient({ now }),
        mode: 'replay',
      }),
      now,
      log,
    });
    ctx = await startTestServer({
      now,
      markets,
      env: {
        DATABASE_URL: dbUrl,
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
        STAGE_KEY,
        CACHED_RULING: 'false',
      },
    });
    // The default reply: a valid JudgeVerdict (what a 16 px still deserves).
    llm = new MockLlm(
      (req) =>
        reply(req) ?? {
          value: {
            claim_result: 'UNCLEAR',
            confidence: 0.4,
            reason: 'A 16 pixel still: nothing to judge.',
            cited_frames: [],
            contested: false,
            checks: { cap_tape_visible: null, bottle_upright_at_rest: null },
          },
        },
    );
    ctx.deps.providers.llm = llm;
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    keyA = newKey();
    keyB = newKey();
    signerA = await createKeyPairSignerFromPrivateKeyBytes(keyA.secret);
    signerB = await createKeyPairSignerFromPrivateKeyBytes(keyB.secret);
    await mint(signerA, 50n * USDC);
    await mint(signerB, 50n * USDC);
    for (const k of [0, 1, 2]) await createPoolNonce(svm, k);
    rt = {
      client: liteSvmClient(svm.svm),
      keys: {
        feePayer: svm.s,
        judge: svm.judge,
        appeal: svm.appeal,
        treasury: null,
        // demo-a / demo-b: the wallets A and B sign up with (decision D-A).
        demoA: signerA,
        demoB: signerB,
      },
      mint: svm.mint,
      programId: ESCROW_PROGRAM_ADDRESS,
      cluster: 'localnet',
    };
    // This database is ours alone: no leftovers from an earlier run of this suite.
    await ctx.deps.db.delete(noncePool);
    await ctx.deps.db.delete(bets);
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    install();
    C = await signUpWith('Carol', newKey());
  }, 60_000);

  afterAll(async () => {
    await lc?.idle();
    lc?.stop();
    await ctx?.server.close();
  });

  async function signUpWith(name: string, wallet: TestKey): Promise<SignedUp> {
    const device = newKey();
    const ch = await getChallenge(ctx.base, device);
    const r = await postJson(
      ctx.base,
      '/v1/auth/signup',
      signupBody(ch, device, wallet, { display_name: name }),
    );
    if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.json)}`);
    return { device, wallet, session: r.json as unknown as Session };
  }
  /** demo-a (Logan) and demo-b (Jake): signed up with the runtime's custodial demo wallets. */
  async function players(): Promise<[SignedUp, SignedUp]> {
    A ??= await signUpWith('Logan', keyA);
    B ??= await signUpWith('Jake', keyB);
    return [A, B];
  }
  const uid = (u: SignedUp) => u.session.user.user_id;

  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw, { ts: now() }),
      ...(method === 'GET' ? {} : { body: raw }),
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(ctx.base + path, { headers });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: text ? (JSON.parse(text) as Record<string, any>) : null,
    };
  };
  const bearer = (u: SignedUp) => ({ Authorization: `Bearer ${u.session.token}` });
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });
  const health = async () => (await get('/v1/demo/health', { 'X-YO-Demo-Key': ADMIN })).json!;
  const audits = (action: string) =>
    ctx.deps.db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .orderBy(auditLog.id);
  const seedRows = () =>
    ctx.deps.db
      .select()
      .from(bets)
      .where(sql`${bets.is_seed}`);

  // ---- gating ------------------------------------------------------------------------------

  it('every new /v1/demo route is 404 without the admin key', async () => {
    for (const [method, path] of [
      ['GET', '/v1/demo/toggles'],
      ['POST', '/v1/demo/toggles'],
      ['POST', '/v1/demo/warmup'],
      ['POST', '/v1/demo/seed-h2h'],
    ] as const) {
      for (const headers of [{}, { 'X-YO-Demo-Key': 'wrong' }]) {
        const res = await fetch(ctx.base + path, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(method === 'POST' ? { body: '{"cached_ruling": true}' } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    // nothing was toggled, warmed or seeded
    expect(llm.calls).toHaveLength(0);
    expect((await health()).toggles).toMatchObject({ cached_ruling: false });
  });

  // ---- toggles -----------------------------------------------------------------------------

  it('toggles: env default, runtime flip (audited, in /v1/demo/health), strict body, null = env again', async () => {
    const g = await get('/v1/demo/toggles', { 'X-YO-Demo-Key': ADMIN });
    expect(g.status).toBe(200);
    expect(g.json).toEqual({
      cached_ruling: false,
      cached_ruling_source: 'env',
      cached_ruling_env: false,
      checks: true,
      checks_source: 'env',
      checks_env: false,
      updated_at: null,
    });
    const audits0 = (await audits('demo.toggle')).length;

    const on = await admin('/v1/demo/toggles', { cached_ruling: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({
      ok: true,
      toggles: { cached_ruling: true, cached_ruling_source: 'runtime', cached_ruling_env: false },
      changed: [{ toggle: 'cached_ruling', from: false, to: true, source: 'runtime' }],
    });
    const h = await health();
    expect(h.toggles).toMatchObject({ cached_ruling: true, cached_ruling_source: 'runtime' });
    expect(h.judge_llm).toMatchObject({ cached_ruling: true });
    expect(h.warnings).toContainEqual(
      expect.objectContaining({ code: 'cached_ruling_on', level: 'warn' }),
    );
    // a fallback is a warning, never critical
    expect(
      h.warnings.filter((w: any) => w.level === 'critical').map((w: any) => w.code),
    ).not.toContain('cached_ruling_on');

    // A typo is refused, not silently ignored (the fallback would stay off).
    const typo = await admin('/v1/demo/toggles', { cached: true });
    expect(typo.status).toBe(422);
    expect((await admin('/v1/demo/toggles', { cached_ruling: 'yes' })).status).toBe(422);

    const off = await admin('/v1/demo/toggles', { cached_ruling: false });
    expect(off.json!.toggles).toMatchObject({
      cached_ruling: false,
      cached_ruling_source: 'runtime',
    });
    // env CACHED_RULING is read at call time while no runtime value is set (null).
    (ctx.deps.env as { CACHED_RULING: boolean }).CACHED_RULING = true;
    try {
      expect((await admin('/v1/demo/toggles', {})).json!.toggles.cached_ruling).toBe(false);
      const back = await admin('/v1/demo/toggles', { cached_ruling: null });
      expect(back.json).toMatchObject({
        toggles: { cached_ruling: true, cached_ruling_source: 'env', cached_ruling_env: true },
        changed: [{ toggle: 'cached_ruling', from: false, to: true, source: 'env' }],
      });
    } finally {
      (ctx.deps.env as { CACHED_RULING: boolean }).CACHED_RULING = false;
    }
    expect((await health()).toggles).toMatchObject({
      cached_ruling: false,
      cached_ruling_source: 'env',
    });

    // Every named toggle is audited, with what it was and what it became.
    const rows = (await audits('demo.toggle')).slice(audits0);
    expect(rows.map((r) => r.details)).toEqual([
      expect.objectContaining({ toggle: 'cached_ruling', from: false, to: true }),
      expect.objectContaining({ toggle: 'cached_ruling', from: true, to: false }),
      expect.objectContaining({ toggle: 'cached_ruling', from: false, to: true, source: 'env' }),
    ]);
  });

  // ---- judge health + warmup ---------------------------------------------------------------

  it('health: no judge success since boot is a WARN (judge_no_success), not critical', async () => {
    const h = await health();
    expect(h.judge_llm).toMatchObject({
      provider: 'mock',
      model: 'claude-sonnet-5-5',
      calls: 0,
      failures: 0,
      last_ok_at: null,
      last_error_at: null,
      p50_ms: null,
      p95_ms: null,
    });
    expect(h.llm_last_ok).toBeNull();
    expect(h.warnings).toContainEqual(
      expect.objectContaining({ code: 'judge_no_success', level: 'warn' }),
    );
  });

  it('warmup (mocked providers, no network): per-check ok/ms/error, the real judge call, notes', async () => {
    const calls0 = llm.calls.length;
    const audits0 = (await audits('demo.warmup')).length;
    const r = await admin('/v1/demo/warmup');
    expect(r.status).toBe(200);
    const w = r.json!;
    expect(w.modes).toMatchObject({
      llm: 'mock',
      judge_model: 'claude-sonnet-5-5',
      cached_ruling: false,
      markets_feed: 'replay',
      lock_signer: 'phones',
    });
    for (const k of ['judge', 'rpc', 'gemini', 'voice'])
      expect(w.checks[k], k).toEqual(
        expect.objectContaining({ ok: expect.any(Boolean), ms: expect.any(Number) }),
      );

    // judge: ONE call through the provider with the real prompt, schema and the stored JPEG.
    expect(w.checks.judge).toMatchObject({
      ok: true,
      error: null,
      provider: 'mock',
      model: 'anthropic/mock/claude-sonnet-5-5',
      claim_result: 'UNCLEAR',
    });
    expect(llm.calls.length - calls0).toBe(1);
    const call = llm.calls.at(-1)! as ChatRequest<unknown>;
    expect(call).toMatchObject({
      vendor: 'anthropic',
      model: 'claude-sonnet-5-5',
      system: JUDGE_SYSTEM_PROMPT,
      output: { name: 'attempt_verdict' },
    });
    const images = call.parts.filter((p) => p.kind === 'image');
    expect(images).toHaveLength(1);
    const jpeg = (images[0] as { data: Uint8Array }).data;
    expect(Buffer.from(jpeg).equals(Buffer.from(warmupFrame()))).toBe(true);
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    // rpc: LiteSVM's blockhash through the server's chain client.
    expect(w.checks.rpc).toMatchObject({ ok: true, error: null });
    expect(w.checks.rpc.blockhash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // gemini: the relay's current contract, on the REPLAY feed (and the note says so).
    expect(w.checks.gemini).toMatchObject({ ok: true, error: null, feed_mode: 'replay' });
    expect(w.checks.gemini.current.event_ticker).toMatch(/^REPLAY-BTC05M/);
    // voice: config only (no ElevenLabs call); nothing is set here.
    expect(w.checks.voice).toMatchObject({ ok: false, judge_ready: false });
    expect(w.checks.voice.error).toMatch(/ELEVENLABS_API_KEY/);
    expect(w.ok).toBe(false); // voice is not ready
    expect(w.notes.join(' ')).toMatch(/LLM_PROVIDER=mock/);
    expect(w.notes.join(' ')).toMatch(/REPLAY feed/);

    // Nothing was bet, nothing moved; the warm-up is audited.
    expect(await ctx.deps.db.select({ id: bets.id }).from(bets)).toEqual([]);
    expect(await ctx.deps.db.select({ id: chainTxs.id }).from(chainTxs)).toEqual([]);
    expect((await audits('demo.warmup')).slice(audits0)).toEqual([
      {
        details: expect.objectContaining({
          ok: false,
          llm: 'mock',
          judge: expect.objectContaining({ ok: true }),
        }),
      },
    ]);

    // The judge stats now show the success (source warmup) and clear the warning.
    const h = await health();
    expect(h.judge_llm).toMatchObject({
      calls: 1,
      failures: 0,
      last_ok_source: 'warmup',
      last_ok_model: 'anthropic/mock/claude-sonnet-5-5',
      window: 1,
    });
    expect(h.judge_llm.last_ok_at).toEqual(expect.any(String));
    expect(h.judge_llm.p50_ms).toEqual(expect.any(Number));
    expect(h.llm_last_ok).toBe(h.judge_llm.last_ok_at);
    expect(h.warnings.map((x: any) => x.code)).not.toContain('judge_no_success');
  });

  it('warmup is rate limited: a second one within 10 s is 429 with Retry-After, no LLM call', async () => {
    const calls0 = llm.calls.length;
    const again = await admin('/v1/demo/warmup');
    expect(again.status).toBe(429);
    expect(again.json!.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { bucket: 'demo/warmup' },
    });
    expect(Number(again.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(llm.calls.length).toBe(calls0);
    pastWarmupWindow();
    expect((await admin('/v1/demo/warmup')).status).toBe(200);
    expect(llm.calls.length).toBe(calls0 + 1);
  });

  it('a failing judge: the warm-up says why, stats count it, health warns judge_failing; cached_ruling noted', async () => {
    pastWarmupWindow();
    await admin('/v1/demo/toggles', { cached_ruling: true });
    reply = () => ({ fail: 'timeout', message: 'judge took too long' });
    try {
      const w = (await admin('/v1/demo/warmup')).json!;
      // The warm-up tests the live judge even while bets get the cached ruling.
      expect(w.modes.cached_ruling).toBe(true);
      expect(w.checks.judge).toMatchObject({ ok: false, claim_result: null });
      expect(w.checks.judge.error).toMatch(/^timeout: judge took too long/);
      expect(w.notes.join(' ')).toMatch(/cached_ruling is on/);
      const h = await health();
      expect(h.judge_llm).toMatchObject({
        failures: 1,
        last_error_source: 'warmup',
      });
      expect(h.judge_llm.last_error).toMatch(/^timeout: judge took too long/);
      expect(h.warnings).toContainEqual(
        expect.objectContaining({ code: 'judge_failing', level: 'warn' }),
      );
    } finally {
      reply = () => null;
      await admin('/v1/demo/toggles', { cached_ruling: null });
    }
    pastWarmupWindow();
    expect((await admin('/v1/demo/warmup')).json!.checks.judge.ok).toBe(true);
    expect((await health()).warnings.map((x: any) => x.code)).not.toContain('judge_failing');
  });

  // ---- seed-h2h ----------------------------------------------------------------------------

  it('seed-h2h: 409 demo_player_missing until the demo wallets have accounts', async () => {
    expect(A).toBeUndefined();
    const r = await admin('/v1/demo/seed-h2h');
    expect(r.status).toBe(409);
    expect(r.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'demo_player_missing', party: 'a' },
    });
    expect(await seedRows()).toEqual([]);
  });

  it('seed-h2h: 4-7 is_seed history that passes every CHECK; the face-match reply reads 4-7', async () => {
    const [a, b] = await players();
    const r = await admin('/v1/demo/seed-h2h');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      a: { user_id: uid(a), display_name: 'Logan', wallet: keyA.pubkey },
      b: { user_id: uid(b), display_name: 'Jake', wallet: keyB.pubkey },
      a_wins: 4,
      b_wins: 7,
      replaced: 0,
      inserted: 11,
      head_to_head: {
        a_vs_b: { wins: 4, losses: 7, pushes: 0, net: '-7000000', includes_seed: true },
        b_vs_a: { wins: 7, losses: 4, pushes: 0, net: '7000000', includes_seed: true },
      },
    });
    // Rivalry fields: in the default pattern Jake took the last bet (Logan won 2, 5, 7, 10).
    expect((r.json as any).head_to_head.a_vs_b).toMatchObject({
      total: 11,
      last_result: 'loss',
      streak: { holder: 'them', length: 1 },
      rival: true,
    });
    expect((r.json as any).head_to_head.b_vs_a).toMatchObject({
      total: 11,
      last_result: 'win',
      streak: { holder: 'me', length: 1 },
      rival: true,
    });
    const rows = await seedRows();
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row).toMatchObject({
        is_seed: true,
        state: 'PAID',
        onchain_status: 'settled',
        evidence_source: 'camera',
        room_id: null,
        payout_sig: null,
        accept_sig: null,
        onchain_pending: null,
      });
      expect(row.title).toMatch(/^Demo history: /);
      expect(row.settled_at!.getTime()).toBeLessThan(now());
      expect(row.created_at.getTime()).toBeLessThan(row.settled_at!.getTime());
      expect([uid(a), uid(b)].sort()).toEqual([row.party_a_id, row.party_b_id].sort());
    }
    // both directions of challenger
    expect(new Set(rows.map((x) => x.party_a_id)).size).toBe(2);
    // no chain footprint
    const ids = rows.map((x) => x.id);
    expect(
      await ctx.deps.db
        .select({ id: chainTxs.id })
        .from(chainTxs)
        .where(inArray(chainTxs.bet_id, ids)),
    ).toEqual([]);
    // bets_guard: a seed row can still be touched (no frozen field moves, the state is final).
    await ctx.deps.db
      .update(bets)
      .set({ title: sql`${bets.title}` })
      .where(sql`${bets.is_seed}`);
    // ...and its terminal state is final, like any bet's.
    await expect(
      ctx.deps.db.update(bets).set({ state: 'RULED' }).where(eq(bets.id, rows[0]!.id)),
    ).rejects.toThrow();
    expect((await audits('demo.seed_h2h')).at(-1)!.details).toMatchObject({
      a_wins: 4,
      b_wins: 7,
      inserted: 11,
      replaced: 0,
    });

    // The face-match reply on A's phone: "You're 4-7 against Jake".
    const room = await signed(a, 'POST', '/v1/rooms', { name: 'UBC stage', kind: 'session' });
    expect(room.status).toBe(201);
    expect((await signed(b, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const enrolled = await signed(b, 'POST', '/v1/face/enrollment', {
      consent: {
        consent_version: 'face-consent-v1',
        consent_text_sha256: FACE_CONSENT_V1_SHA256,
        consent_at: new Date(now() - 30_000).toISOString(),
      },
      liveness: { method: 'head_turn', passed_at: new Date(now() - 5_000).toISOString() },
      model: FACE_MODEL_W600K,
      embedding: sealed(basis(40)),
      shots: 3,
    });
    expect(enrolled.status).toBe(201);
    const m = await signed(a, 'POST', `/v1/rooms/${room.json!.room_id}/face-match`, {
      probe: sealed(probeNear(40, 0.7)),
      model: FACE_MODEL_W600K,
      capture: { captured_at: new Date(now()).toISOString(), eye_distance_px: 90, yaw_deg: 2 },
    });
    expect(m.status).toBe(200);
    expect(m.json!.match.user.user_id).toBe(uid(b));
    expect(m.json!.match.head_to_head).toMatchObject({
      wins: 4,
      losses: 7,
      pushes: 0,
      net: '-7000000',
      includes_seed: true,
    });
    expect(`${m.json!.match.head_to_head.wins}-${m.json!.match.head_to_head.losses}`).toBe('4-7');

    // The phones' history lists them, flagged is_seed (API-CONTRACT §2.14 BetSummary), and
    // labelled by their own title: a seed row has no terms envelope to take one from.
    const hist = await get('/v1/me/bets?status=settled&limit=20', bearer(a));
    expect(hist.status).toBe(200);
    const seeded = hist.json!.items.filter((x: any) => x.is_seed);
    expect(seeded).toHaveLength(11);
    for (const x of seeded) expect(x.title).toMatch(/^Demo history: /);
  });

  it('demo reset keeps the seed rows (and the 4-7) while it refunds and deletes a rehearsal bet', async () => {
    const [a, b] = await players();
    const seeds0 = (await seedRows()).map((x) => x.id).sort();
    // A real custodial rehearsal bet between the same pair, LOCKED on chain.
    const room = await signed(a, 'POST', '/v1/rooms', { name: 'Rehearsal', kind: 'session' });
    expect((await signed(b, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const bet = await signed(a, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: uid(b),
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    expect((await signed(b, 'POST', `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
    expect((await admin(`/v1/demo/bets/${betId}/terms`)).json).toMatchObject({ ok: true });
    expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle();
    const [locked] = await ctx.deps.db.select().from(bets).where(eq(bets.id, betId));
    expect(locked!.state).toBe('LOCKED');
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    expect(svm.svm.getAccount(pda).exists).toBe(true);

    const reset = await admin('/v1/demo/reset');
    expect(reset.status).toBe(200);
    expect(reset.json!.deleted_bets).toBeGreaterThanOrEqual(1);
    expect(reset.json!.escrow.actions).toContainEqual(
      expect.objectContaining({ bet_id: betId, action: 'resolve_refund' }),
    );
    expect(await ctx.deps.db.select().from(bets).where(eq(bets.id, betId))).toEqual([]);
    expect((await seedRows()).map((x) => x.id).sort()).toEqual(seeds0);
    const h2h = await get(`/v1/users/${uid(b)}/head-to-head`, bearer(a));
    expect(h2h.json).toMatchObject({ wins: 4, losses: 7, includes_seed: true });
  });

  it('re-seed replaces the old seed rows (no duplicates); {0, 0} clears them', async () => {
    const [a, b] = await players();
    const old = new Set((await seedRows()).map((x) => x.id));
    const r = await admin('/v1/demo/seed-h2h', { a_wins: 2, b_wins: 1 });
    expect(r.json).toMatchObject({
      a_wins: 2,
      b_wins: 1,
      replaced: 11,
      inserted: 3,
      head_to_head: { a_vs_b: { wins: 2, losses: 1 } },
    });
    const rows = await seedRows();
    expect(rows).toHaveLength(3);
    for (const x of rows) expect(old.has(x.id)).toBe(false);
    // the same request twice is the same record, not double
    await admin('/v1/demo/seed-h2h', { a_wins: 2, b_wins: 1 });
    expect(await seedRows()).toHaveLength(3);
    expect((await get(`/v1/users/${uid(b)}/head-to-head`, bearer(a))).json).toMatchObject({
      wins: 2,
      losses: 1,
    });
    expect((await admin('/v1/demo/seed-h2h', { a_wins: 31 })).status).toBe(422);
    expect((await admin('/v1/demo/seed-h2h', { a_wins: -1 })).status).toBe(422);

    const cleared = await admin('/v1/demo/seed-h2h', { a_wins: 0, b_wins: 0 });
    expect(cleared.json).toMatchObject({ replaced: 3, inserted: 0 });
    expect(await seedRows()).toEqual([]);
    expect((await get(`/v1/users/${uid(b)}/head-to-head`, bearer(a))).json).toMatchObject({
      wins: 0,
      losses: 0,
      pushes: 0,
      net: '0',
      includes_seed: false,
    });
    // back to the demo's 4-7 for the route tests below
    expect((await admin('/v1/demo/seed-h2h')).json).toMatchObject({ inserted: 11, replaced: 0 });
  });

  // ---- GET /v1/users/:user_id/head-to-head ---------------------------------------------------

  it('GET /v1/users/:user_id/head-to-head: a phone session; the caller is user_a; 404s', async () => {
    const [a, b] = await players();
    const path = (u: string) => `/v1/users/${u}/head-to-head`;

    const ab = await get(path(uid(b)), bearer(a));
    expect(ab.status).toBe(200);
    expect(HeadToHead.parse(ab.json)).toEqual(ab.json);
    expect(ab.json).toMatchObject({
      wins: 4,
      losses: 7,
      pushes: 0,
      net: '-7000000',
      includes_seed: true,
      total: 11,
      last_result: 'loss',
      streak: { holder: 'them', length: 1 },
      rival: true,
    });
    expect(ab.json!.last_settled_at).toEqual(expect.any(String));
    expect(ab.headers.get('cache-control')).toMatch(/no-store/);
    expect((await get(path(uid(a)), bearer(b))).json).toMatchObject({ wins: 7, losses: 4 });

    // Only the caller's own record: a stranger sees 0-0-0 against either of them.
    for (const u of [a, b])
      expect((await get(path(uid(u)), bearer(C))).json).toEqual({
        wins: 0,
        losses: 0,
        pushes: 0,
        net: '0',
        net_display: '$0',
        last_settled_at: null,
        includes_seed: false,
        total: 0,
        last_result: null,
        streak: null,
        rival: false,
      });
    expect((await get(path(uid(a)), bearer(a))).json).toMatchObject({ wins: 0, losses: 0 });

    // auth: a bearer of a phone session
    const none = await get(path(uid(b)));
    expect(none.status).toBe(401);
    expect(none.json!.error.code).toBe('AUTH_REQUIRED');
    expect((await get(path(uid(b)), { Authorization: 'Bearer nope' })).status).toBe(401);
    const st = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_id: (await signed(a, 'POST', '/v1/rooms', { name: 'Stage', kind: 'session' })).json!
        .room_id,
    });
    expect(st.status).toBe(201);
    const stage = await get(path(uid(b)), { Authorization: `Bearer ${st.json!.token}` });
    expect(stage.status).toBe(401);
    // the admin key is not a session either
    expect((await get(path(uid(b)), { 'X-YO-Demo-Key': ADMIN })).status).toBe(401);

    // 404 for a malformed or unknown id
    expect((await get(path('not-a-uuid'), bearer(a))).status).toBe(404);
    const unknown = await get(path('00000000-0000-4000-8000-00000000dead'), bearer(a));
    expect(unknown.status).toBe(404);
    expect(unknown.json!.error.code).toBe('NOT_FOUND');
  });

  it('the seeded pair can still bet live (seeds are terminal: no pair_busy)', async () => {
    const [a, b] = await players();
    const room = await signed(a, 'POST', '/v1/rooms', { name: 'Live', kind: 'session' });
    expect((await signed(b, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const bet = await signed(a, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: uid(b),
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    // the rows the reset keeps are exactly the seed rows
    await admin('/v1/demo/reset');
    const left = await ctx.deps.db
      .select({ seed: bets.is_seed, n: sql<number>`count(*)::int` })
      .from(bets)
      .groupBy(bets.is_seed);
    expect(left).toEqual([{ seed: true, n: 11 }]);
    expect(
      await ctx.deps.db
        .select({ id: bets.id })
        .from(bets)
        .where(and(eq(bets.is_seed, false))),
    ).toEqual([]);
  });
});
