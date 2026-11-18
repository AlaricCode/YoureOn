/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// Beats 2-4 money path end to end, over HTTP + Postgres + LiteSVM running the real escrow.so:
// list challenge -> fixture terms (the propose_terms sink) -> confirm -> atomic lock (phones sign
// the stored bytes, or the custodial demo keys) -> LOCKED -> onRuling (resolve) -> RULED ->
// GG (concede) or finalize after the appeal window -> PAID; decline -> nonce revoke; balance.
// Skips without DATABASE_URL or without programs/escrow/target/deploy/escrow.so.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { bets, betTermsVersions, chainTxs, noncePool } from '@youre-on/db';
import { SignRequest, type Session } from '@youre-on/shared/api';
import { AuthorizeRequest } from '@youre-on/shared/authorization';
import { BetStatus, findBetPda, getBetDecoder } from '@youre-on/shared/escrow-client';
import { hashJcs } from '@youre-on/shared/jcs';
import { betIdToBytes } from '@youre-on/shared/primitives';
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
import { betsColumnLockSignatures } from '../src/chain/projector';
import type { ChainClient, ChainRuntime } from '../src/chain/tx';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { createPayoutService } from '../src/payout';
import { createLogger } from '../src/log';
import { DEMO_TERMS_ARGS } from '../src/demo/routes';
import {
  bottleFlipClaim,
  termsConfirmPath,
  typedTermsPath,
  typedTermsRequest,
} from '@youre-on/shared/judge/typed-terms';
import { liteSvmClient } from './litesvm-client';
import {
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
} from './helpers';

const run = DB_URL && HAVE_SO ? describe : describe.skip;
const ADMIN = 'demo-admin-token-for-tests';
const b58 = getBase58Decoder();

