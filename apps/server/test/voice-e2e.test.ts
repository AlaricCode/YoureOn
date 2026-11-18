/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// Beat 2 -> 3 by VOICE, end to end, the way ElevenLabs will drive it once the key is live:
//
//   A mints a conversation (POST /v1/voice/tokens: the real ElevenLabs client over a fake
//   api.elevenlabs.io) -> POST /v1/bets binds it -> the agent's webhook tools, with the tool
//   secret header, exactly as ElevenLabs sends them:
//     POST /el/tools/propose_terms   incomplete -> terms.draft (DRAFTING); complete -> terms.proposed
//                                    (TERMS_PROPOSED); a refusal category -> terms.refused + CANCELLED
//     POST /el/tools/confirm_terms   -> AWAITING_AUTHORIZATIONS -> LOCKED (LOCK_SIGNER=server: the
//                                    custodial demo keys sign; LiteSVM runs the real escrow.so)
//   plus the tool auth (bad / missing secret), the 10 s replay, the conversation -> bet binding,
//   B's invite accept as the consent gate, and POST /v1/voice/tokens with and without keys (a
//   clean UPSTREAM_* code, never a 500).
//
// No paid call: ElevenLabs is a fake fetch, the chain is LiteSVM. Runs in its own database
// (<DATABASE_URL db>_voice): the lock service leases from nonce_pool, which lifecycle.test.ts
// owns in the shared one. Skips without DATABASE_URL or without programs/escrow/target/deploy/escrow.so.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  auditLog,
  betEvents,
  betTermsVersions,
  bets,
  noncePool,
  voiceSessions,
} from '@youre-on/db';
import type { Session } from '@youre-on/shared/api';
import {
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  findBetPda,
  getBetDecoder,
} from '@youre-on/shared/escrow-client';
import { REFUSAL_QUIPS } from '@youre-on/shared/judge/guardrails';
import type { SpokenBetFixture } from '@youre-on/shared/judge/fixture-schema';
import { TOOL_REPLY_MAX_BYTES } from '@youre-on/shared/judge/reply';
import { VoiceTokenResponse } from '@youre-on/shared/judge/voice';
import { betIdToBytes } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import {
  createPoolNonce,
  HAVE_SO,
  newEnv,
  send,
  setNow,
  tokenAmount,
  USDC,
  type Env as SvmEnv,
} from '../../../packages/shared/test/escrow/harness';
import type { ChainRuntime } from '../src/chain/tx';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { routeModules } from '../src/routes';
import { createElevenLabsClient, type FetchLike } from '../src/voice/elevenlabs';
import { createVoiceRoutes } from '../src/voice/routes';
import { TOOL_DEDUPE_WINDOW_MS } from '../src/voice/tools';
import { liteSvmClient } from './litesvm-client';
import {
  connectWs,
  DB_URL,
  getChallenge,
  newKey,
  postJson,
  signedHeaders,
  signupBody,
  startTestServer,
  type Ctx,
  type SignedUp,
  type TestKey,
  type WsClient,
} from './helpers';
import { ownDatabase } from './own-db';

const run = DB_URL && HAVE_SO ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (id: string): SpokenBetFixture =>
  JSON.parse(
    readFileSync(join(here, '../../../packages/shared/src/judge/fixtures', `${id}.json`), 'utf8'),
  ) as SpokenBetFixture;
const BOTTLE = fixture('01-bottle-flip').sample_args as Record<string, unknown>;
const REFUSALS = ['09-roof-jump', '10-chug', '11-self-punch', '12-little-brother'].map((id) => {
  const f = fixture(id);
  return { id, category: f.refusal_category!, args: f.sample_args as Record<string, unknown> };
});

const SECRET = `tool-secret-${randomUUID()}`;
const AGENT = 'agent_e2e_judge';
const XI_KEY = 'xi-e2e-not-a-real-key';

/**
 * A fake api.elevenlabs.io behind the REAL server client (createElevenLabsClient): it records
 * every request and answers the conversation-token call the way the live OpenAPI documents it
 * (TokenResponseModel {token, conversation_id}), or fails the way `mode` says.
 */
