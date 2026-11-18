/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// The money path, hardened for a live pitch, over HTTP + Postgres + LiteSVM running the real
// escrow.so: timeout_refund of a bet nobody ruled on (and its reconcile after a lost confirm),
// orphan escrow exits (rows deleted by a demo reset), the reset itself (pair freed, nonces free,
// sessions untouched, escrow returned), USDC rebalance between the demo wallets, retry safety of
// resolve and of a dropped lock, the boot reconcile and /v1/demo/health.
//
// This suite runs in its OWN database (<DATABASE_URL db>_money): it owns nonce_pool and calls
// POST /v1/demo/reset (which deletes every non-seed bet). Skips without DATABASE_URL or escrow.so.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { auditLog, betEvents, bets, chainTxs, noncePool } from '@youre-on/db';
import type { Session } from '@youre-on/shared/api';
import {
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  findBetPda,
  getBetDecoder,
} from '@youre-on/shared/escrow-client';
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
import type { ChainClient, ChainRuntime } from '../src/chain/tx';
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
const ADMIN = 'demo-admin-token-for-money-path';

run('money path hardening over LiteSVM', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let client: ReturnType<typeof liteSvmClient>;
  let lc: Lifecycle;
  let offset = 0;
  const now = () => Date.now() + offset;
  let keyA: TestKey;
  let keyB: TestKey;
  let A: SignedUp;
  let B: SignedUp;
  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;

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

  /** `hide` nulls every status lookup (a lost confirm); `drop` swallows sends. */
  const flaky = (o: { hide?: () => boolean; drop?: () => boolean }) => {
    const base = rt.client;
    const dropped: Base64EncodedWireTransaction[] = [];
    const c: ChainClient = {
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
    return { client: c, dropped, base };
  };

  const advance = (ms: number) => {
    offset += ms;
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
  const usdc = async (s: KeyPairSigner) => tokenAmount(svm.svm, await ata(s));

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
    const dbUrl = await ownDatabase(DB_URL!, 'money');
    ctx = await startTestServer({
      now,
      env: { DATABASE_URL: dbUrl, DEMO_MODE: 'true', DEMO_ADMIN_TOKEN: ADMIN },
    });
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    keyA = newKey();
    keyB = newKey();
    signerA = await createKeyPairSignerFromPrivateKeyBytes(keyA.secret);
    signerB = await createKeyPairSignerFromPrivateKeyBytes(keyB.secret);
    await mint(signerA, 100n * USDC);
    await mint(signerB, 100n * USDC);
    for (const k of [0, 1, 2]) await createPoolNonce(svm, k);
    client = liteSvmClient(svm.svm);
    rt = {
      client,
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
    // This database is ours alone: no leftovers from an earlier run of this suite.
    await ctx.deps.db.delete(noncePool);
    await ctx.deps.db.delete(bets);
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    install('server');
    A = await signUpWith('Ava', keyA);
    B = await signUpWith('Ben', keyB);
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
  const _get = async (u: SignedUp | null, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(ctx.base + path, {
      headers: u ? { Authorization: `Bearer ${u.session.token}`, ...headers } : headers,
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });
  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0];
  const onchainBet = async (betId: string) => {
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    const acc = svm.svm.getAccount(pda);
    return acc.exists ? getBetDecoder().decode(acc.data) : null;
  };
  const txRows = async (betId: string, kind: string) =>
    (await ctx.deps.db.select().from(chainTxs).where(eq(chainTxs.bet_id, betId))).filter(
      (t) => t.kind === kind,
    );

  async function proposedBet(): Promise<string> {
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'Money', kind: 'session' });
    expect(room.status).toBe(201);
    expect((await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    expect((await admin(`/v1/demo/bets/${betId}/terms`)).json).toMatchObject({ ok: true });
    return betId;
  }

  /** Custodial: confirm -> the server signs as A and B -> LOCKED. */
  async function lockedBet(): Promise<string> {
    const betId = await proposedBet();
    expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle();
    expect((await betRow(betId))!.state).toBe('LOCKED');
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
      reason: 'The bottle landed upright.',
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

  const RESOLVE_WINDOW_MS = 3_600_000;

  // ---- timeout_refund ------------------------------------------------------------------------

  it('timeout-refund: a LOCKED bet nobody ruled on is refunded at resolve_deadline -> EXPIRED', async () => {
    const aBefore = await usdc(signerA);
    const bBefore = await usdc(signerB);
    const betId = await lockedBet();
    expect(await usdc(signerA)).toBe(aBefore - USDC);

    // Before the deadline: nothing sent, but resolve_deadline is backfilled from the Bet.
    const early = await lc.refund.sweep(now());
    expect(early.refunded).toEqual([]);
    const onchain = (await onchainBet(betId))!;
    expect((await betRow(betId))!.resolve_deadline!.getTime()).toBe(
      Number(onchain.resolveDeadline) * 1000,
    );
    expect(await lc.refund.sweep(now())).toMatchObject({ refunded: [] }); // not a candidate now

    advance(RESOLVE_WINDOW_MS + 1_000);
    const r = await lc.refund.sweep(now());
    expect(r.refunded).toEqual([betId]);
    const row = (await betRow(betId))!;
    expect(row).toMatchObject({
      state: 'EXPIRED',
      end_reason: 'resolve_timeout',
      outcome: 'refund',
      payout_via: 'timeout_refund',
      payout_a: USDC,
      payout_b: USDC,
    });
    expect(row.payout_sig).toBe(row.close_sig);
    expect(await onchainBet(betId)).toBeNull(); // close_bet closed it
    expect(await usdc(signerA)).toBe(aBefore);
    expect(await usdc(signerB)).toBe(bBefore);
    const [refundTx] = await txRows(betId, 'timeout_refund');
    expect(refundTx).toMatchObject({ status: 'confirmed', signer_role: 'fee_payer' });

    // Pushed: tx.submitted, bet.state EXPIRED (prev LOCKED), tx.confirmed, judge.cue EXPIRED.
    const evs = await ctx.deps.db
      .select()
      .from(betEvents)
      .where(eq(betEvents.bet_id, betId))
      .orderBy(betEvents.seq);
    const tail = evs.slice(-4).map((e) => [e.type, (e.envelope as any).payload]);
    expect(tail.map((t) => t[0])).toEqual([
      'tx.submitted',
      'bet.state',
      'tx.confirmed',
      'judge.cue',
    ]);
    expect(tail[1]![1]).toMatchObject({
      state: 'EXPIRED',
      prev: 'LOCKED',
      reason: 'resolve_timeout',
      pending_tx: { kind: 'timeout_refund', signature: row.payout_sig },
    });
    expect(tail[3]![1]).toMatchObject({ cue: 'EXPIRED' });
    expect(tail[3]![1].text).toContain('reason=resolve_timeout');

    // Idempotent: nothing more to do.
    expect(await lc.refund.sweep(now())).toMatchObject({ refunded: [], pending: [] });
    expect(await txRows(betId, 'timeout_refund')).toHaveLength(1);
  });

  it('timeout-refund confirm lost: the row stays sent, no second refund is built, reconcile settles it', async () => {
    const betId = await lockedBet();
    advance(RESOLVE_WINDOW_MS + 1_000);
    let hide = true;
    const f = flaky({ hide: () => hide });
    install('server', { client: f.client, timeoutMs: 30 });
    try {
      const r = await lc.refund.sweep(now());
      expect(r.pending).toEqual([betId]);
      expect((await betRow(betId))!.state).toBe('LOCKED');
      expect(await onchainBet(betId)).toBeNull(); // it did land
      // Still unknown: the next sweep must not build another refund.
      await lc.refund.sweep(now());
      expect(await txRows(betId, 'timeout_refund')).toHaveLength(1);
      expect((await txRows(betId, 'timeout_refund'))[0]!.status).toBe('sent');
      hide = false;
      const r2 = await lc.refund.sweep(now());
      expect(r2.refunded).toContain(betId);
    } finally {
      install('server');
    }
    expect(await betRow(betId)).toMatchObject({
      state: 'EXPIRED',
      end_reason: 'resolve_timeout',
      payout_a: USDC,
      payout_b: USDC,
    });
    expect((await txRows(betId, 'timeout_refund'))[0]!.status).toBe('confirmed');
  });

  it('timeout-refund dropped (never landed, blockhash expired): marked expired, then rebuilt', async () => {
    const betId = await lockedBet();
    advance(RESOLVE_WINDOW_MS + 1_000);
    let drop = true;
    let height = 0n;
    const f = flaky({ drop: () => drop });
    const c: ChainClient = { ...f.client, blockHeight: async () => height };
    install('server', { client: c, timeoutMs: 30 });
    try {
      expect((await lc.refund.sweep(now())).pending).toEqual([betId]);
      expect((await onchainBet(betId))!.status).toBe(BetStatus.Locked);
      // Unseen but the blockhash is still valid: not rebuilt.
      await lc.refund.sweep(now());
      expect(await txRows(betId, 'timeout_refund')).toHaveLength(1);
      // Past lastValidBlockHeight and still unseen: known dead -> expired, and a new one is sent.
      height = 2_000_000n;
      svm.svm.expireBlockhash(); // what passing lastValidBlockHeight means: a new blockhash
      drop = false;
      const r = await lc.refund.sweep(now());
      expect(r.refunded).toEqual([betId]);
    } finally {
      install('server');
    }
    const rows = await txRows(betId, 'timeout_refund');
    expect(rows.map((t) => t.status).sort()).toEqual(['confirmed', 'expired']);
    expect((await betRow(betId))!.state).toBe('EXPIRED');
  });

  it('a bet with a resolve in flight is not refunded; a resolve that won the race wins', async () => {
    const betId = await lockedBet();
    const row = (await betRow(betId))!;
    // A 'sent' resolve row (its confirm is somewhere else): the refund sweep must wait.
    await ctx.deps.db.insert(chainTxs).values({
      bet_id: betId,
      kind: 'resolve',
      signer_role: 'judge',
      message_sha256: 'ee'.repeat(32),
      expected_status: 'resolved',
      status: 'sent',
      sent_at: new Date(now()),
    });
    advance(RESOLVE_WINDOW_MS + 1_000);
    expect((await lc.refund.sweep(now())).refunded).not.toContain(betId);
    expect(await txRows(betId, 'timeout_refund')).toHaveLength(0);
    await ctx.deps.db
      .update(chainTxs)
      .set({ status: 'failed' })
      .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, 'resolve')));
    expect((await lc.refund.sweep(now())).refunded).toContain(betId);
    expect((await betRow(betId))!.terms_hash).toBe(row.terms_hash);
  });

  // ---- retry safety of the other money txs ---------------------------------------------------

  it('resolve retry: a sent resolve still in flight is re-broadcast (same signature), not rebuilt', async () => {
    const betId = await lockedBet();
    const rul = ruling(betId, (await betRow(betId))!.terms_hash!, 'B_WINS');
    let drop = true;
    const f = flaky({ drop: () => drop });
    install('server', { client: f.client, timeoutMs: 30 });
    try {
      await expect(lc.payout.onRuling(betId, rul)).rejects.toThrow(/not confirmed/);
    } finally {
      drop = false;
    }
    const [first] = await txRows(betId, 'resolve');
    expect(first!.status).toBe('sent');
    // The keeper's resolve-due retry calls onRuling again: same bytes, same signature.
    install('server');
    const r = await lc.payout.onRuling(betId, rul);
    expect(r.signature).toBe(first!.signature);
    const rows = await txRows(betId, 'resolve');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('confirmed');
    expect((await betRow(betId))!.state).toBe('RULED');
    await lc.idle();
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect((await betRow(betId))!.state).toBe('PAID');
  });

  it('lock sweep re-broadcasts a dropped lock (durable nonce: same bytes) before expires_at -> LOCKED', async () => {
    let drop = true;
    const f = flaky({ drop: () => drop });
    install('server', { client: f.client, timeoutMs: 30 });
    let betId: string;
    try {
      betId = await proposedBet();
      await admin(`/v1/demo/bets/${betId}/confirm`);
      await lc.idle();
    } finally {
      drop = false;
      install('server');
    }
    expect((await betRow(betId))!.state).toBe('AWAITING_LOCK');
    expect(await onchainBet(betId)).toBeNull();
    // Pass 1 re-sends the stored bytes (it lands); pass 2 sees it confirmed.
    expect((await lc.lock.sweep(now())).landed).not.toContain(betId);
    expect((await onchainBet(betId))!.status).toBe(BetStatus.Locked);
    const r = await lc.lock.sweep(now());
    expect(r.landed).toContain(betId);
    await lc.idle();
    expect((await betRow(betId))!.state).toBe('LOCKED');
    const [lock] = await txRows(betId, 'atomic_lock');
    expect(lock!.status).toBe('confirmed');
    expect(client.sent).toContain(lock!.signature);
  });

  // ---- orphans -------------------------------------------------------------------------------

  it('orphan escrow: a Locked bet whose row is gone is listed, then refunded at its deadline', async () => {
    const aBefore = await usdc(signerA);
    const betId = await lockedBet();
    await ctx.deps.db.delete(bets).where(eq(bets.id, betId)); // what a demo reset does
    const s1 = await lc.refund.sweepOrphans(now());
    const mine = s1.orphans.find((o) => o.bet_id === betId);
    expect(mine).toMatchObject({ status: 'Locked', action: null });
    expect(mine!.due_at).toBe(Number((await onchainBet(betId))!.resolveDeadline));
    expect(lc.refund.lastOrphanScan?.orphans.map((o) => o.bet_id)).toContain(betId);

    advance(RESOLVE_WINDOW_MS + 1_000);
    const s2 = await lc.refund.sweepOrphans(now());
    expect(s2.sent).toEqual([expect.objectContaining({ bet_id: betId, action: 'timeout_refund' })]);
    expect(await onchainBet(betId)).toBeNull();
    expect(await usdc(signerA)).toBe(aBefore);
    const audit = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, betId), eq(auditLog.action, 'chain.orphan_exit')));
    expect(audit).toHaveLength(1);
    expect((await lc.refund.sweepOrphans(now())).orphans).toHaveLength(0);
  });

  it('orphan escrow: a Resolved bet whose row is gone is finalized after the appeal window (the ruling stands)', async () => {
    const bBefore = await usdc(signerB);
    const betId = await lockedBet();
    await lc.payout.onRuling(betId, ruling(betId, (await betRow(betId))!.terms_hash!, 'B_WINS'));
    await lc.idle();
    await ctx.deps.db.delete(bets).where(eq(bets.id, betId));
    expect((await lc.refund.sweepOrphans(now())).sent).toEqual([]); // window still open
    advance(12_000);
    const s = await lc.refund.sweepOrphans(now());
    expect(s.sent).toEqual([expect.objectContaining({ bet_id: betId, action: 'finalize' })]);
    expect(await usdc(signerB)).toBe(bBefore + USDC); // B's stake back + A's
  });
});
