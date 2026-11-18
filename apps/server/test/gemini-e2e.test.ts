/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// Beat 6 end to end ACROSS the slices: the Gemini closer over the real HTTP app + WS hub +
// Postgres + LiteSVM running the real escrow.so, with a fake Gemini answering REAL recorded
// responses (fixtures/gemini-btc5m.json). Every step is a request a phone or the stage would
// send; the settlement keeper's deps.onRuling (src/server.ts) is what sends `resolve`.
//
//   challenge -> accept -> POST /terms/market (binding quote: unequal stakes) -> POST /terms/confirm
//   -> the lock (custodial, or both phones run the device policy incl. the gemini rule
//      accept_deadline = unix(quotedAt) + 60 and sign) -> LOCKED -> AWAITING_MARKET in one commit
//   -> market.tick -> expiry -> Gemini settles -> settlement ruling -> resolve -> RULED
//   -> finalize after the appeal window (PAID: the winner takes the whole unequal pot), the
//      loser's custodial GG, or a voided contract -> resolve(Refund) -> VOIDED (each stake back)
//   plus a quote that runs out before the second signature -> EXPIRED quote_expired, nothing moved.
//
// The server clock (and the SVM clock with it) runs at the recorded time: 02:37:10 UTC on
// 2026-11-18, inside the 02:35-02:40 window of BTC05M2611180240. Each test rewinds it; bets are
// independent PDAs and nonces don't care about time.
// Own database (<DATABASE_URL db>_gem_e2e): it owns nonce_pool and gemini_markets.
// Skips without DATABASE_URL or without programs/escrow/target/deploy/escrow.so.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { betEvents, bets, noncePool, rulings } from '@youre-on/db';
import { SignRequest } from '@youre-on/shared/api';
import { AuthorizeRequest } from '@youre-on/shared/authorization';
import { TOKEN_PROGRAM_ID } from '@youre-on/shared/chain/constants';
import { QUOTE_TTL_SECS } from '@youre-on/shared/constants';
import {
  checkDevicePolicy,
  type DevicePolicyDerivations,
  type DevicePolicyPins,
} from '@youre-on/shared/device-policy';
import {
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  findBetPda,
  findConfigPda,
  findEventAuthorityPda,
  findVaultPda,
  getBetDecoder,
} from '@youre-on/shared/escrow-client';
import { GeminiSettlementRecord } from '@youre-on/shared/evidence';
import { hashJcs } from '@youre-on/shared/jcs';
import { marketTermsPath, MarketTermsResponse } from '@youre-on/shared/judge/market-terms';
import { termsConfirmPath } from '@youre-on/shared/judge/typed-terms';
import { betIdToBytes } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { Ruling } from '@youre-on/shared/ruling';
import { SettlementEvidence } from '@youre-on/shared/settlement';
import { renderSignCard } from '@youre-on/shared/sign-card';
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
import { createGeminiClient } from '../src/markets/gemini';
import { MarketService } from '../src/markets/service';
import { installSettlement, SettlementService } from '../src/markets/settlement';
import { silentLogger } from '../src/log';
import {
  clone,
  EVENTS_PATH,
  eventPath,
  fakeGemini,
  GEMINI_FIXTURE as F,
  T0237,
  TICKER_PATH,
  type FakeGemini,
} from './gemini-fake';
import { liteSvmClient } from './litesvm-client';
import {
  connectWs,
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
  type WsClient,
} from './helpers';

const run = DB_URL && HAVE_SO ? describe : describe.skip;
const STAGE_KEY = 'stage-key-for-gemini-e2e';
const ADMIN = 'demo-admin-token-for-gemini-e2e';
const TICKER = 'BTC05M2611180240';
const T0240 = Date.parse('2026-11-18T02:40:00.000Z');
const b58 = getBase58Decoder();

/** SYNTHETIC: the recorded settled body with the other side ("yes", above the line). */
function settledYes() {
  const e = clone(F.event_0240_settled) as any;
  e.contracts[0].resolutionSide = 'yes';
  e.contracts[0].settlementValue = '64401.25';
  return e;
}
/** SYNTHETIC: the recorded settled body, voided by Gemini. */
function voided() {
  const e = clone(F.event_0240_settled) as any;
  e.status = 'invalid';
  e.contracts[0].status = 'invalid';
  delete e.contracts[0].resolutionSide;
  delete e.contracts[0].settlementValue;
  return e;
}

