/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// The money path, hardened for a live pitch, over HTTP + Postgres + LiteSVM running the real
// escrow.so: timeout_refund of a bet nobody ruled on (and its reconcile after a lost confirm),
// orphan escrow exits (rows deleted by a demo reset), the reset itself (pair freed, nonces free,
// sessions untouched, escrow returned), USDC rebalance between the demo wallets, retry safety of
// resolve and of a dropped lock, the boot reconcile and /v1/demo/health.
//
// This suite runs in its OWN database (<DATABASE_URL db>_money): it owns nonce_pool and calls
// POST /v1/demo/reset (which deletes every non-seed bet). Skips without DATABASE_URL or escrow.so.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
  getAppealInstructionAsync,
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
import { logChainHealth } from '../src/chain/health';
import { bootReconcile } from '../src/chain/reconcile';
import {
  instrumentChainClient,
  PreflightError,
  RpcStats,
  type ChainClient,
  type ChainRuntime,
} from '../src/chain/tx';
import { forgetLastRebalance } from '../src/demo/rebalance';
import { createServerKeeper } from '../src/keeper';
import {
  createLifecycle,
  installLifecycle,
  lifecycleOf,
  type Lifecycle,
} from '../src/lock/runtime';
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
  const get = async (u: SignedUp | null, path: string, headers: Record<string, string> = {}) => {
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

  it('timeout-refund from Appealed: an appeal nobody decided is refunded at appeal_resolve_deadline', async () => {
    const aBefore = await usdc(signerA);
    const bBefore = await usdc(signerB);
    const betId = await lockedBet();
    await lc.payout.onRuling(betId, ruling(betId, (await betRow(betId))!.terms_hash!, 'A_WINS'));
    await lc.idle();
    // B (the loser) appeals onchain inside the 10 s window; the server has no appeal path yet,
    // so the row stays RULED with no appeal_resolve_deadline.
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    await send(svm.svm, svm.s, [
      await getAppealInstructionAsync({ payer: svm.s, appellant: signerB, bet: pda }),
    ]);
    expect((await onchainBet(betId))!.status).toBe(BetStatus.Appealed);
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).not.toContain(betId); // finalize skips Appealed
    advance(60_000); // RULED a minute past the window: the refund sweep probes the chain
    expect((await lc.refund.sweep(now())).refunded).toEqual([]);
    const row = (await betRow(betId))!;
    expect(row.appeal_resolve_deadline!.getTime()).toBe(
      Number((await onchainBet(betId))!.appealResolveDeadline) * 1000,
    );
    advance(300_000); // past appeal_resolve_deadline (300 s after the appeal)
    const r = await lc.refund.sweep(now());
    expect(r.refunded).toEqual([betId]);
    expect(await betRow(betId)).toMatchObject({
      state: 'EXPIRED',
      end_reason: 'appeal_timeout',
      payout_via: 'timeout_refund',
      payout_a: USDC,
      payout_b: USDC,
    });
    expect(await usdc(signerA)).toBe(aBefore);
    expect(await usdc(signerB)).toBe(bBefore);
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

  it('resolve rejected at preflight for an unknown blockhash (lagging RPC node): rebuilt once at once', async () => {
    const betId = await lockedBet();
    let rejected = 0;
    const c: ChainClient = {
      ...rt.client,
      send: async (wire, skip) => {
        if (!skip && rejected === 0) {
          rejected++;
          svm.svm.expireBlockhash(); // the node moved on: the next build gets a new blockhash
          throw new PreflightError(
            'preflight rejected: "BlockhashNotFound"',
            'BlockhashNotFound',
            [],
          );
        }
        return rt.client.send(wire, skip);
      },
    };
    install('server', { client: c });
    try {
      const rul = ruling(betId, (await betRow(betId))!.terms_hash!, 'B_WINS');
      const r = await lc.payout.onRuling(betId, rul);
      expect(r.already).toBe(false);
      expect(rejected).toBe(1);
      expect((await betRow(betId))!.state).toBe('RULED');
      const rows = await txRows(betId, 'resolve');
      expect(rows.map((t) => t.status).sort()).toEqual(['confirmed', 'failed']);
      await lc.idle();
    } finally {
      install('server');
    }
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
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

  it('orphan scan without getProgramAccounts support: skipped (no keeper error), flagged in health', async () => {
    const noGpa: ChainClient = {
      ...rt.client,
      programAccounts: async () => {
        throw new Error('HTTP 403: method getProgramAccounts not allowed on this plan');
      },
    };
    install('server', { client: noGpa });
    try {
      const s = await lc.refund.sweepOrphans(now());
      expect(s.live).toBeNull();
      expect(s.errors[0]).toMatch(/getProgramAccounts not allowed/);
      const h = (await get(null, '/v1/demo/health', { 'X-YO-Demo-Key': ADMIN })).json!;
      expect(h.warnings).toContainEqual(
        expect.objectContaining({ code: 'orphan_scan_errors', level: 'warn' }),
      );
    } finally {
      install('server');
    }
  });

  // ---- demo reset, rebalance ---------------------------------------------------------------

  it('demo reset: escrow returned, pair freed, nonces free, sessions untouched', async () => {
    // Start clean: earlier tests leave locked bets (their escrow comes back here too).
    await admin('/v1/demo/reset');
    advance(12_000);
    await lc.refund.sweepOrphans(now());
    expect(lc.refund.lastOrphanScan?.live).toBe(0);
    const aBefore = await usdc(signerA);
    const bBefore = await usdc(signerB);
    const locked = await lockedBet(); // money in escrow
    install('phones');
    const pre = await proposedBet(); // a pre-lock bet: holds pair_busy...
    expect((await admin(`/v1/demo/bets/${pre}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle(); // ...and a leased nonce (AWAITING_AUTHORIZATIONS)
    expect((await betRow(pre))!.state).toBe('AWAITING_AUTHORIZATIONS');
    const pool0 = await ctx.deps.db.select().from(noncePool);
    expect(pool0.filter((n) => n.status === 'leased')).toHaveLength(1);
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'Busy', kind: 'session' });
    await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code });
    const busy = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(busy.json!.error.details.reason).toBe('pair_busy');

    const r = await admin('/v1/demo/reset');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, nonces_revoked: 1, nonces_synced: 3 });
    expect(r.json!.deleted_bets).toBeGreaterThanOrEqual(2);
    // The Locked rehearsal bet: resolve(Refund) by the judge key, pending the appeal window.
    expect(r.json!.escrow.actions).toContainEqual(
      expect.objectContaining({ bet_id: locked, action: 'resolve_refund' }),
    );
    expect(r.json!.escrow.pending).toContainEqual({ bet_id: locked, status: 'Resolved' });
    expect(r.json!.escrow.settles_at).toBeNull(); // timers off in tests: the sweep is driven here
    expect(await betRow(locked)).toBeUndefined();
    // Nonces: none leased, all three free with a fresh value.
    const pool = await ctx.deps.db.select().from(noncePool);
    expect(pool.map((n) => n.status)).toEqual(['free', 'free', 'free']);
    // Sessions untouched: the same bearer still works; the pair can challenge again.
    expect((await get(A, '/v1/me/bets')).status).toBe(200);
    expect((await get(B, '/v1/me/bets')).status).toBe(200);
    const again = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(again.status).toBe(201);
    // After the appeal window the orphan sweep finalizes the Refund: both stakes are back.
    advance(12_000);
    const s = await lc.refund.sweepOrphans(now());
    expect(s.sent).toContainEqual(expect.objectContaining({ bet_id: locked, action: 'finalize' }));
    expect(await onchainBet(locked)).toBeNull();
    expect(await usdc(signerA)).toBe(aBefore);
    expect(await usdc(signerB)).toBe(bBefore);
    const audit = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, locked), eq(auditLog.action, 'demo.reset_void')));
    expect(audit).toHaveLength(1);
    install('server');
    await admin('/v1/demo/reset'); // tidy: the fresh challenge
  });

  it('rebalance: demo-a and demo-b end up equal; the fee payer pays, the wallets hold no SOL', async () => {
    await mint(signerB, 37n * USDC + 3n); // B won a lot of rehearsals (odd micro-units too)
    const [a0, b0] = [await usdc(signerA), await usdc(signerB)];
    const fp0 = svm.svm.getBalance(svm.s.address)!;
    const r = await admin('/v1/demo/rebalance');
    expect(r.json).toMatchObject({ ok: true, status: 'moved', from: 'demo-b' });
    const [a1, b1] = [await usdc(signerA), await usdc(signerB)];
    expect(a1 + b1).toBe(a0 + b0);
    expect(a1 - b1 === 0n || a1 - b1 === 1n).toBe(true); // A gets the odd micro-unit
    expect(r.json!.after).toEqual({ a: a1.toString(), b: b1.toString() });
    expect(svm.svm.getBalance(svm.s.address)!).toBeLessThan(fp0); // fee payer paid
    expect(svm.svm.getBalance(signerA.address) ?? 0n).toBe(0n);
    expect(svm.svm.getBalance(signerB.address) ?? 0n).toBe(0n);
    // Again: already balanced, no tx.
    const again = await admin('/v1/demo/rebalance');
    expect(again.json).toMatchObject({ status: 'balanced', signature: null });
    // audit_log is append-only and outlives runs of this suite: find this run's row.
    const sent = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'demo.rebalance_sent'),
          sql`${auditLog.details}->>'signature' = ${r.json!.signature as string}`,
        ),
      );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.details).toMatchObject({ from: 'demo-b', fee_payer: svm.s.address });
  });

  it('rebalance never doubles: an earlier one still in flight -> 409 rebalance_in_flight', async () => {
    await mint(signerA, 10n * USDC);
    let drop = true;
    const f = flaky({ drop: () => drop });
    install('server', { client: f.client, timeoutMs: 30 });
    try {
      const r1 = await admin('/v1/demo/rebalance');
      expect(r1.json!.error).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
      // Unknown fate, blockhash still valid: refused, also after a "restart" (audit_log).
      forgetLastRebalance({ ...rt, client: f.client });
      const r2 = await admin('/v1/demo/rebalance');
      expect(r2.status).toBe(409);
      expect(r2.json!.error.details.reason).toBe('rebalance_in_flight');
      // It lands after all: the next call sees it settled and finds the wallets balanced.
      drop = false;
      await f.base.send(f.dropped[0]!, false);
      const r3 = await admin('/v1/demo/rebalance');
      expect(r3.json).toMatchObject({ ok: true, status: 'balanced' });
    } finally {
      install('server');
    }
  });

  it('concurrent orphan sweeps send one exit per Bet, never two', async () => {
    const betId = await lockedBet();
    await ctx.deps.db.delete(bets).where(eq(bets.id, betId));
    advance(RESOLVE_WINDOW_MS + 1_000);
    const [s1, s2] = await Promise.all([
      lc.refund.sweepOrphans(now()),
      lc.refund.sweepOrphans(now()),
    ]);
    const sent = [...s1.sent, ...s2.sent].filter((x) => x.bet_id === betId);
    expect(sent).toHaveLength(1);
    expect(await onchainBet(betId)).toBeNull();
    const audit = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, betId), eq(auditLog.action, 'chain.orphan_exit')));
    expect(audit).toHaveLength(1);
  });

  it('concurrent rebalances run one at a time: one moves, the other finds them balanced', async () => {
    await mint(signerA, 9n * USDC);
    const [r1, r2] = await Promise.all([admin('/v1/demo/rebalance'), admin('/v1/demo/rebalance')]);
    const statuses = [r1.json!.status, r2.json!.status].sort();
    expect(statuses).toEqual(['balanced', 'moved']);
    const [a, b] = [await usdc(signerA), await usdc(signerB)];
    expect(a > b ? a - b : b - a).toBeLessThanOrEqual(1n); // the poorer side gets the odd unit
  });

  it('rebalance refuses while a demo bet is locking', async () => {
    install('phones');
    try {
      const pre = await proposedBet();
      await admin(`/v1/demo/bets/${pre}/confirm`);
      await lc.idle();
      const r = await admin('/v1/demo/rebalance');
      expect(r.status).toBe(409);
      expect(r.json!.error.details).toMatchObject({ reason: 'lock_in_progress', bet_id: pre });
    } finally {
      install('server');
      await admin('/v1/demo/reset');
    }
  });

  // ---- health, boot reconcile, stranded payouts --------------------------------------------

  it('GET /v1/demo/health: balances, pool, RPC stats, warnings with fixes', async () => {
    const stats = new RpcStats();
    install('server', { client: instrumentChainClient(rt.client, stats) });
    try {
      await lc.lock.ensurePool(rt);
      await lc.refund.sweepOrphans(now()); // some RPC traffic + an orphan scan
      const h = await get(null, '/v1/demo/health', { 'X-YO-Demo-Key': ADMIN });
      expect(h.status).toBe(200);
      const body = h.json!;
      expect(body).toMatchObject({
        chain_configured: true,
        fee_payer: svm.s.address,
        nonce_pool: { size: 3, free: 3 },
        balances: {
          demo_a: { address: signerA.address },
          demo_b: { address: signerB.address },
          treasury: null,
        },
        escrow: { live: 0, orphans: [] },
        stream: { last_delivery_at: null },
      });
      expect(body.rpc_stats.calls).toBeGreaterThan(0);
      expect(body.rpc_stats.p95_ms).not.toBeNull();
      expect(body.balances.demo_a.usdc).toBe((await usdc(signerA)).toString());
      // No keeper in tests: a warning, but not a critical one.
      expect(body.warnings).toContainEqual(
        expect.objectContaining({ code: 'keeper_off', level: 'warn' }),
      );
      expect(body.ok).toBe(true);
    } finally {
      install('server');
    }
  });

  it('health: low fee payer, few free nonces and a stuck sent tx are flagged', async () => {
    const poor: ChainClient = { ...rt.client, lamports: async () => 50_000_000n }; // 0.05 SOL
    const betId = await lockedBet();
    install('server', { client: poor });
    const pool = await ctx.deps.db.select().from(noncePool).orderBy(noncePool.seed_index);
    try {
      for (const n of pool.slice(0, 2))
        await ctx.deps.db
          .update(noncePool)
          .set({ status: 'retired', retired_at: new Date(now()) })
          .where(eq(noncePool.seed_index, n.seed_index));
      await ctx.deps.db.insert(chainTxs).values({
        bet_id: betId,
        kind: 'finalize',
        signer_role: 'fee_payer',
        message_sha256: 'ab'.repeat(32),
        expected_status: 'settled',
        status: 'sent',
        sent_at: new Date(now() - 10 * 60_000),
      });
      const h = (await get(null, '/v1/demo/health', { 'X-YO-Demo-Key': ADMIN })).json!;
      const codes = Object.fromEntries(h.warnings.map((w: any) => [w.code, w.level]));
      expect(codes).toMatchObject({
        fee_payer_low: 'critical',
        nonce_pool_low: 'warn',
        txs_stuck: 'warn',
      });
      expect(h.ok).toBe(false);
      expect(h.inflight.stuck[0]).toMatchObject({ bet_id: betId, kind: 'finalize' });
    } finally {
      await ctx.deps.db
        .delete(chainTxs)
        .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, 'finalize')));
      await ctx.deps.db
        .update(noncePool)
        .set({ status: 'free', retired_at: null })
        .where(eq(noncePool.status, 'retired'));
      install('server');
      await admin('/v1/demo/reset');
    }
  });

  it('logChainHealth: one chain.unhealthy line with every warning code', async () => {
    await lc.lock.ensurePool(rt);
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    const rec = (msg: string, f?: Record<string, unknown>) => void lines.push([msg, f]);
    const prevLog = ctx.deps.log;
    // The same deps object (lifecycleOf keys by identity), with a recording logger.
    ctx.deps.log = { debug: rec, info: rec, warn: rec, error: rec };
    try {
      const r = await logChainHealth(ctx.deps);
      expect(r.warnings.map((w) => w.code)).toContain('keeper_off'); // no keeper in tests
    } finally {
      ctx.deps.log = prevLog;
    }
    const health = lines.filter(([m]) => m.startsWith('chain.'));
    expect(health).toHaveLength(1);
    expect(health[0]![0]).toBe('chain.unhealthy');
    expect(health[0]![1]).toMatchObject({ ok: true, nonces_free: 3 });
    expect(health[0]![1]!.warnings).toContain('warn:keeper_off');
  });

  it('a FINALIZED bet with no payout in flight is not stranded: still Resolved -> RULED -> PAID', async () => {
    const betId = await lockedBet();
    await lc.payout.onRuling(betId, ruling(betId, (await betRow(betId))!.terms_hash!, 'A_WINS'));
    await lc.idle();
    // A crash left FINALIZED with no 'sent' row (nothing would ever move it otherwise).
    await ctx.deps.db.update(bets).set({ state: 'FINALIZED' }).where(eq(bets.id, betId));
    advance(40_000); // past STRANDED_GRACE_MS and the appeal window
    const fixed = await lc.payout.reconcileStranded(rt, now());
    expect(fixed).toEqual([betId]);
    expect((await betRow(betId))!.state).toBe('RULED');
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect((await betRow(betId))!.state).toBe('PAID');
  });

  it('boot reconcile: a lock whose confirm was lost lands; anomalies are listed', async () => {
    let hide = true;
    const f = flaky({ hide: () => hide });
    install('server', { client: f.client, timeoutMs: 30 });
    const lost = await proposedBet();
    await admin(`/v1/demo/bets/${lost}/confirm`);
    await lc.idle();
    hide = false;
    install('server'); // "restart"
    expect((await betRow(lost))!.state).toBe('AWAITING_LOCK');
    const report = await bootReconcile(ctx.deps, now());
    expect(report.chain_configured).toBe(true);
    expect(report.before.sent_txs).toMatchObject({ atomic_lock: 1 });
    expect(report.lock?.landed).toContain(lost);
    expect((await betRow(lost))!.state).toBe('LOCKED');
    expect(report.anomalies).toEqual([]);
    expect(report.errors).toEqual([]);
    // An unexplained one: RULED in the DB, but the Bet is still Locked onchain.
    await ctx.deps.db.update(bets).set({ state: 'RULED' }).where(eq(bets.id, lost));
    const r2 = await bootReconcile(ctx.deps, now());
    expect(r2.anomalies).toContainEqual({ bet_id: lost, state: 'RULED', onchain: 'Locked' });
    await ctx.deps.db.update(bets).set({ state: 'LOCKED' }).where(eq(bets.id, lost));
    await admin('/v1/demo/reset');
  });

  it('POST /v1/demo/sweep runs every money sweep now and returns them with the health report', async () => {
    const betId = await lockedBet();
    await ctx.deps.db.delete(bets).where(eq(bets.id, betId)); // an orphan...
    advance(RESOLVE_WINDOW_MS + 1_000); // ...past its deadline
    expect((await postJson(ctx.base, '/v1/demo/sweep', {})).status).toBe(404); // no admin key
    const r = await admin('/v1/demo/sweep');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, reconcile: { chain_configured: true } });
    expect(r.json!.orphans.sent).toContainEqual(
      expect.objectContaining({ bet_id: betId, action: 'timeout_refund' }),
    );
    expect(r.json!.health).toMatchObject({ chain_configured: true, nonce_pool: { size: 3 } });
    expect(await onchainBet(betId)).toBeNull();
  });

  it('the keeper drives the SAME lifecycle the routes use (never one per deps copy)', async () => {
    const keeper = createServerKeeper(ctx.deps, { intervalMs: 60_000 });
    const calls: string[] = [];
    const prev = lifecycleOf(ctx.deps);
    const fake = {
      ...prev,
      lock: { sweep: async () => (calls.push('lock'), { expired: [], landed: [] }) },
    } as unknown as Lifecycle;
    installLifecycle(ctx.deps, fake);
    try {
      await keeper.tick();
      expect(calls.length).toBeGreaterThan(0);
      expect(keeper.status().tasks.map((t) => t.name)).toContain('boot-reconcile');
    } finally {
      installLifecycle(ctx.deps, prev);
      await keeper.stop();
    }
  });

  it('scripts/demo-check.ts against this server: GO per item, exit 0; a wrong key is NO-GO, exit 1', async () => {
    await lc.lock.ensurePool(rt);
    const runCheck = (key: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const env = { ...process.env };
        // Never reach a real RPC / QuickNode from a test.
        delete env.SOLANA_RPC_URL;
        delete env.QN_API_KEY;
        delete env.QN_STREAM_ID;
        delete env.DEMO_ADMIN_TOKEN;
        const child = spawn(
          'npx',
          ['tsx', 'scripts/demo-check.ts', '--server', ctx.base, '--demo-key', key],
          { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (out += String(d)));
        child.on('close', (code) => resolve({ code, out }));
      });
    // The server clock of this suite runs hours ahead (advance()); demo-check compares it with
    // this machine's, so line it up for the run.
    const saved = offset;
    offset = 0;
    const good = await runCheck(ADMIN).finally(() => (offset = saved));
    expect(good.out).toMatch(/^GO {5}server\.health/m);
    expect(good.out).toMatch(/^GO {5}chain\.nonce_pool +3 free \/ 3/m);
    expect(good.out).toMatch(/^GO {5}chain\.fee_payer_sol/m);
    expect(good.out).toMatch(/^SKIP {3}rpc /m);
    expect(good.out).toMatch(/^SKIP {3}stream\.status/m);
    expect(good.out).toMatch(/^GO: /m);
    expect(good.code).toBe(0);
    const bad = await runCheck('not-the-key');
    // (server.clock may be NO-GO here too: the suite's clock is ahead again.)
    expect(bad.out).toMatch(/^NO-GO {2}demo\.health +HTTP 404/m);
    expect(bad.code).toBe(1);
  }, 60_000);
});