run('chain lifecycle over LiteSVM (lock -> resolve -> payout)', () => {
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

  /** A fresh lifecycle (also: "the server restarted"), optionally over a different client. */
  const install = (
    signer: 'phones' | 'server',
    o: { client?: ChainClient; timeoutMs?: number } = {},
  ) => {
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => (o.client ? { ...rt, client: o.client } : rt),
        signer,
        send: { pollMs: 5, resendMs: 50, timeoutMs: o.timeoutMs ?? 2_000 },
        timers: false,
      }),
    );
  };

  /**
   * The LiteSVM client with RPC trouble: `hide` makes every status lookup come back null (an
   * evicted status cache / a lost confirm), `drop` swallows sends (recorded in `dropped`).
   */
  const flaky = (o: { hide?: () => boolean; drop?: () => boolean }) => {
    const base = rt.client;
    const dropped: Base64EncodedWireTransaction[] = [];
    const client: ChainClient = {
      ...base,
      signatureStatus: async (sig, opts) => (o.hide?.() ? null : base.signatureStatus(sig, opts)),
      send: async (wire, skip) => {
        if (o.drop?.()) {
          dropped.push(wire);
          return;
        }
        return base.send(wire, skip);
      },
    };
    return { client, dropped, base };
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
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
        ELEVENLABS_TOOL_SECRET: 'tool-secret',
      },
    });
    if (process.env.LIFECYCLE_DEBUG) ctx.deps.log = createLogger('debug');
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    // Party wallets whose secrets the "phones" hold (noble), funded with 100 test USDC each.
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
    // This suite owns nonce_pool in its database: start from the SVM's pool.
    await ctx.deps.db.delete(noncePool);
    install('phones');
    // bets.mint comes from USDC_MINT at challenge time.
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
    // A wallet registered by an earlier run of this suite is fine to reuse: fresh keys each run.
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

  async function proposedBet(): Promise<string> {
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'Lifecycle', kind: 'session' });
    expect(room.status).toBe(201);
    expect((await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    const terms = await admin(`/v1/demo/bets/${betId}/terms`);
    expect(terms.status).toBe(200);
    expect(terms.json).toMatchObject({ ok: true, state: 'TERMS_PROPOSED' });
    return betId;
  }

  async function lockedBetPhones(): Promise<{ betId: string; lockSig: string }> {
    const betId = await proposedBet();
    const conf = await admin(`/v1/demo/bets/${betId}/confirm`);
    expect(conf.json).toMatchObject({ ok: true });
    await lc.idle();
    const reqA = await get(A, `/v1/bets/${betId}/lock`);
    expect(reqA.status).toBe(200);
    const req = AuthorizeRequest.parse(reqA.json); // re-checks the envelope hash + expires_at rule
    const reqB = await get(B, `/v1/bets/${betId}/lock`);
    expect(reqB.json).toEqual(reqA.json); // identical payload for both phones
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
    // B first (either order works).
    const first = await signed(B, 'POST', `/v1/bets/${betId}/lock/authorizations`, auth('B', keyB));
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ status: 'recorded', waiting_for: 'A' });
    // A repeat is idempotent.
    const again = await signed(B, 'POST', `/v1/bets/${betId}/lock/authorizations`, auth('B', keyB));
    expect(again.json).toEqual({ status: 'recorded', waiting_for: 'A' });
    const second = await signed(
      A,
      'POST',
      `/v1/bets/${betId}/lock/authorizations`,
      auth('A', keyA),
    );
    expect(second.status).toBe(202);
    expect(second.json!.status).toBe('submitted');
    await lc.idle();
    return { betId, lockSig: second.json!.signature as string };
  }

  function ruling(betId: string, termsHash: string, outcome: 'A_WINS' | 'B_WINS' | 'VOID'): Ruling {
    return {
      schema_version: 1,
      ruling_id: randomUUID(),
      bet_id: betId,
      outcome,
      claim_result: outcome === 'A_WINS' ? 'NOT_MET' : outcome === 'B_WINS' ? 'MET' : 'UNCLEAR',
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
      void_reason: outcome === 'VOID' ? 'max_redos' : null,
    };
  }

  const onchainBet = async (betId: string) => {
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    const acc = svm.svm.getAccount(pda);
    return acc.exists ? getBetDecoder().decode(acc.data) : null;
  };

  it('phones: terms -> confirm -> both sign the stored bytes -> ONE atomic lock -> LOCKED', async () => {
    const { betId, lockSig } = await lockedBetPhones();
    const row = await betRow(betId);
    expect(row.state).toBe('LOCKED');
    expect(row.onchain_pending).toBe('locked');
    expect(row.pending_sig).toBe(lockSig);
    expect(row.party_a_wallet).toBe(signerA.address);
    expect(row.party_b_wallet).toBe(signerB.address);
    expect(row.a_authorization_method).toBe('faceid_hold');
    expect(row.a_authorized_device_at).not.toBeNull();
    const [v] = await ctx.deps.db
      .select()
      .from(betTermsVersions)
      .where(and(eq(betTermsVersions.bet_id, betId), eq(betTermsVersions.is_final, true)));
    expect(v!.terms_hash).toBe(row.terms_hash);
    const [lock] = await ctx.deps.db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, 'atomic_lock')));
    expect(lock).toMatchObject({ status: 'confirmed', signature: lockSig, first_signer: 'B' });
    // On chain: Locked with both stakes in the vault, the terms hash committed.
    const onchain = await onchainBet(betId);
    expect(onchain!.status).toBe(BetStatus.Locked);
    expect(Buffer.from(onchain!.termsHash).toString('hex')).toBe(row.terms_hash);
    expect(onchain!.stakeA).toBe(1n * USDC);
    // The nonce went back to the pool with its advanced value.
    const pool = await ctx.deps.db.select().from(noncePool);
    const used = pool.find((n) => n.nonce_account === lock!.nonce_account)!;
    expect(used.status).toBe('free');
    expect(used.nonce_value).not.toBe(lock!.nonce_value);
    // The stub projector still attributes this bet's chain events to our lock.
    const sigs = await ctx.deps.db.transaction((tx) => betsColumnLockSignatures(tx, [betId]));
    expect(sigs.get(betId)).toBe(lockSig);
  });

  it('wrong signer -> SIGNATURE_INVALID; stale lock_request_id -> STALE_LOCK_REQUEST', async () => {
    const betId = await proposedBet();
    await admin(`/v1/demo/bets/${betId}/confirm`);
    await lc.idle();
    const req = AuthorizeRequest.parse((await get(A, `/v1/bets/${betId}/lock`)).json);
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    const body = {
      bet_id: betId,
      lock_request_id: req.lock_request_id,
      party: 'A',
      terms_hash: req.envelope.terms_hash,
      method: 'faceid_hold',
      authorized_at: new Date(now()).toISOString(),
      ms_since_auth_success: 50,
      message_sha256: req.message_sha256,
      party_signature: b58.decode(ed.sign(msg, keyB.secret)),
    };
    const bad = await signed(A, 'POST', `/v1/bets/${betId}/lock/authorizations`, body);
    expect(bad.json!.error.code).toBe('SIGNATURE_INVALID');
    const stale = await signed(A, 'POST', `/v1/bets/${betId}/lock/authorizations`, {
      ...body,
      lock_request_id: randomUUID(),
    });
    expect(stale.json!.error.code).toBe('STALE_LOCK_REQUEST');
    const notMine = await signed(B, 'POST', `/v1/bets/${betId}/lock/authorizations`, body);
    expect(notMine.json!.error.code).toBe('NOT_A_PARTY');
    // Decline: CANCELLED, the nonce advanced (every held signature is now useless), back to free.
    const dec = await signed(B, 'POST', `/v1/bets/${betId}/lock/decline`, {
      bet_id: betId,
      party: 'B',
      lock_request_id: req.lock_request_id,
      declined_at: new Date(now()).toISOString(),
    });
    expect(dec.status).toBe(200);
    await lc.idle();
    const row = await betRow(betId);
    expect(row).toMatchObject({ state: 'CANCELLED', end_reason: 'declined' });
    const txs = await ctx.deps.db.select().from(chainTxs).where(eq(chainTxs.bet_id, betId));
    const lock = txs.find((t) => t.kind === 'atomic_lock')!;
    const adv = txs.find((t) => t.kind === 'nonce_advance')!;
    expect(adv.status).toBe('confirmed');
    expect(lock).toMatchObject({ status: 'revoked', revoked_by_tx_id: adv.id });
    const [n] = await ctx.deps.db
      .select()
      .from(noncePool)
      .where(eq(noncePool.nonce_account, lock.nonce_account!));
    expect(n!.status).toBe('free');
    expect(n!.nonce_value).not.toBe(lock.nonce_value);
    expect(await onchainBet(betId)).toBeNull(); // nothing ever went onchain
  });

  it('resolve (judge + fee payer) -> RULED; the loser GGs on the phone -> concede+close -> PAID', async () => {
    const { betId } = await lockedBetPhones();
    const row = await betRow(betId);
    const aBefore = await tokenAmount(svm.svm, (await findAta(signerA)) as never);
    const r = await createPayoutService(ctx.deps).onRuling(
      betId,
      ruling(betId, row.terms_hash!, 'A_WINS'),
    );
    expect(r.already).toBe(false);
    const ruled = await betRow(betId);
    expect(ruled.state).toBe('RULED');
    expect(ruled.outcome).toBe('party_a');
    expect(Math.floor(ruled.appeal_deadline!.getTime() / 1000)).toBe(r.appeal_deadline);
    const onchain = await onchainBet(betId);
    expect(onchain!.status).toBe(BetStatus.Resolved);
    expect(Buffer.from(onchain!.rulingHash).toString('hex')).toBe(ruled.ruling_hash);
    // idempotent
    expect(
      (await lc.payout.onRuling(betId, ruling(betId, row.terms_hash!, 'A_WINS'))).already,
    ).toBe(true);
    await lc.idle(); // the loser's tx.sign_request

    // Only the loser may concede.
    expect((await get(A, `/v1/bets/${betId}/concede`)).json!.error.code).toBe('NOT_LOSER');
    const g = await get(B, `/v1/bets/${betId}/concede`);
    expect(g.status).toBe(200);
    const req = SignRequest.parse(g.json);
    expect(req.for_parties).toEqual(['B']);
    expect(req.signers).toContain(signerB.address);
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    const post = await signed(B, 'POST', `/v1/bets/${betId}/concede`, {
      bet_id: betId,
      kind: 'concede',
      party: 'B',
      message_sha256: req.message_sha256,
      party_signature: b58.decode(ed.sign(msg, keyB.secret)),
      method: 'faceid_hold',
      signed_at: new Date(now()).toISOString(),
    });
    expect(post.status).toBe(202);
    expect(post.json!.status).toBe('submitted');
    await lc.idle();
    const paid = await betRow(betId);
    expect(paid).toMatchObject({ state: 'PAID', payout_via: 'concede' });
    expect(await onchainBet(betId)).toBeNull(); // close_bet closed it
    const aAfter = await tokenAmount(svm.svm, (await findAta(signerA)) as never);
    expect(aAfter - aBefore).toBe(2n * USDC); // the whole pot
    // Still attributed to the lock for the projector.
    const sigs = await ctx.deps.db.transaction((tx) => betsColumnLockSignatures(tx, [betId]));
    expect(sigs.get(betId)).toBe(paid.pending_sig);
  });

  it('custodial (LOCK_SIGNER=server): confirm locks by itself; finalize after the appeal window -> PAID', async () => {
    install('server');
    try {
      const betId = await proposedBet();
      expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
      await lc.idle();
      const row = await betRow(betId);
      expect(row.state).toBe('LOCKED');
      // CHECK-compatible custodial authorizations: both set, no device time.
      expect(row.a_authorized_at).not.toBeNull();
      expect(row.b_authorized_at).not.toBeNull();
      expect(row.a_authorized_device_at).toBeNull();
      const bBefore = await tokenAmount(svm.svm, (await findAta(signerB)) as never);
      await lc.payout.onRuling(betId, ruling(betId, row.terms_hash!, 'B_WINS'));
      expect((await betRow(betId)).state).toBe('RULED');
      // Not due yet.
      expect(await lc.payout.finalizeDue(now())).toEqual([]);
      advance(12_000);
      expect(await lc.payout.finalizeDue(now())).toEqual([betId]);
      await lc.idle();
      const paid = await betRow(betId);
      expect(paid).toMatchObject({ state: 'PAID', payout_via: 'finalize' });
      const bAfter = await tokenAmount(svm.svm, (await findAta(signerB)) as never);
      expect(bAfter - bBefore).toBe(2n * USDC);
      expect(await onchainBet(betId)).toBeNull();
    } finally {
      install('phones');
    }
  });

  it('typed path (LOCK_SIGNER=server): A types the terms, taps Lock it in -> LOCKED', async () => {
    install('server');
    try {
      const room = await signed(A, 'POST', '/v1/rooms', { name: 'Typed', kind: 'session' });
      await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code });
      const bet = await signed(A, 'POST', '/v1/bets', {
        room_id: room.json!.room_id,
        opponent_user_id: B.session.user.user_id,
        challenge_method: 'list',
      });
      const betId = bet.json!.bet.bet_id as string;
      // B answers the challenge first: the custodial lock signs for B only after B said yes.
      expect((await signed(B, 'POST', `/v1/bets/${betId}/invite/accept`, {})).status).toBe(200);
      const p = await signed(
        A,
        'POST',
        typedTermsPath(betId),
        typedTermsRequest({ claim: bottleFlipClaim('Jake'), stakeUsd: 1, bName: 'Jake' }),
      );
      expect(p.status).toBe(200);
      expect(p.json).toMatchObject({ ok: true, kind: 'proposed', state: 'TERMS_PROPOSED' });
      const c = await signed(A, 'POST', termsConfirmPath(betId), {
        terms_hash: p.json!.terms_hash,
      });
      expect(c.status).toBe(200);
      expect(c.json).toMatchObject({ ok: true, code: p.json!.code });
      await lc.idle();
      const row = await betRow(betId);
      expect(row.state).toBe('LOCKED');
      expect(row.terms_hash).toBe(p.json!.terms_hash);
      expect(row.stake_a).toBe(1_000_000n);
      const onchain = await onchainBet(betId);
      expect(onchain?.status).toBe(BetStatus.Locked);
    } finally {
      install('phones');
    }
  });

  it('voice path: propose_terms (real sink) -> terms.proposed; confirm_terms -> lock built', async () => {
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'Voice', kind: 'session' });
    await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code });
    const conv = `conv_${randomUUID()}`;
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
      voice_conversation_id: conv,
    });
    const betId = bet.json!.bet.bet_id as string;
    const tool = (name: string, body: object) =>
      postJson(
        ctx.base,
        `/el/tools/${name}`,
        { conversation_id: conv, bet_id: betId, ...body },
        {
          'X-YO-Tool-Secret': 'tool-secret',
        },
      );
    // Before any proposal, confirm has nothing to freeze.
    expect((await tool('confirm_terms', { heard: 'both' })).json).toMatchObject({
      ok: false,
      fix: 'NOT_PROPOSED',
    });
    const {
      conversation_id: _c,
      bet_id: _b,
      ...args
    } = {
      conversation_id: '',
      bet_id: '',
      ...DEMO_TERMS_ARGS,
      claim: 'Jake lands a water bottle flip upright on the table.',
    };
    const p = await tool('propose_terms', args);
    expect(p.json).toMatchObject({ ok: true, next: 'readback' });
    await expect.poll(async () => (await betRow(betId)).state).toBe('TERMS_PROPOSED');
    const row = await betRow(betId);
    expect(row.party_a_wallet).toBe(signerA.address);
    expect(row.stake_a).toBe(1_000_000n);
    const c = await tool('confirm_terms', { heard: 'both' });
    expect(c.json).toMatchObject({
      ok: true,
      code: `${row.terms_hash!.slice(0, 4)}·${row.terms_hash!.slice(4, 8)}`,
    });
    expect(c.json!.say).toContain('Logan, Jake: hold the button');
    await lc.idle();
    expect((await betRow(betId)).state).toBe('AWAITING_AUTHORIZATIONS');
    const lock = await get(B, `/v1/bets/${betId}/lock`);
    expect(lock.status).toBe(200);
    // A second confirm is a no-op that answers the same code.
    expect((await tool('confirm_terms', { heard: 'A' })).json).toMatchObject({ ok: true });
    // tidy: decline so the pair is free again
    await signed(A, 'POST', `/v1/bets/${betId}/lock/decline`, {
      bet_id: betId,
      party: 'A',
      lock_request_id: lock.json!.lock_request_id,
      declined_at: new Date(now()).toISOString(),
    });
    await lc.idle();
  });

  it('lock window: past expires_at the sweep expires the bet and revokes the nonce', async () => {
    const betId = await proposedBet();
    await admin(`/v1/demo/bets/${betId}/confirm`);
    await lc.idle();
    const lock = AuthorizeRequest.parse((await get(A, `/v1/bets/${betId}/lock`)).json);
    expect((await lc.lock.sweep(now())).expired).toEqual([]);
    advance(296_000); // accept_deadline - 5 s has passed
    const r = await lc.lock.sweep(now());
    expect(r.expired).toContain(betId);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'EXPIRED', end_reason: 'accept_timeout' });
    const [row] = await ctx.deps.db
      .select()
      .from(chainTxs)
      .where(eq(chainTxs.id, lock.lock_request_id));
    expect(row!.status).toBe('revoked');
    // A signature after expiry is refused.
    const msg = new Uint8Array(Buffer.from(lock.message_b64, 'base64'));
    const late = await signed(A, 'POST', `/v1/bets/${betId}/lock/authorizations`, {
      bet_id: betId,
      lock_request_id: lock.lock_request_id,
      party: 'A',
      terms_hash: lock.envelope.terms_hash,
      method: 'faceid_hold',
      authorized_at: new Date(now()).toISOString(),
      ms_since_auth_success: 10,
      message_sha256: lock.message_sha256,
      party_signature: b58.decode(ed.sign(msg, keyA.secret)),
    });
    expect(['LOCK_REVOKED', 'LOCK_EXPIRED']).toContain(late.json!.error.code);
  });

  // ---- recovery: a tx that landed although its confirm was lost (review findings) -----------

  const txRow = async (betId: string, kind: 'atomic_lock' | 'resolve' | 'finalize') =>
    (
      await ctx.deps.db
        .select()
        .from(chainTxs)
        .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, kind)))
        .orderBy(chainTxs.built_at)
    ).at(-1)!;

  /** LOCKED -> resolve -> finalize after the appeal window -> PAID (frees the pair again). */
  async function payOut(betId: string) {
    const row = await betRow(betId);
    await lc.payout.onRuling(betId, ruling(betId, row.terms_hash!, 'A_WINS'));
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect((await betRow(betId)).state).toBe('PAID');
  }

  it('lock landed but its status was lost (restart): at expires_at the sweep adopts it, not expires it', async () => {
    const f = flaky({ hide: () => true });
    install('phones', { client: f.client, timeoutMs: 30 });
    let betId: string;
    try {
      const locked = await lockedBetPhones(); // the confirm loop times out: status never seen
      betId = locked.betId;
      expect((await betRow(betId)).state).toBe('AWAITING_LOCK');
      expect((await txRow(betId, 'atomic_lock')).status).toBe('sent');
      expect((await onchainBet(betId))!.status).toBe(BetStatus.Locked); // it did land
      install('phones', { client: f.client }); // "restart": the confirm loop is gone
      expect(await lc.lock.sweep(now())).toEqual({ expired: [], landed: [] });
      advance(296_000); // past expires_at, status still unknown
      const r = await lc.lock.sweep(now());
      expect(r.landed).toContain(betId);
      expect(r.expired).not.toContain(betId);
      await lc.idle();
      expect(await betRow(betId)).toMatchObject({ state: 'LOCKED', pending_sig: locked.lockSig });
      const lock = await txRow(betId, 'atomic_lock');
      expect(lock.status).toBe('confirmed');
      const [n] = await ctx.deps.db
        .select()
        .from(noncePool)
        .where(eq(noncePool.nonce_account, lock.nonce_account!));
      expect(n!.status).toBe('free'); // no revoke was sent for a landed lock
      expect(
        (await ctx.deps.db.select().from(chainTxs).where(eq(chainTxs.bet_id, betId))).map(
          (t) => t.kind,
        ),
      ).not.toContain('nonce_advance');
    } finally {
      install('phones');
    }
    await payOut(betId);
  });

  it('the chain wins: a confirmed lock moves an EXPIRED bet to LOCKED', async () => {
    let hide = true;
    const f = flaky({ hide: () => hide });
    install('phones', { client: f.client, timeoutMs: 30 });
    let betId: string;
    try {
      betId = (await lockedBetPhones()).betId;
      // What the old sweep did while the lock was in flight.
      await ctx.deps.db
        .update(bets)
        .set({ state: 'EXPIRED', end_reason: 'accept_timeout' })
        .where(eq(bets.id, betId));
      hide = false;
      const r = await lc.lock.sweep(now());
      expect(r.landed).toContain(betId);
      expect(await betRow(betId)).toMatchObject({
        state: 'LOCKED',
        end_reason: null,
        onchain_status: 'locked',
        onchain_pending: 'locked',
      });
    } finally {
      install('phones');
    }
    await payOut(betId);
  });

  it('a sent lock that never landed: expired + revoked at expires_at, then marked expired', async () => {
    let drop = true;
    const f = flaky({ drop: () => drop });
    install('phones', { client: f.client, timeoutMs: 30 });
    let betId: string;
    try {
      betId = (await lockedBetPhones()).betId;
    } finally {
      drop = false;
      install('phones');
    }
    expect(f.dropped.length).toBeGreaterThan(0);
    expect((await betRow(betId)).state).toBe('AWAITING_LOCK');
    expect(await onchainBet(betId)).toBeNull();
    advance(296_000);
    const r = await lc.lock.sweep(now());
    expect(r.expired).toContain(betId);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'EXPIRED', end_reason: 'accept_timeout' });
    expect((await txRow(betId, 'atomic_lock')).status).toBe('sent'); // fate not proven yet
    // The revoke consumed the nonce value and no Bet exists: the lock can never land.
    await lc.lock.sweep(now());
    const lock = await txRow(betId, 'atomic_lock');
    expect(lock.status).toBe('expired');
    const [n] = await ctx.deps.db
      .select()
      .from(noncePool)
      .where(eq(noncePool.nonce_account, lock.nonce_account!));
    expect(n!.status).toBe('free');
    // The stored signatures are dead: replaying the dropped lock now fails.
    await expect(f.base.send(f.dropped[0]!, false)).rejects.toThrow();
  });

  it('finalize confirm timeout: the bet stays FINALIZED; reconcile settles the landed tx -> PAID', async () => {
    const { betId } = await lockedBetPhones();
    const row = await betRow(betId);
    await lc.payout.onRuling(betId, ruling(betId, row.terms_hash!, 'B_WINS'));
    advance(12_000);
    let hide = true;
    const f = flaky({ hide: () => hide });
    install('phones', { client: f.client, timeoutMs: 30 });
    try {
      expect(await lc.payout.finalizeDue(now())).not.toContain(betId);
      await lc.idle();
      expect((await betRow(betId)).state).toBe('FINALIZED'); // not reverted to RULED
      expect(await onchainBet(betId)).toBeNull(); // it landed: close_bet closed the PDA
      expect((await txRow(betId, 'finalize')).status).toBe('sent');
      hide = false;
      expect(await lc.payout.finalizeDue(now())).toContain(betId);
      await lc.idle();
      expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'finalize' });
      expect((await txRow(betId, 'finalize')).status).toBe('confirmed');
    } finally {
      install('phones');
    }
  });

  it('RULED with the PDA already closed (a reverted payout that landed): finalize recovers -> PAID', async () => {
    const { betId } = await lockedBetPhones();
    const row = await betRow(betId);
    await lc.payout.onRuling(betId, ruling(betId, row.terms_hash!, 'A_WINS'));
    advance(12_000);
    const f = flaky({ hide: () => true });
    install('phones', { client: f.client, timeoutMs: 30 });
    try {
      await lc.payout.finalizeDue(now());
      await lc.idle();
    } finally {
      install('phones');
    }
    // The state the old code left behind: reverted to RULED, the landed row marked failed.
    const fin = await txRow(betId, 'finalize');
    await ctx.deps.db.update(chainTxs).set({ status: 'failed' }).where(eq(chainTxs.id, fin.id));
    await ctx.deps.db.update(bets).set({ state: 'RULED' }).where(eq(bets.id, betId));
    expect(await onchainBet(betId)).toBeNull();
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'finalize' });
  });

  it('resolve confirm timeout: a landed resolve is adopted (onRuling, a retry, or reconcile)', async () => {
    const { betId } = await lockedBetPhones();
    const termsHash = (await betRow(betId)).terms_hash!;
    const rul = ruling(betId, termsHash, 'A_WINS');
    // 1. Timeout, but the Bet already shows Resolved with this ruling: onRuling adopts it.
    let hide = true;
    const f = flaky({ hide: () => hide });
    install('phones', { client: f.client, timeoutMs: 30 });
    try {
      const r1 = await lc.payout.onRuling(betId, rul);
      expect(await betRow(betId)).toMatchObject({
        state: 'RULED',
        outcome: 'party_a',
        ruling_hash: hashJcs(rul),
      });
      expect(r1.appeal_deadline).toBe(Number((await onchainBet(betId))!.appealDeadline));
      await lc.idle();
    } finally {
      hide = false;
      install('phones');
    }
    // 2. The state the old code left behind (row failed, bet still pre-ruling): a retry adopts
    //    instead of rebuilding a resolve that would fail simulation.
    await ctx.deps.db
      .update(chainTxs)
      .set({ status: 'failed' })
      .where(eq(chainTxs.id, (await txRow(betId, 'resolve')).id));
    await ctx.deps.db
      .update(bets)
      .set({ state: 'JUDGING', outcome: null, ruling_hash: null, appeal_deadline: null })
      .where(eq(bets.id, betId));
    const r2 = await lc.payout.onRuling(betId, rul);
    expect(r2.already).toBe(true);
    expect(await betRow(betId)).toMatchObject({ state: 'RULED', ruling_hash: hashJcs(rul) });
    expect((await txRow(betId, 'resolve')).status).toBe('confirmed');
    await lc.idle();
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect((await betRow(betId)).state).toBe('PAID');
  });

  it('resolve sent but unseen at the timeout, landing later: reconcile adopts it -> RULED', async () => {
    const { betId } = await lockedBetPhones();
    const rul = ruling(betId, (await betRow(betId)).terms_hash!, 'B_WINS');
    let drop = true;
    const f = flaky({ drop: () => drop });
    install('phones', { client: f.client, timeoutMs: 30 });
    try {
      await expect(lc.payout.onRuling(betId, rul)).rejects.toThrow(/not confirmed/);
    } finally {
      drop = false;
      install('phones');
    }
    expect((await txRow(betId, 'resolve')).status).toBe('sent'); // still valid: not failed
    expect((await betRow(betId)).state).toBe('LOCKED');
    // Still in flight: reconcile waits.
    await lc.payout.finalizeDue(now());
    expect((await betRow(betId)).state).toBe('LOCKED');
    // The network delivers it after all.
    await f.base.send(f.dropped[0]!, false);
    await lc.payout.finalizeDue(now());
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({
      state: 'RULED',
      outcome: 'party_b',
      ruling_hash: hashJcs(rul),
    });
    expect((await txRow(betId, 'resolve')).status).toBe('confirmed');
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect((await betRow(betId)).state).toBe('PAID');
  });

  it('GET /v1/me/balance: wallet USDC from the chain + my stakes in escrow', async () => {
    const r = await get(A, '/v1/me/balance');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ wallet_pubkey: signerA.address, source: 'rpc' });
    expect(r.json!.in_escrow).toMatch(/^[0-9]+$/);
    expect(BigInt(r.json!.usdc)).toBeGreaterThan(0n);
    expect(r.json!.usdc_display).toMatch(/^\$/);
  });

  it('demo routes are 404 without the admin key; health reports the pool', async () => {
    expect((await postJson(ctx.base, '/v1/demo/reset', {})).status).toBe(404);
    const h = await fetch(`${ctx.base}/v1/demo/health`, { headers: { 'X-YO-Demo-Key': ADMIN } });
    const body = (await h.json()) as any;
    expect(h.status).toBe(200);
    expect(body).toMatchObject({ chain_configured: true, fee_payer: svm.s.address });
    expect(body.nonce_pool.size).toBe(3);
    expect(body.nonce_pool.free).toBe(3);
  });

  it('scripts/cp1-drive.ts drives challenge -> terms -> confirm -> LOCKED (plays both phones)', async () => {
    const keys = [newKey(), newKey()];
    const signers = await Promise.all(
      keys.map((k) => createKeyPairSignerFromPrivateKeyBytes(k.secret)),
    );
    for (const owner of signers) await fund(owner);
    const secret = (k: TestKey, s: KeyPairSigner) =>
      JSON.stringify([...k.secret, ...new Uint8Array(getAddressEncoder().encode(s.address))]);
    const stateFile = join(tmpdir(), `cp1-drive-${randomUUID()}.json`);
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
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
            '20',
            '--name-a',
            'Ava',
            '--name-b',
            'Ben',
          ],
          {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: {
              ...process.env,
              DEMO_A_SECRET_KEY: secret(keys[0]!, signers[0]!),
              DEMO_B_SECRET_KEY: secret(keys[1]!, signers[1]!),
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      },
    );
    rmSync(stateFile, { force: true });
    expect(out.stderr + out.stdout).toContain('LOCKED in');
    expect(out.code).toBe(0);
    await lc.idle();
  }, 60_000);

  async function fund(owner: KeyPairSigner) {
    const ata = await findAta(owner);
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

  async function findAta(owner: KeyPairSigner) {
    const [ata] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: svm.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
  }
});
