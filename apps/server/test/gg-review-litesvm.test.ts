/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and event payloads are loose here */
// The GG moment and the spoken review request over HTTP + Postgres + LiteSVM running the real
// escrow.so (appeal window 10 s). The races, each against the program's own clock rules:
//
//   1. review asked, then the loser GGs: bet.gg (record 4-7 -> 5-7) in the CONCEDED commit, PAID
//      via=gg; a review asked after the GG is GG_CALLED; the open review never blocks the GG
//   2. review asked, the loser confirms (the normal appeal, before the cutoff) -> APPEALED;
//      finalize skips, the lapse is a no-op, the panel's resolve_appeal pays; GG is refused
//   3. review asked, nobody confirms: review.closed lapsed at confirm_by; finalize is refused
//      before appeal_deadline (chain clock), then pays: PAID via=timeout review=lapsed
//   4. asked inside the last 1.5 s before confirm_by: WINDOW_CLOSED, nothing is held
//   5. custodial signer (LOCK_SIGNER=server): the review is confirmed by the demo appeal route
//
// Its own database (<DATABASE_URL db>_ggreview): the payout sweeps here are global (every
// chain_txs row). Skips without DATABASE_URL or without programs/escrow/target/deploy/escrow.so.
import { createHash, randomUUID } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { betEvents, bets, noncePool, rulings } from '@youre-on/db';
import { SignRequest, type Session } from '@youre-on/shared/api';
import { AuthorizeRequest } from '@youre-on/shared/authorization';
import { BetStatus, findBetPda, getBetDecoder } from '@youre-on/shared/escrow-client';
import { BetGgPayload, REVIEW_MIN_LEAD_MS } from '@youre-on/shared/gg';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { betIdToBytes } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import type { Ruling } from '@youre-on/shared/ruling';
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
const ADMIN = 'demo-admin-token-gg';
const b58 = getBase58Decoder();