run('e2e Beat 6: the Gemini closer (HTTP + WS + LiteSVM + recorded Gemini)', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let lc: Lifecycle;
  let g: FakeGemini;
  let markets: MarketService;
  let svc: SettlementService;
  let offset = 0;
  const now = () => T0237 + offset;
  let keyA: TestKey;
  let keyB: TestKey;
  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;
  let A: SignedUp;
  let B: SignedUp;
  let roomId: string;
  const sockets: WsClient[] = [];
  let wsStage: WsClient;

  const install = (signer: 'phones' | 'server') => {
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => rt,
        signer,
        send: { pollMs: 5, resendMs: 50, timeoutMs: 2_000 },
        timers: false,
      }),
    );
  };
  /** Moves the server clock and the SVM clock together (to `T0237 + ms`). */
  const at = (ms: number) => {
    offset = ms;
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
  };
  const settle = async () => {
    await svc.idle();
    await lc.idle();
  };

  beforeAll(async () => {
    const dbUrl = await ownDatabase(DB_URL!, 'gem_e2e');
    g = fakeGemini({});
    ctx = await startTestServer({
      now,
      env: { DATABASE_URL: dbUrl, DEMO_MODE: 'true', STAGE_KEY, DEMO_ADMIN_TOKEN: ADMIN },
    });
    await ctx.deps.db.execute(sql`TRUNCATE gemini_markets, market_snapshots CASCADE`);
    svm = await newEnv();
    at(0);
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
    await ctx.deps.db.delete(noncePool);
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    install('server');

    A = await signUpWith('Logan', keyA);
    B = await signUpWith('Jake', keyB);
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'Closer', kind: 'session' });
    roomId = room.json!.room_id;
    expect((await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const st = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_id: roomId,
    });
    expect(st.status).toBe(201);
    wsStage = await connectWs(ctx.wsUrl);
    sockets.push(wsStage);
    wsStage.send({ op: 'hello', token: st.json!.token, subs: [] });
    await wsStage.next((f) => f.op === 'welcome');
    wsStage.send({ op: 'subscribe_room', room_id: roomId });
    await new Promise((r) => setTimeout(r, 100));
  }, 60_000);

  afterAll(async () => {
    for (const s of sockets) s.close();
    svc?.stop();
    await lc?.idle();
    lc?.stop();
    await ctx?.server.close();
  });

  beforeEach(async () => {
    at(0);
    g.routes.clear();
    g.routes.set(EVENTS_PATH, F.events_0237);
    g.routes.set(eventPath(TICKER), F.event_0240_active);
    g.routes.set(TICKER_PATH, F.btcusd);
    markets = new MarketService({
      client: createGeminiClient({ fetch: g.fetch }),
      now,
      log: silentLogger,
    });
    ctx.deps.markets = markets;
    svc?.stop();
    svc = installSettlement(ctx.deps, new SettlementService(ctx.deps, { timers: false }));
    markets.onSnapshot((s) => svc.onSnapshot(s));
    await markets.refresh(); // discovery at 02:37:10: bid .54 / ask .67 -> 61 % UP
  });

  // ---- helpers ---------------------------------------------------------------------------

  async function signUpWith(name: string, wallet: TestKey): Promise<SignedUp> {
    const device = newKey();
    const ch = await getChallenge(ctx.base, device);
    const r = await postJson(
      ctx.base,
      '/v1/auth/signup',
      signupBody(ch, device, wallet, { display_name: name }),
    );
    if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.json)}`);
    return { device, wallet, session: r.json as any };
  }
  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw, { ts: now() }),
      body: raw || undefined,
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const get = async (u: SignedUp, path: string) => {
    const res = await fetch(ctx.base + path, {
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const dbEvents = async (id: string) =>
    ctx.deps.db
      .select({ seq: betEvents.seq, envelope: betEvents.envelope })
      .from(betEvents)
      .where(eq(betEvents.bet_id, id))
      .orderBy(asc(betEvents.seq));

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
  const pins = (): DevicePolicyPins => ({
    feePayer: svm.s.address,
    programId: ESCROW_PROGRAM_ADDRESS,
    mint: svm.mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    cluster: ctx.deps.env.SOLANA_CLUSTER,
  });
  async function derivations(betId: string): Promise<DevicePolicyDerivations> {
    const idBytes = betIdToBytes(betId);
    const [bet] = await findBetPda({ betId: idBytes });
    const [vault] = await findVaultPda({ betId: idBytes });
    const [config] = await findConfigPda();
    const [eventAuthority] = await findEventAuthorityPda();
    const atas = new Map<string, string>();
    for (const o of [signerA.address, signerB.address]) atas.set(o, await findAta(o));
    return {
      betPdas: (id) => {
        if (id !== betId) throw new Error(`no PDAs for ${id}`);
        return { bet, vault, config };
      },
      eventAuthority: () => eventAuthority,
      associatedTokenAddress: (owner, mint) => {
        const ata = atas.get(owner);
        if (!ata || mint !== svm.mint) throw new Error('no ATA');
        return ata;
      },
    };
  }

  /** Logan challenges Jake; Jake accepts; Logan bets `side` on Bitcoin; Logan confirms. */
  async function marketBet(side: 'UP' | 'DOWN', amount: string) {
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: roomId,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    expect((await signed(B, 'POST', `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
    const r = await signed(A, 'POST', marketTermsPath(betId), { side, amount_usd: amount });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const res = MarketTermsResponse.parse(r.json);
    const c = await signed(A, 'POST', termsConfirmPath(betId), { terms_hash: res.terms_hash });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    await lc.idle();
    return { betId, res };
  }

  /** Both phones: the shared device policy on the stored bytes (gemini rule included), sign, POST. */
  async function phonesSign(betId: string, parties: ('A' | 'B')[] = ['B', 'A']) {
    const raw = (await get(A, `/v1/bets/${betId}/lock`)).json;
    expect((await get(B, `/v1/bets/${betId}/lock`)).json).toEqual(raw);
    const req = AuthorizeRequest.parse(raw);
    // SCHEMAS §8.3: the gemini lock window is the quote's TTL
    const quotedAt = req.envelope.terms.market!.quotedAt;
    expect(req.accept_deadline).toBe(Math.floor(Date.parse(quotedAt) / 1000) + QUOTE_TTL_SECS);
    expect(req.expires_at).toBe(new Date((req.accept_deadline - 5) * 1000).toISOString());
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    const derive = await derivations(betId);
    for (const party of parties) {
      const [u, key] = party === 'A' ? [A, keyA] : [B, keyB];
      const v = checkDevicePolicy(msg, {
        screen: 'terms_card',
        lockMode: 'atomic',
        request: raw,
        devicePubkey: u.wallet.pubkey,
        nowSecs: Math.floor(now() / 1000),
        derive,
        pins: pins(),
      });
      expect(v, `device policy (${party}): ${JSON.stringify(v)}`).toMatchObject({
        ok: true,
        kind: 'atomic_lock',
        party,
        terms_hash: req.envelope.terms_hash,
      });
      const r = await signed(u, 'POST', `/v1/bets/${betId}/lock/authorizations`, {
        bet_id: betId,
        lock_request_id: req.lock_request_id,
        party,
        terms_hash: req.envelope.terms_hash,
        method: 'faceid_hold',
        authorized_at: new Date(now()).toISOString(),
        ms_since_auth_success: 90,
        message_sha256: req.message_sha256,
        party_signature: b58.decode(ed.sign(msg, key.secret)),
      });
      expect(r.status).toBe(202);
    }
    await lc.idle();
    return req;
  }

  /** The bet is locked on chain with Gemini's unequal stakes and the quote's accept deadline. */
  async function expectAwaitingMarket(betId: string, res: MarketTermsResponse) {
    expect((await betRow(betId)).state).toBe('AWAITING_MARKET');
    const onchain = await onchainBet(betId);
    expect(onchain!.status).toBe(BetStatus.Locked);
    expect(onchain!.stakeA).toBe(BigInt(res.quote.stakes.a));
    expect(onchain!.stakeB).toBe(BigInt(res.quote.stakes.b));
    expect(Buffer.from(onchain!.termsHash).toString('hex')).toBe(res.terms_hash);
    expect(onchain!.acceptDeadline).toBe(
      BigInt(Math.floor(Date.parse(res.quote.market.quotedAt) / 1000) + QUOTE_TTL_SECS),
    );
    expect(svc.followed).toContain(betId);
  }

  /** Gemini settles with `body` at expiry + `afterMs`; the keeper rules; resolve lands: RULED. */
  async function settleWith(betId: string, body: unknown, afterMs = 6_000) {
    g.routes.set(eventPath(TICKER), body);
    at(T0240 + afterMs - T0237);
    expect(await svc.check(betId)).toBe('settled');
    await settle();
    const [row] = await ctx.deps.db.select().from(rulings).where(eq(rulings.bet_id, betId));
    const ruling = Ruling.parse(JSON.parse(row!.record_canonical));
    const record = GeminiSettlementRecord.parse(JSON.parse(row!.evidence_canonical!));
    const bet = await betRow(betId);
    expect(bet).toMatchObject({
      state: 'RULED',
      ruling_hash: row!.ruling_hash,
      evidence_hash: hashJcs(record),
    });
    const onchain = await onchainBet(betId);
    expect(onchain!.status).toBe(BetStatus.Resolved);
    expect(Buffer.from(onchain!.evidenceHash).toString('hex')).toBe(hashJcs(record));
    expect(Buffer.from(onchain!.rulingHash).toString('hex')).toBe(row!.ruling_hash);
    return { ruling, record, bet };
  }

  async function finalizeAfterWindow(betId: string, state: 'PAID' | 'VOIDED') {
    expect(await lc.payout.finalizeDue(now())).not.toContain(betId); // the 10 s window is open
    at(offset + 12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state, payout_via: 'finalize' });
    expect(await onchainBet(betId)).toBeNull(); // close_bet closed it
  }

  const label = (e: any) =>
    e.type === 'bet.state'
      ? `bet.state:${e.payload.state}`
      : e.type === 'judge.cue'
        ? `judge.cue:${e.payload.cue}`
        : e.type;
  /** The bet's event log, ticks folded, the racy 'processed' payout frame left out. */
  async function eventOrder(betId: string) {
    const out: string[] = [];
    for (const e of await dbEvents(betId)) {
      const env = e.envelope as any;
      if (env.type === 'bet.state' && env.payload.reason === 'processed') continue;
      const l = label(env);
      if (l === 'market.tick' && out.at(-1) === 'market.tick') continue;
      out.push(l);
    }
    return out;
  }
  const TO_AWAITING = (signer: 'phones' | 'server') => [
    'bet.invited',
    'bet.state:DRAFTING',
    'bet.invite_answered',
    'terms.proposed',
    'bet.state:TERMS_PROPOSED',
    'bet.state:AWAITING_AUTHORIZATIONS',
    'terms.proposed',
    ...(signer === 'phones' ? ['terms.authorize_request'] : []),
    'terms.authorized',
    'judge.cue:AUTHORIZED',
    'terms.authorized',
    'judge.cue:AUTHORIZED',
    'bet.state:AWAITING_LOCK',
    'tx.submitted',
    'bet.state:LOCKED',
    'tx.confirmed',
    'judge.cue:LOCKED',
    'bet.state:AWAITING_MARKET',
    'judge.cue:MARKET_WAITING',
  ];

  // ---- the beats -------------------------------------------------------------------------

  it('custodial: UP at Gemini 61/39 -> Gemini settles NO (recorded) -> B takes the pot -> PAID', async () => {
    install('server');
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const { betId, res } = await marketBet('UP', '5');
    expect(res.quote.stakes).toEqual({ a: '6100000', b: '3900000', currency: 'USDC' });
    await expectAwaitingMarket(betId, res);
    expect(await usdc(signerA.address)).toBe(a0 - 6_100_000n);
    expect(await usdc(signerB.address)).toBe(b0 - 3_900_000n);
    const locked = (await dbEvents(betId)).map((e) => e.envelope as any);
    expect(
      locked.find((e) => e.type === 'judge.cue' && e.payload.cue === 'LOCKED').payload.text,
    ).toMatch(/Gemini's odds.*02:40 UTC/);

    // live price while the clock runs
    at(2_000);
    await markets.refresh();
    await svc.idle();
    expect(await svc.check(betId)).toBe('pending');

    const { ruling, record } = await settleWith(betId, F.event_0240_settled);
    expect(ruling).toMatchObject({
      outcome: 'B_WINS',
      claim_result: 'NOT_MET',
      stage: 'settlement',
    });
    expect(record.contract).toMatchObject({
      resolutionSide: 'no',
      settlementValue: '64367.38366666667',
    });
    // The evidence chain, re-checked end to end: Gemini's bytes -> record -> ruling -> chain.
    const ev = await get(B, `/v1/bets/${betId}/settlement`);
    expect(ev.status).toBe(200);
    const evidence = SettlementEvidence.parse(ev.json);
    expect(evidence.raw_body).toBe(JSON.stringify(F.event_0240_settled));
    expect(evidence.record).toEqual(record);
    expect(evidence.verification).toEqual({
      ok: true,
      checks: {
        body_matches_record: true,
        record_hash: true,
        ruling_commits_record: true,
        ruling_hash: true,
        outcome_follows_gemini: true,
        onchain_evidence: true,
        onchain_ruling: true,
      },
    });
    const onchain = await onchainBet(betId);
    expect(evidence.onchain?.evidence_hash).toBe(
      Buffer.from(onchain!.evidenceHash).toString('hex'),
    );
    expect(evidence.onchain?.resolve_signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    await finalizeAfterWindow(betId, 'PAID');
    // B wins the whole $10 pot: A's $6.10 on top of B's own $3.90
    expect(await usdc(signerA.address)).toBe(a0 - 6_100_000n);
    expect(await usdc(signerB.address)).toBe(b0 + 6_100_000n);

    expect(await eventOrder(betId)).toEqual([
      ...TO_AWAITING('server'),
      'market.tick',
      'market.settled',
      'ruling.issued',
      'judge.cue:MARKET_SETTLED',
      'bet.state:RULED',
      'tx.confirmed',
      'bet.state:FINALIZED',
      'tx.submitted',
      'bet.state:PAID',
      'tx.confirmed',
      'judge.cue:PAID',
    ]);
    // the stage (room channel) got every event, valid, Gemini's record included
    const last = (await betRow(betId)).last_seq;
    await expect
      .poll(() => wsStage.frames.filter((f) => f.bet_id === betId && !f.op).at(-1)?.seq ?? 0)
      .toBe(last);
    const staged = wsStage.frames.filter((f) => f.bet_id === betId && !f.op);
    for (const f of staged) expect(parseRealtimeEvent(f).ok, f.type).toBe(true);
    const settled = staged.find((f) => f.type === 'market.settled');
    expect(settled.payload.record).toEqual(record);
  });

  it('phones: DOWN, both run the device policy (gemini accept_deadline) -> Gemini voids -> refund -> VOIDED', async () => {
    install('phones');
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const { betId, res } = await marketBet('DOWN', '2');
    // DOWN = NO at 39 %: Logan $1.56 against Jake's $2.44 (pot $4)
    expect(res.quote.stakes).toEqual({ a: '1560000', b: '2440000', currency: 'USDC' });
    expect((await betRow(betId)).state).toBe('AWAITING_AUTHORIZATIONS');
    at(3_000); // a few seconds of hold + Face ID
    await phonesSign(betId);
    await expectAwaitingMarket(betId, res);

    const { ruling } = await settleWith(betId, voided(), 9_000);
    expect(ruling).toMatchObject({ outcome: 'VOID', void_reason: 'market_invalid' });
    expect((await betRow(betId)).outcome).toBe('refund');
    await finalizeAfterWindow(betId, 'VOIDED');
    // each side got exactly its own (unequal) stake back
    expect(await usdc(signerA.address)).toBe(a0);
    expect(await usdc(signerB.address)).toBe(b0);
    expect(await eventOrder(betId)).toEqual([
      ...TO_AWAITING('phones'),
      'market.settled',
      'ruling.issued',
      'judge.cue:VOIDED',
      'bet.state:RULED',
      'tx.confirmed',
      'bet.state:FINALIZED',
      'tx.submitted',
      'bet.state:VOIDED',
      'tx.confirmed',
      'judge.cue:VOIDED',
    ]);
  });

  it('custodial: UP, Gemini (synthetic) YES -> Logan wins; Jake GGs -> PAID at once', async () => {
    install('server');
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const { betId, res } = await marketBet('UP', '1');
    expect(res.quote.stakes).toEqual({ a: '1220000', b: '780000', currency: 'USDC' });
    await expectAwaitingMarket(betId, res);
    const { ruling, bet } = await settleWith(betId, settledYes());
    expect(ruling).toMatchObject({ outcome: 'A_WINS', claim_result: 'MET' });
    // GG inside the appeal window (custodial: the server signs as demo-b)
    const post = await signed(B, 'POST', `/v1/bets/${betId}/concede`, {
      bet_id: betId,
      kind: 'concede',
      party: 'B',
      method: 'faceid_hold',
      signed_at: new Date(now()).toISOString(),
    });
    expect(post.status).toBe(202);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'concede' });
    expect(bet.appeal_deadline).not.toBeNull();
    expect(await usdc(signerA.address)).toBe(a0 + 780_000n);
    expect(await usdc(signerB.address)).toBe(b0 - 780_000n);
  });

  it('phones: DOWN loses to a (synthetic) YES; the loser GGs on the phone (GG card with odds, policy) -> PAID', async () => {
    install('phones');
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const { betId, res } = await marketBet('DOWN', '1');
    // DOWN at 39 %: Logan $0.78 against Jake's $1.22
    expect(res.quote.stakes).toEqual({ a: '780000', b: '1220000', currency: 'USDC' });
    at(3_000);
    await phonesSign(betId);
    await expectAwaitingMarket(betId, res);
    const { ruling, bet } = await settleWith(betId, settledYes());
    expect(ruling.outcome).toBe('B_WINS'); // Gemini said yes; Jake held Up
    // Logan's phone: the pushed GG request, its own rendering of the card, the shared policy
    const g = await get(A, `/v1/bets/${betId}/concede`);
    expect(g.status).toBe(200);
    const req = SignRequest.parse(g.json);
    const renderedCard = renderSignCard({
      kind: 'concede',
      terms: req.envelope.terms,
      terms_hash: req.envelope.terms_hash,
      me: 'A',
      appeal_deadline: Math.floor(bet.appeal_deadline!.getTime() / 1000),
    });
    expect(renderedCard).toMatchObject({ odds_display: '39/61', stakes_line: '$0.78' });
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    const v = checkDevicePolicy(msg, {
      screen: 'gg',
      request: g.json,
      renderedCard,
      verifiedRulingHash: hashJcs(ruling),
      verifiedRulingOutcome: ruling.outcome,
      devicePubkey: A.wallet.pubkey,
      nowSecs: Math.floor(now() / 1000),
      derive: await derivations(betId),
      pins: pins(),
    });
    expect(v, JSON.stringify(v)).toMatchObject({ ok: true, kind: 'concede', party: 'A' });
    const post = await signed(A, 'POST', `/v1/bets/${betId}/concede`, {
      bet_id: betId,
      kind: 'concede',
      party: 'A',
      message_sha256: req.message_sha256,
      party_signature: b58.decode(ed.sign(msg, keyA.secret)),
      method: 'faceid_hold',
      signed_at: new Date(now()).toISOString(),
    });
    expect(post.status).toBe(202);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'concede' });
    expect(await usdc(signerA.address)).toBe(a0 - 780_000n);
    expect(await usdc(signerB.address)).toBe(b0 + 780_000n);
  });

  it('phones: the quote runs out before the second hold -> EXPIRED quote_expired, nothing moved', async () => {
    install('phones');
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const { betId, res } = await marketBet('UP', '5');
    await phonesSign(betId, ['A']); // only Logan holds
    expect((await betRow(betId)).state).toBe('AWAITING_AUTHORIZATIONS');
    // quotedAt + 55 s: expires_at passes
    at(Date.parse(res.quote.market.quotedAt) + 56_000 - T0237);
    const swept = await lc.lock.sweep(now());
    expect(swept.expired).toContain(betId);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'EXPIRED', end_reason: 'quote_expired' });
    const cue = (await dbEvents(betId))
      .map((e) => e.envelope as any)
      .filter((e) => e.type === 'judge.cue')
      .at(-1);
    expect(cue.payload).toMatchObject({ cue: 'EXPIRED' });
    expect(cue.payload.text).toMatch(/reason=quote_expired/);
    expect(await onchainBet(betId)).toBeNull();
    expect(await usdc(signerA.address)).toBe(a0);
    expect(await usdc(signerB.address)).toBe(b0);
    expect(svc.followed).not.toContain(betId);
  });

  // ---- the live driver, against this local server (never the live one) -------------------

  it('scripts/cp1-drive.ts --market down --through paid: market terms -> lock -> Gemini -> PAID', async () => {
    install('phones'); // the driver plays both phones with fresh wallets
    const w: [TestKey, KeyPairSigner][] = [];
    for (const k of [newKey(), newKey()]) {
      const s = await createKeyPairSignerFromPrivateKeyBytes(k.secret);
      await fund(s);
      w.push([k, s]);
    }
    const a0 = await usdc(w[0]![1].address);
    const b0 = await usdc(w[1]![1].address);
    const secret = (k: TestKey, s: KeyPairSigner) =>
      JSON.stringify([...k.secret, ...new Uint8Array(getAddressEncoder().encode(s.address))]);
    const stateFile = join(tmpdir(), `cp1-drive-${randomUUID()}.json`);
    // Play Gemini and the clock while the driver waits: once its bet is AWAITING_MARKET, Gemini
    // settles it (recorded "no": DOWN wins), the keeper rules, then the appeal window passes.
    let ticking = true;
    let settledBet: string | null = null;
    let out = '';
    const ticker = (async () => {
      while (ticking) {
        await new Promise((r) => setTimeout(r, 150));
        // Gemini settles once the driver is waiting for it (minutes later in real life).
        if (!out.includes('waiting for Gemini')) continue;
        const [waiting] = await ctx.deps.db
          .select({ id: bets.id })
          .from(bets)
          .where(eq(bets.state, 'AWAITING_MARKET'));
        if (waiting && settledBet === null) {
          settledBet = waiting.id;
          g.routes.set(eventPath(TICKER), F.event_0240_settled);
          at(T0240 + 6_000 - T0237);
          await svc.check(waiting.id);
          await settle();
        }
        const [ruled] = await ctx.deps.db
          .select({ id: bets.id })
          .from(bets)
          .where(eq(bets.state, 'RULED'));
        if (ruled) {
          at(offset + 12_000);
          await lc.payout.finalizeDue(now());
          await lc.idle();
        }
      }
    })();
    let code: number | null = null;
    try {
      code = await new Promise<number | null>((resolve) => {
        const child = spawn(
          'npx',
          [
            'tsx',
            'scripts/cp1-drive.ts',
            '--base-url',
            ctx.base,
            '--admin-token',
            ADMIN,
            '--state-file',
            stateFile,
            '--timeout',
            '30',
            '--market',
            'down',
            '--amount',
            '2',
            '--through',
            'paid',
            '--name-a',
            'Ava',
            '--name-b',
            'Ben',
          ],
          {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: {
              ...process.env,
              DEMO_A_SECRET_KEY: secret(...w[0]!),
              DEMO_B_SECRET_KEY: secret(...w[1]!),
            },
          },
        );
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (out += String(d)));
        child.on('close', (c) => {
          if (process.env.E2E_DEBUG) console.log(out);
          resolve(c);
        });
      });
    } finally {
      ticking = false;
      await ticker;
      rmSync(stateFile, { force: true });
      await settle();
    }
    expect(out).toContain('Gemini BTC05M2611180240');
    expect(out).toMatch(/TERMS_PROPOSED: DOWN at 0\.61/);
    expect(out).toContain('AWAITING_MARKET in');
    expect(out).toMatch(/Gemini settled: A_WINS/);
    expect(out).toMatch(/PAID via finalize/);
    expect(code, out).toBe(0);
    // Ava bet DOWN at 39 %: $1.56 against Ben's $2.44; Gemini said no, so Ava takes Ben's stake.
    expect(await usdc(w[0]![1].address)).toBe(a0 + 2_440_000n);
    expect(await usdc(w[1]![1].address)).toBe(b0 - 2_440_000n);
    expect((await betRow(settledBet!)).state).toBe('PAID');
  }, 120_000);
});