type ElMode = 'ok' | 'http_401' | 'not_json' | 'bad_shape' | 'network' | 'timeout';
const fakeEl = {
  mode: 'ok' as ElMode,
  requests: [] as Array<{ url: string; method: string; key: string | null }>,
  n: 0,
};
const elFetch: FetchLike = async (input, init) => {
  const headers = new Headers(init?.headers);
  fakeEl.requests.push({
    url: input,
    method: init?.method ?? 'GET',
    key: headers.get('xi-api-key'),
  });
  switch (fakeEl.mode) {
    case 'network':
      throw new TypeError('fetch failed');
    case 'timeout':
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    case 'http_401':
      return new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), {
        status: 401,
      });
    case 'not_json':
      return new Response('<html>gateway</html>', { status: 200 });
    case 'bad_shape':
      return new Response(JSON.stringify({ token: 'tok_only' }), { status: 200 });
    case 'ok': {
      fakeEl.n += 1;
      const id = `conv_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      return new Response(JSON.stringify({ token: `lk_tok_${fakeEl.n}`, conversation_id: id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
};

const voiceModule = () =>
  createVoiceRoutes({
    elevenlabs: (deps) =>
      createElevenLabsClient({ apiKey: deps.env.ELEVENLABS_API_KEY, fetch: elFetch }),
  });
const withVoice = (voice = voiceModule()) => [
  ...routeModules.filter((r) => r.name !== 'voice'),
  voice,
];

run('voice judge e2e: tool webhooks -> LOCKED (LOCK_SIGNER=server, LiteSVM)', () => {
  let dbUrl: string;
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let lc: Lifecycle;
  let keyA: TestKey;
  let keyB: TestKey;
  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;
  /** The demo pair: their wallets ARE the custodial demo-a / demo-b keys (decision D-A). */
  let A: SignedUp;
  let B: SignedUp;
  let roomId: string;
  const sockets: WsClient[] = [];
  let wsA: WsClient;
  let wsB: WsClient;

  beforeAll(async () => {
    dbUrl = await ownDatabase(DB_URL!, 'voice');
    ctx = await startTestServer({
      modules: withVoice(),
      env: {
        DATABASE_URL: dbUrl,
        ELEVENLABS_AGENT_ID: AGENT,
        ELEVENLABS_API_KEY: XI_KEY,
        ELEVENLABS_TOOL_SECRET: SECRET,
        MAX_STAKE_MICRO: '20000000',
      },
    });
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(Date.now() / 1000)));
    keyA = newKey();
    keyB = newKey();
    signerA = await createKeyPairSignerFromPrivateKeyBytes(keyA.secret);
    signerB = await createKeyPairSignerFromPrivateKeyBytes(keyB.secret);
    for (const owner of [signerA, signerB]) await fund(owner);
    for (const k of [0, 1, 2]) await createPoolNonce(svm, k);
    rt = {
      client: liteSvmClient(svm.svm),
      keys: {
        feePayer: svm.s,
        judge: svm.judge,
        appeal: svm.appeal,
        treasury: null,
        demoA: signerA,
        demoB: signerB,
      },
      mint: svm.mint,
      programId: ESCROW_PROGRAM_ADDRESS,
      cluster: 'localnet',
    };
    await ctx.deps.db.delete(noncePool); // this database's pool = the SVM's pool
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => rt,
        signer: 'server',
        send: { pollMs: 5, resendMs: 50, timeoutMs: 2_000 },
        timers: false,
      }),
    );

    A = await signUpWith(ctx, 'Logan', keyA);
    B = await signUpWith(ctx, 'Jake', keyB);
    roomId = await roomOf(ctx, A, [B]);
    wsA = await phoneWs(A);
    wsB = await phoneWs(B);
  }, 60_000);

  afterAll(async () => {
    for (const s of sockets) s.close();
    await lc?.idle();
    lc?.stop();
    await ctx?.server.close();
  });

  // ---- helpers ---------------------------------------------------------------------------

  async function signUpWith(c: Ctx, name: string, wallet: TestKey): Promise<SignedUp> {
    const device = newKey();
    const ch = await getChallenge(c.base, device);
    const r = await postJson(
      c.base,
      '/v1/auth/signup',
      signupBody(ch, device, wallet, { display_name: name }),
    );
    if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.json)}`);
    return { device, wallet, session: r.json as unknown as Session };
  }

  const signed = (c: Ctx, u: SignedUp, path: string, body: unknown = {}) => {
    const raw = JSON.stringify(body);
    return postJson(c.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };

  async function roomOf(c: Ctx, owner: SignedUp, members: SignedUp[]): Promise<string> {
    const room = await signed(c, owner, '/v1/rooms', { name: 'Voice e2e', kind: 'session' });
    expect(room.status).toBe(201);
    for (const m of members)
      expect((await signed(c, m, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    return room.json!.room_id as string;
  }

  async function phoneWs(u: SignedUp): Promise<WsClient> {
    const ws = await connectWs(ctx.wsUrl);
    sockets.push(ws);
    ws.send({ op: 'hello', token: u.session.token, device_id: u.session.device_id, subs: [] });
    await ws.next((f) => f.op === 'welcome');
    return ws;
  }

  /** What ElevenLabs sends: POST /el/tools/<name>, JSON body, X-YO-Tool-Secret from the workspace secret. */
  const tool = (name: string, body: unknown, secret: string | null = SECRET, c: Ctx = ctx) =>
    postJson(
      c.base,
      `/el/tools/${name}`,
      body,
      secret === null ? {} : { 'X-YO-Tool-Secret': secret },
    );

  /** A's phone: mint (pre-mint, as the challenge screen does) then challenge with that conversation. */
  async function voiceBet(
    o: { a?: SignedUp; b?: SignedUp; room?: string; subscribe?: boolean } = {},
  ) {
    const a = o.a ?? A;
    const b = o.b ?? B;
    const tok = await signed(ctx, a, '/v1/voice/tokens', { purpose: 'terms' });
    expect(tok.status).toBe(201);
    const minted = VoiceTokenResponse.parse(tok.json);
    const bet = await signed(ctx, a, '/v1/bets', {
      room_id: o.room ?? roomId,
      opponent_user_id: b.session.user.user_id,
      challenge_method: 'list',
      voice_conversation_id: minted.conversation_id,
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    // The judge's dynamic variables (API-CONTRACT §4.1) name this bet.
    expect(bet.json!.voice.dynamic_variables).toMatchObject({
      bet_id: betId,
      party_a_name: 'Logan',
    });
    if (o.subscribe)
      for (const ws of [wsA, wsB]) {
        ws.send({ op: 'subscribe', bet_id: betId, after_seq: 0 });
        await ws.next((f) => f.op === 'subscribed' && f.bet_id === betId);
      }
    return {
      betId,
      ids: { conversation_id: minted.conversation_id, bet_id: betId },
      voice_session_id: minted.voice_session_id,
    };
  }

  /** A fresh pair in a fresh room (refusal bets: no chain, and no open-bet cap shared with A/B). */
  async function freshPair() {
    const a = await signUpWith(ctx, 'Logan', newKey());
    const b = await signUpWith(ctx, 'Jake', newKey());
    return { a, b, room: await roomOf(ctx, a, [b]) };
  }

  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const dbEvents = async (id: string) =>
    ctx.deps.db
      .select({ seq: betEvents.seq, type: betEvents.type, envelope: betEvents.envelope })
      .from(betEvents)
      .where(eq(betEvents.bet_id, id))
      .orderBy(asc(betEvents.seq));
  const versions = async (id: string) =>
    (
      await ctx.deps.db
        .select({ n: count() })
        .from(betTermsVersions)
        .where(eq(betTermsVersions.bet_id, id))
    )[0]!.n;
  const audits = async (id: string, action: string) =>
    ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, id), eq(auditLog.action, action)));
  /** `bet.state:<STATE>`, `judge.cue:<CUE>`, else the event type. */
  const label = (e: { type: string; payload?: any }) =>
    e.type === 'bet.state'
      ? `bet.state:${e.payload.state}`
      : e.type === 'judge.cue'
        ? `judge.cue:${e.payload.cue}`
        : e.type;
  const labels = async (id: string) => (await dbEvents(id)).map((e) => label(e.envelope as any));
  /** The propose_terms sink runs after the reply (§4.2): wait for its effect, not the response. */
  const settledTo = (id: string, state: string) =>
    expect.poll(async () => (await betRow(id)).state, { timeout: 3_000 }).toBe(state);
  /** No background write is pending: lets a "nothing changed" assertion mean something. */
  const quiet = () => new Promise((r) => setTimeout(r, 150));

  async function findAta(owner: Address) {
    const [ata] = await findAssociatedTokenPda({
      owner,
      mint: svm.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
  }
  async function fund(owner: KeyPairSigner) {
    await send(svm.svm, svm.s, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: svm.s,
        owner: owner.address,
        mint: svm.mint,
      }),
      getMintToCheckedInstruction({
        mint: svm.mint,
        token: await findAta(owner.address),
        mintAuthority: svm.s,
        amount: 100n * USDC,
        decimals: 6,
      }),
    ]);
  }
  const usdc = async (owner: Address) => tokenAmount(svm.svm, (await findAta(owner)) as never);
  const onchainBet = async (betId: string) => {
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    const acc = svm.svm.getAccount(pda);
    return acc.exists ? getBetDecoder().decode(acc.data) : null;
  };

  // ---- Beat 2 -> 3 by voice ----------------------------------------------------------------

  it('propose (draft -> proposed) -> B accepts -> confirm_terms -> AWAITING_AUTHORIZATIONS -> LOCKED', async () => {
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const { betId, ids } = await voiceBet({ subscribe: true });

    // 1. Nothing to confirm yet (DRAFTING): NOT_PROPOSED, spoken, HTTP 200.
    const early = await tool('confirm_terms', { ...ids, heard: 'both' });
    expect([early.status, early.json]).toEqual([
      200,
      { ok: false, fix: 'NOT_PROPOSED', say: "Nothing to confirm yet. What's the bet?" },
    ]);

    // 2. Incomplete: no edge case agreed yet -> next "ask", terms.draft to both phones, DRAFTING.
    const draft = await tool('propose_terms', { ...ids, ...BOTTLE, edge_cases: [] });
    expect(draft.status).toBe(200);
    expect(draft.json).toMatchObject({ ok: true, missing: ['edge_cases'], next: 'ask' });
    for (const ws of [wsA, wsB]) {
      const f = await ws.next((e) => e.type === 'terms.draft' && e.bet_id === betId);
      expect(parseRealtimeEvent(f).ok).toBe(true);
      expect(f.payload.draft).toMatchObject({ bet_id: betId, missing: ['edge_cases'] });
    }
    expect((await betRow(betId)).state).toBe('DRAFTING');
    expect(await versions(betId)).toBe(0);

    // 3. Complete: the read-back, terms.proposed (the card's envelope) to both phones.
    const body = { ...ids, ...BOTTLE };
    const proposed = await tool('propose_terms', body);
    expect(proposed.status).toBe(200);
    expect(proposed.json).toMatchObject({ ok: true, next: 'readback' });
    expect(proposed.json!.say).toContain('Five dollars each.');
    expect(Buffer.byteLength(JSON.stringify(proposed.json))).toBeLessThanOrEqual(
      TOOL_REPLY_MAX_BYTES,
    );
    await settledTo(betId, 'TERMS_PROPOSED');
    const card = await wsB.next((e) => e.type === 'terms.proposed' && e.bet_id === betId);
    expect(card.payload.envelope.terms).toMatchObject({
      bet_id: betId,
      claim: BOTTLE.claim,
      performer: 'B',
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      party_a: { display_name: 'Logan', pubkey: signerA.address },
      party_b: { display_name: 'Jake', pubkey: signerB.address },
    });
    // The spoken read-back is the card's read-back (one server template over the same terms).
    expect(card.payload.envelope.presentation.readback).toBe(proposed.json!.say);
    expect(await versions(betId)).toBe(1);

    // 4. Replay inside the 10 s window: the stored reply, and the sink does not run again.
    expect(TOOL_DEDUPE_WINDOW_MS).toBe(10_000);
    const again = await tool('propose_terms', body);
    expect(again.json).toEqual(proposed.json);
    await quiet();
    expect(await versions(betId)).toBe(1);

    // 5. Spoken "deal" before B accepted the challenge on their own phone: not consent.
    const pending = await tool('confirm_terms', { ...ids, heard: 'both' });
    expect(pending.status).toBe(200);
    expect(pending.json).toEqual({
      ok: false,
      fix: 'INVITE_PENDING',
      say: 'Jake has to accept the challenge on their phone first.',
    });
    expect((await betRow(betId)).state).toBe('TERMS_PROPOSED');

    // 6. B accepts; the judge confirms: frozen now, the custodial lock in the background.
    expect((await signed(ctx, B, `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
    const confirmed = await tool('confirm_terms', { ...ids, heard: 'both' });
    expect(confirmed.status).toBe(200);
    const hash = (await betRow(betId)).terms_hash!;
    expect(confirmed.json).toEqual({
      ok: true,
      code: `${hash.slice(0, 4)}·${hash.slice(4, 8)}`,
      say: 'Logan, Jake: hold the button on your own phone to lock it in. Nothing moves until you both do.',
    });
    expect(['AWAITING_AUTHORIZATIONS', 'AWAITING_LOCK', 'LOCKED']).toContain(
      (await betRow(betId)).state,
    );
    await lc.idle();
    expect((await betRow(betId)).state).toBe('LOCKED');
    expect((await onchainBet(betId))!.status).toBe(BetStatus.Locked);
    expect(await usdc(signerA.address)).toBe(a0 - 5n * USDC);
    expect(await usdc(signerB.address)).toBe(b0 - 5n * USDC);

    // 7. The confirm replay is the same answer and starts nothing (one freeze, one lock).
    const replay = await tool('confirm_terms', { ...ids, heard: 'both' });
    expect(replay.json).toEqual(confirmed.json);
    await lc.idle();
    const frozen = (await audits(betId, 'bet.state_changed')).filter(
      (r) => (r.details as any).to === 'AWAITING_AUTHORIZATIONS',
    );
    expect(frozen).toHaveLength(1);
    expect((frozen[0]!.details as any).heard).toBe('both');

    // 8. Frozen terms cannot be re-proposed (SCHEMAS §9.2).
    expect((await tool('propose_terms', { ...body, amount_usd: '6' })).json).toMatchObject({
      ok: false,
      fix: 'NOT_DRAFTING',
    });

    // The bet log both phones followed, ending with the [EVENT] line A's phone voices.
    expect(await labels(betId)).toEqual([
      'bet.invited',
      'bet.state:DRAFTING',
      'terms.draft',
      'terms.proposed',
      'bet.state:TERMS_PROPOSED',
      'bet.invite_answered',
      'bet.state:AWAITING_AUTHORIZATIONS',
      'terms.proposed', // the frozen (final) envelope
      'terms.authorized',
      'judge.cue:AUTHORIZED',
      'terms.authorized',
      'judge.cue:AUTHORIZED',
      'bet.state:AWAITING_LOCK',
      'tx.submitted',
      'bet.state:LOCKED',
      'tx.confirmed',
      'judge.cue:LOCKED',
    ]);
    const locked = await wsA.next(
      (e) => e.type === 'judge.cue' && e.bet_id === betId && e.payload.cue === 'LOCKED',
    );
    expect(locked.payload.speak).toBe(true);
    expect(locked.payload.text).toMatch(/^\[EVENT\] LOCKED .* :: .*request_attempt/);
  });

  // ---- refusals --------------------------------------------------------------------------

  it.each(REFUSALS)(
    'refusal $category ($id): spoken inline, terms.refused + CANCELLED + judge.cue REFUSED; it stays refused',
    async ({ category, args }) => {
      const p = await freshPair();
      const { betId, ids } = await voiceBet({ a: p.a, b: p.b, room: p.room });
      const r = await tool('propose_terms', { ...ids, ...args });
      expect([r.status, r.json]).toEqual([
        200,
        { ok: false, refused: category, say: REFUSAL_QUIPS[category], next: 'end' },
      ]);
      await settledTo(betId, 'CANCELLED');
      const row = await betRow(betId);
      expect(row).toMatchObject({ end_reason: 'refused', refusal_category: category });
      const evs = await dbEvents(betId);
      expect(evs.map((e) => label(e.envelope as any))).toEqual([
        'bet.invited',
        'bet.state:DRAFTING',
        'terms.refused',
        'bet.state:CANCELLED',
        'judge.cue:REFUSED',
      ]);
      const refused = evs.find((e) => e.type === 'terms.refused')!.envelope as any;
      expect(refused.payload.refusal).toEqual({
        refused: true,
        category,
        quip: REFUSAL_QUIPS[category],
      });
      expect(await audits(betId, 'terms.refused_prefilter')).toHaveLength(1);

      // A re-worded, safe call on the same bet gets the refusal again; nothing is composed.
      const sanitized = await tool('propose_terms', { ...ids, ...BOTTLE });
      expect(sanitized.json).toEqual(r.json);
      // The judge cannot confirm a cancelled bet, and A's phone cannot mint for it any more.
      expect((await tool('confirm_terms', { ...ids, heard: 'both' })).json).toMatchObject({
        ok: false,
        fix: 'NOT_PROPOSED',
      });
      const tok = await signed(ctx, p.a, '/v1/voice/tokens', { purpose: 'terms', bet_id: betId });
      expect([tok.status, tok.json!.error.code]).toEqual([409, 'INVALID_STATE']);
      await quiet();
      expect(await versions(betId)).toBe(0);
      expect((await betRow(betId)).state).toBe('CANCELLED');
    },
  );

  // ---- tool auth ---------------------------------------------------------------------------

  it('a bad or missing X-YO-Tool-Secret is 401 on both tools and changes nothing', async () => {
    const p = await freshPair();
    const { betId, ids } = await voiceBet({ a: p.a, b: p.b, room: p.room });
    for (const name of ['propose_terms', 'confirm_terms']) {
      // (A trailing space is not a different secret: HTTP trims header values.)
      for (const secret of [
        null,
        '',
        'wrong',
        SECRET.slice(0, -1),
        `${SECRET}x`,
        SECRET.toUpperCase(),
      ]) {
        const r = await tool(name, { ...ids, ...BOTTLE, heard: 'both' }, secret);
        expect([name, r.status, r.json]).toEqual([name, 401, { ok: false, fix: 'UNAUTHORIZED' }]);
      }
    }
    await quiet();
    expect((await betRow(betId)).state).toBe('DRAFTING');
    expect(await labels(betId)).toEqual(['bet.invited', 'bet.state:DRAFTING']);
    // The right secret then works (the 401s did not poison the replay cache).
    expect((await tool('propose_terms', { ...ids, ...BOTTLE })).json).toMatchObject({ ok: true });
  });

  it('a server without ELEVENLABS_TOOL_SECRET refuses every tool call (fail closed)', async () => {
    const open = await startTestServer({
      modules: withVoice(),
      env: { DATABASE_URL: dbUrl, ELEVENLABS_AGENT_ID: AGENT },
    });
    try {
      for (const name of ['propose_terms', 'confirm_terms'])
        for (const secret of [null, '', 'anything']) {
          const r = await tool(name, { conversation_id: 'c', bet_id: randomUUID() }, secret, open);
          expect(r.status).toBe(401);
        }
    } finally {
      await open.server.close();
    }
  });

  // ---- binding ---------------------------------------------------------------------------

  it('confirm_terms binding: another bet, an unknown / unbound / ended conversation or missing ids -> WRONG_BET', async () => {
    const p = await freshPair();
    const s = await voiceBet({ a: p.a, b: p.b, room: p.room });
    expect((await tool('propose_terms', { ...s.ids, ...BOTTLE })).json).toMatchObject({ ok: true });
    await settledTo(s.betId, 'TERMS_PROPOSED');
    expect((await signed(ctx, p.b, `/v1/bets/${s.betId}/invite/accept`)).status).toBe(200);
    const q = await freshPair();
    const other = await voiceBet({ a: q.a, b: q.b, room: q.room });
    const WRONG = { ok: false, fix: 'WRONG_BET', say: "That's not this bet's docket." };

    // This bet's conversation addressing another bet, and the other way round.
    expect(
      (await tool('confirm_terms', { ...s.ids, bet_id: other.betId, heard: 'both' })).json,
    ).toEqual(WRONG);
    expect(
      (
        await tool('confirm_terms', {
          conversation_id: other.ids.conversation_id,
          bet_id: s.betId,
          heard: 'A',
        })
      ).json,
    ).toEqual(WRONG);
    await expect
      .poll(async () =>
        (await audits(s.betId, 'el_tool.wrong_bet')).map((r) => (r.details as any).reason),
      )
      .toEqual(['bet_mismatch']);
    // An unknown conversation, a pre-minted one bound to no bet, and missing ids.
    expect(
      (await tool('confirm_terms', { conversation_id: 'conv_nope', bet_id: s.betId })).json,
    ).toEqual(WRONG);
    const pre = VoiceTokenResponse.parse(
      (await signed(ctx, p.a, '/v1/voice/tokens', { purpose: 'terms' })).json,
    );
    expect(
      (await tool('confirm_terms', { conversation_id: pre.conversation_id, bet_id: s.betId })).json,
    ).toEqual(WRONG);
    expect((await tool('confirm_terms', { bet_id: s.betId, heard: 'both' })).json).toEqual(WRONG);
    expect((await tool('confirm_terms', { conversation_id: s.ids.conversation_id })).json).toEqual(
      WRONG,
    );
    // An ended session can no longer drive its bet.
    await ctx.deps.db
      .update(voiceSessions)
      .set({ status: 'ended' })
      .where(eq(voiceSessions.id, s.voice_session_id));
    expect((await tool('confirm_terms', { ...s.ids, heard: 'both' })).json).toEqual(WRONG);
    // A body that is not JSON is a spoken INVALID, never a 500.
    const junk = await postJson(ctx.base, '/el/tools/confirm_terms', '{not json', {
      'X-YO-Tool-Secret': SECRET,
    });
    expect([junk.status, junk.json!.fix]).toEqual([200, 'INVALID']);

    // §4.1: every WRONG_BET that names this bet left an audit row, with the reason.
    await expect
      .poll(async () =>
        (await audits(s.betId, 'el_tool.wrong_bet')).map((r) => (r.details as any).reason).sort(),
      )
      .toEqual([
        'bet_mismatch',
        'missing_ids',
        'no_active_session',
        'no_active_session',
        'no_active_session',
      ]);
    await quiet();
    expect((await betRow(s.betId)).state).toBe('TERMS_PROPOSED'); // nothing was frozen
    expect((await betRow(other.betId)).state).toBe('DRAFTING');
  });

  // ---- POST /v1/voice/tokens with and without keys ------------------------------------------

  it('with keys: the real client calls GET /v1/convai/conversation/token; upstream failures are 502/504', async () => {
    const p = await freshPair();
    const mint = (body: Record<string, unknown> = { purpose: 'terms' }) =>
      signed(ctx, p.a, '/v1/voice/tokens', body);

    fakeEl.mode = 'ok';
    const before = fakeEl.requests.length;
    const ok = await mint();
    expect(ok.status).toBe(201);
    const minted = VoiceTokenResponse.parse(ok.json);
    expect(minted).toMatchObject({ agent_id: AGENT, expires_at: null });
    expect(fakeEl.requests.slice(before)).toEqual([
      {
        url: `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${AGENT}`,
        method: 'GET',
        key: XI_KEY,
      },
    ]);
    // The token never reaches a log line or the stored session row.
    const [row] = await ctx.deps.db
      .select()
      .from(voiceSessions)
      .where(eq(voiceSessions.id, minted.voice_session_id));
    expect(JSON.stringify(row)).not.toContain(minted.conversation_token);
    expect(row).toMatchObject({ el_conversation_id: minted.conversation_id, status: 'active' });

    const failures: Array<[ElMode, number, string]> = [
      ['http_401', 502, 'UPSTREAM_ERROR'], // a wrong / revoked key
      ['not_json', 502, 'UPSTREAM_ERROR'],
      ['bad_shape', 502, 'UPSTREAM_ERROR'], // e.g. {token} without conversation_id
      ['network', 502, 'UPSTREAM_ERROR'],
      ['timeout', 504, 'UPSTREAM_TIMEOUT'],
    ];
    for (const [mode, status, code] of failures) {
      fakeEl.mode = mode;
      const r = await mint();
      expect([mode, r.status, r.json!.error.code]).toEqual([mode, status, code]);
      expect(JSON.stringify(r.json)).not.toContain(XI_KEY);
    }
    fakeEl.mode = 'http_401';
    expect((await mint()).json!.error.details).toEqual({ upstream_status: 401 });
    fakeEl.mode = 'ok';
    // B (not the voice host) and a malformed body are 4xx before any upstream call.
    const s = await voiceBet({ a: p.a, b: p.b, room: p.room });
    const n = fakeEl.requests.length;
    expect(
      (await signed(ctx, p.b, '/v1/voice/tokens', { purpose: 'terms', bet_id: s.betId })).status,
    ).toBe(403);
    expect((await mint({ purpose: 'hearing' })).status).toBe(422);
    expect(fakeEl.requests.length).toBe(n);
  });

  it('without keys: a clean 502 UPSTREAM_ERROR with a reason, never a 500, and ElevenLabs is never called', async () => {
    const cases: Array<{
      name: string;
      env: Record<string, string>;
      reason: string;
      prod?: boolean;
    }> = [
      { name: 'nothing configured', env: {}, reason: 'not_configured' },
      {
        name: 'agent id, no API key',
        env: { ELEVENLABS_AGENT_ID: AGENT },
        reason: 'not_configured',
      },
      {
        name: 'API key, no agent id',
        env: { ELEVENLABS_API_KEY: XI_KEY },
        reason: 'not_configured',
      },
      // The production client (createVoiceRoutes() default): spend guard on, key unset.
      {
        name: 'prod client, ALLOW_SPEND, no API key',
        env: { ELEVENLABS_AGENT_ID: AGENT, ALLOW_SPEND: 'true' },
        reason: 'not_configured',
        prod: true,
      },
      {
        name: 'prod client, key but no ALLOW_SPEND',
        env: { ELEVENLABS_AGENT_ID: AGENT, ELEVENLABS_API_KEY: XI_KEY },
        reason: 'spend_disabled',
        prod: true,
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const k of cases) {
        const c = await startTestServer({
          modules: withVoice(k.prod ? createVoiceRoutes() : voiceModule()),
          env: { DATABASE_URL: dbUrl, ...k.env },
        });
        try {
          const before = fakeEl.requests.length;
          const u = await signUpWith(c, 'Logan', newKey());
          const r = await signed(c, u, '/v1/voice/tokens', { purpose: 'terms' });
          expect([k.name, r.status, r.json!.error]).toEqual([
            k.name,
            502,
            expect.objectContaining({
              code: 'UPSTREAM_ERROR',
              retryable: false,
              details: { reason: k.reason },
            }),
          ]);
          expect(fakeEl.requests.length).toBe(before);
        } finally {
          await c.server.close();
        }
      }
      const urls = fetchSpy.mock.calls.map(([u]) => String(u instanceof Request ? u.url : u));
      expect(urls.filter((u) => u.includes('elevenlabs'))).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