run('the GG moment + spoken review over LiteSVM (GG vs review vs appeal vs finalize)', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let lc: Lifecycle;
  let offset = 0;
  const now = () => Date.now() + offset;
  let keyA: TestKey;
  let keyB: TestKey;
  let A: SignedUp;
  let B: SignedUp;
  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;

  const install = (signer: 'phones' | 'server') => {
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => rt,
        signer,
        send: { pollMs: 5, resendMs: 50, timeoutMs: 2_000 },
        timers: false,
        // the mock panel answers at once; a roomy budget keeps a loaded CI run from abstaining
        appealVoteTimeoutMs: 1_000,
      }),
    );
  };
  /** Moves the server clock and the SVM clock together. */
  const advance = (ms: number) => {
    offset += ms;
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
  };

  beforeAll(async () => {
    ctx = await startTestServer({
      now,
      env: {
        DATABASE_URL: await ownDatabase(DB_URL!, 'ggreview'),
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
        ELEVENLABS_TOOL_SECRET: 'tool-secret',
      },
    });
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    keyA = newKey();
    keyB = newKey();
    signerA = await createKeyPairSignerFromPrivateKeyBytes(keyA.secret);
    signerB = await createKeyPairSignerFromPrivateKeyBytes(keyB.secret);
    for (const owner of [signerA, signerB]) {
      const [ata] = await findAssociatedTokenPda({
        owner: owner.address,
        mint: svm.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await send(svm.svm, svm.s, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: svm.s,
          owner: owner.address,
          mint: svm.mint,
        }),
        getMintToCheckedInstruction({
          mint: svm.mint,
          token: ata,
          mintAuthority: svm.s,
          amount: 100n * USDC,
          decimals: 6,
        }),
      ]);
    }
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
      programId: (await import('@youre-on/shared/escrow-client')).ESCROW_PROGRAM_ADDRESS,
      cluster: 'localnet',
    };
    await ctx.deps.db.delete(noncePool);
    install('phones');
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    A = await signUpWith('Logan', keyA);
    B = await signUpWith('Jake', keyB);
  });
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

  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, method, path, raw, { ts: now() }));
  };
  const get = async (u: SignedUp, path: string) => {
    const res = await fetch(ctx.base + path, {
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });
  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const events = async (id: string) =>
    (
      await ctx.deps.db
        .select()
        .from(betEvents)
        .where(eq(betEvents.bet_id, id))
        .orderBy(asc(betEvents.seq))
    ).map((e) => e.envelope as any);
  const onchainBet = async (betId: string) => {
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    const acc = svm.svm.getAccount(pda);
    return acc.exists ? getBetDecoder().decode(acc.data) : null;
  };
  const ata = async (owner: KeyPairSigner) =>
    (
      await findAssociatedTokenPda({
        owner: owner.address,
        mint: svm.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
    )[0];

  /** The pair's settled history (as seed-h2h writes it): A won `aWins`, B won `bWins`. */
  async function seedHistory(aWins: number, bWins: number) {
    const h = createHash('sha256');
    const rows = Array.from({ length: aWins + bWins }, (_, i) => {
      const aWon = i >= bWins; // B's wins first, A's last (A ends on a streak)
      const at = new Date(now() - (aWins + bWins + 1 - i) * 86_400_000);
      return {
        id: randomUUID(),
        party_a_id: A.session.user.user_id,
        party_b_id: B.session.user.user_id,
        party_a_wallet: signerA.address,
        party_b_wallet: signerB.address,
        challenge_method: 'face' as const,
        title: 'Demo history: Bottle flip',
        evidence_source: 'camera' as const,
        state: 'PAID' as const,
        onchain_status: 'settled' as const,
        mint: svm.mint,
        stake_a: 1_000_000n,
        stake_b: 1_000_000n,
        terms_hash: h.copy().update(String(i)).digest('hex'),
        outcome: aWon ? ('party_a' as const) : ('party_b' as const),
        payout_a: aWon ? 2_000_000n : 0n,
        payout_b: aWon ? 0n : 2_000_000n,
        payout_via: 'concede' as const,
        created_at: at,
        settled_at: at,
        is_seed: true,
      };
    });
    await ctx.deps.db.insert(bets).values(rows);
  }

  async function lockedBet(signer: 'phones' | 'server'): Promise<string> {
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'GG', kind: 'session' });
    expect((await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    expect((await admin(`/v1/demo/bets/${betId}/terms`)).json).toMatchObject({ ok: true });
    expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle();
    if (signer === 'phones') {
      const req = AuthorizeRequest.parse((await get(A, `/v1/bets/${betId}/lock`)).json);
      const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
      const auth = (party: 'A' | 'B', key: TestKey) => ({
        bet_id: betId,
        lock_request_id: req.lock_request_id,
        party,
        terms_hash: req.envelope.terms_hash,
        method: 'faceid_hold',
        authorized_at: new Date(now()).toISOString(),
        ms_since_auth_success: 120,
        message_sha256: req.message_sha256,
        party_signature: b58.decode(ed.sign(msg, key.secret)),
      });
      await signed(B, 'POST', `/v1/bets/${betId}/lock/authorizations`, auth('B', keyB));
      await signed(A, 'POST', `/v1/bets/${betId}/lock/authorizations`, auth('A', keyA));
      await lc.idle();
    }
    expect((await betRow(betId)).state).toBe('LOCKED');
    return betId;
  }

  function ruling(betId: string, termsHash: string, outcome: 'A_WINS' | 'B_WINS'): Ruling {
    return {
      schema_version: 1,
      ruling_id: randomUUID(),
      bet_id: betId,
      outcome,
      claim_result: outcome === 'A_WINS' ? 'NOT_MET' : 'MET',
      confidence: 0.93,
      reason: 'The bottle landed on its side in frame 2.',
      cited_frames: [0],
      frame_hashes: ['ab'.repeat(32)],
      model: 'anthropic/claude-test',
      evidence_hash: 'cd'.repeat(32),
      terms_hash: termsHash,
      created_at: new Date(now()).toISOString(),
      stage: 'attempt',
      attempt_no: 1,
      redo_reason: null,
      void_reason: null,
    };
  }

  /** LOCKED -> resolve -> RULED (and the appeal row on record, as the judge stream writes it). */
  async function ruled(betId: string, outcome: 'A_WINS' | 'B_WINS') {
    advance(0); // the SVM clock up to the server's
    const r = ruling(betId, (await betRow(betId)).terms_hash!, outcome);
    // The appeal filing needs the ruling row the judge stream stores at ruling.issued (a hearing
    // row here: an attempt row needs the attempts / frames the camera path writes).
    await ctx.deps.db.insert(rulings).values({
      id: r.ruling_id,
      bet_id: betId,
      stage: 'hearing',
      hearing_id: randomUUID(),
      model: r.model,
      outcome: r.outcome,
      claim_result: r.claim_result,
      confidence: r.confidence.toFixed(2),
      reason: r.reason,
      cited_frames: r.cited_frames,
      frame_hashes: r.frame_hashes,
      evidence_kind: 'camera',
      evidence_hash: r.evidence_hash,
      record_canonical: jcs(r),
      ruling_hash: hashJcs(r),
    });
    const res = await lc.payout.onRuling(betId, r);
    await lc.idle(); // the loser's GG + appeal prompts
    expect((await betRow(betId)).state).toBe('RULED');
    return res.appeal_deadline * 1000;
  }

  /** The loser's appeal on the phone: GET the request (or the pushed one), sign, POST. */
  async function appealAs(u: SignedUp, key: TestKey, betId: string, party: 'A' | 'B') {
    const g = await get(u, `/v1/bets/${betId}/appeal`);
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    const req = SignRequest.parse(g.json);
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    return signed(u, 'POST', `/v1/bets/${betId}/appeal`, {
      bet_id: betId,
      kind: 'appeal',
      party,
      message_sha256: req.message_sha256,
      party_signature: b58.decode(ed.sign(msg, key.secret)),
      method: 'faceid_hold',
      signed_at: new Date(now()).toISOString(),
    });
  }

  async function concedeAs(u: SignedUp, key: TestKey, betId: string, party: 'A' | 'B') {
    const g = await get(u, `/v1/bets/${betId}/concede`);
    if (g.status !== 200) return g;
    const req = SignRequest.parse(g.json);
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    return signed(u, 'POST', `/v1/bets/${betId}/concede`, {
      bet_id: betId,
      kind: 'concede',
      party,
      message_sha256: req.message_sha256,
      party_signature: b58.decode(ed.sign(msg, key.secret)),
      method: 'faceid_hold',
      signed_at: new Date(now()).toISOString(),
    });
  }

  it('1. review asked, then the loser GGs: bet.gg (4-7 -> 5-7) with CONCEDED, PAID via=gg; GG_CALLED after', async () => {
    await seedHistory(4, 7);
    const betId = await lockedBet('phones');
    await ruled(betId, 'A_WINS'); // Jake (B) lost
    const asked = await admin(`/v1/demo/bets/${betId}/review`);
    expect(asked.json).toMatchObject({ ok: true, review: { for_party: 'B' } });
    const reviewId = asked.json!.review.review_id;
    // The winner can't GG, and can't confirm the review (it is the loser's appeal).
    expect((await get(A, `/v1/bets/${betId}/concede`)).json!.error.code).toBe('NOT_LOSER');
    expect((await get(A, `/v1/bets/${betId}/appeal`)).json!.error.code).toBe('NOT_LOSER');
    const aBefore = await tokenAmount(svm.svm, (await ata(signerA)) as never);

    // An open review never blocks the GG (a review is not an appeal).
    const gg = await concedeAs(B, keyB, betId, 'B');
    expect(gg.status, JSON.stringify(gg.json)).toBe(202);
    await lc.idle();
    const row = await betRow(betId);
    expect(row).toMatchObject({ state: 'PAID', payout_via: 'concede' });
    expect((await tokenAmount(svm.svm, (await ata(signerA)) as never)) - aBefore).toBe(2n * USDC);

    const ev = await events(betId);
    for (const e of ev) expect([e.type, parseRealtimeEvent(e).ok]).toEqual([e.type, true]);
    // bet.gg rides the CONCEDED commit: bet.state CONCEDED, tx.submitted concede, bet.gg.
    const i = ev.findIndex((e) => e.type === 'bet.gg');
    expect(
      ev.slice(i - 2, i + 1).map((e) => [e.type, e.payload.state ?? e.payload.kind ?? null]),
    ).toEqual([
      ['bet.state', 'CONCEDED'],
      ['tx.submitted', 'concede'],
      ['bet.gg', null],
    ]);
    const p = BetGgPayload.parse(ev[i].payload);
    expect(p).toMatchObject({ by: 'B', winner: 'A', to_a: '2000000', to_b: '0' });
    expect(p.record!.before).toMatchObject({ a_wins: 4, b_wins: 7, total: 11, rival: true });
    expect(p.record!.before.streak).toEqual({ party: 'A', length: 4 });
    expect(p.record!.after).toMatchObject({ a_wins: 5, b_wins: 7, total: 12 });
    expect(p.record!.after.streak).toEqual({ party: 'A', length: 5 });
    // The voiced line knows it was a GG (sportsmanship), with the record after.
    const paid = ev.filter((e) => e.type === 'judge.cue' && e.payload.cue === 'PAID');
    expect(paid).toHaveLength(1);
    expect(paid[0].payload.text).toBe(
      '[EVENT] PAID winner=Logan amount=$2 to_a=$2 to_b=$0 via=gg loser=Jake record="Logan 5-7 Jake" :: Jake said GG. Praise the sportsmanship in one short line, then congratulate Logan.',
    );
    // No review.closed for a GG (the GG closes it on the clients); the lapse is a no-op.
    expect(ev.some((e) => e.type === 'review.closed')).toBe(false);
    expect(await lc.review.lapse(betId, reviewId)).toBe(false);
    // Asked again after the GG: the judge declines politely.
    expect(await lc.review.request(betId, { source: 'voice' })).toMatchObject({
      ok: false,
      fix: 'GG_CALLED',
    });
  });

  it('1b. GG first, review second (the lock order): GG_CALLED while CONCEDED', async () => {
    const betId = await lockedBet('phones');
    await ruled(betId, 'B_WINS'); // Logan (A) lost
    // The GG lands first (CONCEDED, its confirm still in the background), then the ask.
    const g = await get(A, `/v1/bets/${betId}/concede`);
    const req = SignRequest.parse(g.json);
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    const posted = signed(A, 'POST', `/v1/bets/${betId}/concede`, {
      bet_id: betId,
      kind: 'concede',
      party: 'A',
      message_sha256: req.message_sha256,
      party_signature: b58.decode(ed.sign(msg, keyA.secret)),
      method: 'faceid_hold',
      signed_at: new Date(now()).toISOString(),
    });
    expect((await posted).status).toBe(202);
    const r = await lc.review.request(betId, { source: 'voice' });
    expect(r).toMatchObject({ ok: false, fix: 'GG_CALLED' });
    await lc.idle();
    expect((await betRow(betId)).state).toBe('PAID');
    expect(await lc.review.request(betId, { source: 'voice' })).toMatchObject({
      ok: false,
      fix: 'GG_CALLED', // PAID with payout_via concede
    });
  });

  it('2. review asked, the loser confirms before the cutoff -> APPEALED; finalize skips; the panel pays; GG refused', async () => {
    const betId = await lockedBet('phones');
    const deadline = await ruled(betId, 'A_WINS'); // Jake (B) lost
    const asked = await lc.review.request(betId, { source: 'voice', heard: 'check that again' });
    expect(asked.ok).toBe(true);
    const reviewId = asked.ok ? asked.review.review_id : '';
    expect(asked.ok && Date.parse(asked.review.confirm_by)).toBe(deadline - 1_000);
    advance(3_000); // Face ID on the loser's phone
    const post = await appealAs(B, keyB, betId, 'B');
    expect(post.status, JSON.stringify(post.json)).toBe(202);
    // Racing it: finalize skips (the appeal is out), the GG is refused, the lapse is a no-op.
    expect(await lc.payout.finalize(betId)).toBe('skipped');
    const gg = await concedeAs(B, keyB, betId, 'B');
    expect(gg.json!.error.code).toBe('STATE_MOVED_ON');
    expect(await lc.review.lapse(betId, reviewId)).toBe(false);
    expect(await lc.review.request(betId, { source: 'voice' })).toMatchObject({
      ok: false,
      fix: 'WITH_PANEL',
    });
    await lc.idle(); // Appealed confirms -> panel (mock votes) -> resolve_appeal -> PAID
    const row = await betRow(betId);
    expect(row).toMatchObject({ payout_via: 'resolve_appeal' });
    expect(['PAID', 'VOIDED']).toContain(row.state);
    const ev = await events(betId);
    expect(ev.some((e) => e.type === 'review.closed')).toBe(false); // confirmed = the appeal
    expect(ev.filter((e) => e.type === 'tx.submitted').map((e) => e.payload.kind)).toContain(
      'appeal',
    );
    expect(ev.some((e) => e.type === 'appeal.result')).toBe(true);
    // The appeal's PAID line keeps its own wording (no via).
    const paid = ev.filter((e) => e.type === 'judge.cue' && e.payload.cue === 'PAID');
    for (const c of paid) expect(c.payload.text).not.toContain('via=');
    expect(await onchainBet(betId)).toBeNull();
  });

  it('3. review asked, nobody confirms: lapsed at confirm_by; no finalize before appeal_deadline; PAID via=timeout review=lapsed', async () => {
    const betId = await lockedBet('phones');
    const deadline = await ruled(betId, 'B_WINS'); // Logan (A) lost
    const asked = await lc.review.request(betId, { source: 'voice' });
    expect(asked).toMatchObject({ ok: true, review: { for_party: 'A' } });
    const reviewId = asked.ok ? asked.review.review_id : '';
    // At confirm_by the review lapses (the lapse timer's job; timers are off here).
    advance(deadline - 1_000 - now());
    expect(await lc.review.lapse(betId, reviewId)).toBe(true);
    expect(await lc.review.request(betId, { source: 'voice' })).toMatchObject({
      ok: false,
      fix: 'ONE_REVIEW',
    });
    // The appeal cutoff is the same instant: the loser can't confirm any more.
    expect((await get(A, `/v1/bets/${betId}/appeal`)).json!.error.code).toBe(
      'APPEAL_WINDOW_CLOSED',
    );
    // Finalize before appeal_deadline: refused by the chain clock, the bet stays RULED.
    advance(500);
    expect(await lc.payout.finalize(betId)).toBe('not_due');
    expect((await betRow(betId)).state).toBe('RULED');
    expect((await onchainBet(betId))!.status).toBe(BetStatus.Resolved);
    advance(2_000);
    expect(await lc.payout.finalizeDue(now())).toEqual([betId]);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'finalize' });
    const ev = await events(betId);
    expect(ev.filter((e) => e.type === 'review.closed').map((e) => e.payload.reason)).toEqual([
      'lapsed',
    ]);
    const paid = ev.filter((e) => e.type === 'judge.cue' && e.payload.cue === 'PAID');
    expect(paid.map((e) => e.payload.text)).toEqual([
      '[EVENT] PAID winner=Jake amount=$2 to_a=$0 to_b=$2 via=timeout loser=Logan review=lapsed :: Logan did not confirm the review, so the ruling stands. Congratulate Jake in one line.',
    ]);
    expect(ev.some((e) => e.type === 'bet.gg')).toBe(false);
    expect(await lc.review.request(betId, { source: 'voice' })).toMatchObject({
      ok: false,
      fix: 'FINAL',
    });
  });

  it('4. asked in the last 1.5 s before confirm_by: WINDOW_CLOSED, nothing held; a silent ruling pays via=timeout', async () => {
    const betId = await lockedBet('phones');
    const deadline = await ruled(betId, 'A_WINS');
    advance(deadline - 1_000 - REVIEW_MIN_LEAD_MS + 100 - now());
    expect(await lc.review.request(betId, { source: 'voice' })).toMatchObject({
      ok: false,
      fix: 'WINDOW_CLOSED',
    });
    expect((await events(betId)).some((e) => e.type.startsWith('review.'))).toBe(false);
    advance(deadline + 1_100 - now());
    expect(await lc.payout.finalizeDue(now())).toEqual([betId]);
    await lc.idle();
    const paid = (await events(betId)).filter(
      (e) => e.type === 'judge.cue' && e.payload.cue === 'PAID',
    );
    expect(paid[0].payload.text).toBe(
      '[EVENT] PAID winner=Logan amount=$2 to_a=$2 to_b=$0 via=timeout loser=Jake :: No GG from Jake; the clock ran out. Congratulate Logan in one line.',
    );
  });

  it('5. custodial signer: a review confirmed through the demo appeal route -> APPEALED -> paid by the panel', async () => {
    install('server');
    try {
      const betId = await lockedBet('server');
      await ruled(betId, 'B_WINS'); // Logan (A) lost
      const asked = await admin(`/v1/demo/bets/${betId}/review`);
      expect(asked.json).toMatchObject({
        ok: true,
        say: 'Review requested. Logan, confirm on your phone.',
      });
      const filed = await admin(`/v1/demo/bets/${betId}/appeal`, {});
      expect(filed.status, JSON.stringify(filed.json)).toBe(202);
      expect(await lc.payout.finalize(betId)).toBe('skipped');
      await lc.idle();
      expect((await betRow(betId)).payout_via).toBe('resolve_appeal');
      expect(
        (await events(betId)).some(
          (e) =>
            e.type === 'review.closed' || (e.type === 'judge.cue' && /via=/.test(e.payload.text)),
        ),
      ).toBe(false);
    } finally {
      install('phones');
    }
  });

  it('a decline (Keep ruling) then the clock: PAID via=timeout review=declined', async () => {
    const betId = await lockedBet('phones');
    const deadline = await ruled(betId, 'A_WINS'); // Jake (B) lost
    expect((await lc.review.request(betId, { source: 'voice' })).ok).toBe(true);
    const path = `/v1/bets/${betId}/review/decline`;
    expect((await signed(A, 'POST', path)).json!.error.code).toBe('NOT_LOSER');
    expect((await signed(B, 'POST', path)).json).toEqual({ status: 'closed' });
    // The original window rules resume: the loser may still tap "I appeal!" or GG until the cutoff.
    expect((await get(B, `/v1/bets/${betId}/appeal`)).status).toBe(200);
    advance(deadline + 1_100 - now());
    expect(await lc.payout.finalizeDue(now())).toEqual([betId]);
    await lc.idle();
    const paid = (await events(betId)).filter(
      (e) => e.type === 'judge.cue' && e.payload.cue === 'PAID',
    );
    expect(paid[0].payload.text).toMatch(
      /via=timeout loser=Jake review=declined :: Jake kept the ruling\./,
    );
  });

  it('the bet events of every scenario parse with the shared wire contract', async () => {
    const all = await ctx.deps.db
      .select()
      .from(betEvents)
      .where(and(eq(betEvents.type, 'bet.gg')));
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(parseRealtimeEvent(e.envelope).ok).toBe(true);
  });
});
