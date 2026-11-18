/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// The Stream path end to end on REAL transactions: LiteSVM runs the real escrow.so, the server's
// own LockService / PayoutService send the lock, resolve and payout txs (custodial signer), each
// landed tx is turned into a getBlock-shaped block (its actual inner instructions = the emit_cpi!
// events), run through infra/quicknode/filter.js, signed like QuickNode signs and POSTed to
// /webhooks/quicknode, where the projector applies it.
//   1. RPC confirms first (the normal path): the Stream confirms each step without a state move
//      or a second cue; onchain_status / *_sig / payouts land; chain_ack -> stream.
//   2. Missed lock confirm: the Stream moves AWAITING_LOCK -> LOCKED; the LockService sweep later
//      settles its chain_txs row and frees the nonce without a second LOCKED cue.
//   3. Missed finalize confirm: the Stream moves FINALIZED -> PAID; the payout reconcile then
//      marks the row confirmed without a second PAID cue.
// This suite runs in its OWN database (<DATABASE_URL db>_qnproj): it owns nonce_pool, like
// lifecycle.test.ts / e2e-beats.test.ts. Skips without DATABASE_URL or escrow.so.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  type Address,
  type Transaction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { FailedTransactionMetadata, type TransactionMetadata } from 'litesvm';
import { chainEvents, chainTxs, noncePool } from '@youre-on/db';
import type { Session } from '@youre-on/shared/api';
import { ESCROW_PROGRAM_ADDRESS } from '@youre-on/shared/escrow-client';
import type { Ruling } from '@youre-on/shared/ruling';
import {
  createPoolNonce,
  HAVE_SO,
  newEnv,
  send,
  setNow,
  USDC,
  type Env as SvmEnv,
} from '../../../packages/shared/test/escrow/harness';
import type { ChainClient, ChainRuntime } from '../src/chain/tx';
import { StreamGapReconciler } from '../src/chain/reconciler';
import { QUICKNODE_WEBHOOK_PATH } from '../src/chain/routes';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { liteSvmClient } from './litesvm-client';
import { loadQnFilter, qnSignedHeaders } from './chain-fixtures';
import { betRow as readBet, logOf, ownDatabase } from './chain-db';
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
const TOKEN = 'qn-litesvm-token-' + randomBytes(8).toString('hex');
const b58 = getBase58Decoder();

/** A landed LiteSVM transaction as a getBlock (encoding json) transaction object. */
function blockTx(tx: Transaction, meta: TransactionMetadata) {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    staticAccounts: Address[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    version: number | 'legacy';
  };
  return {
    meta: {
      err: null,
      innerInstructions: meta
        .innerInstructions()
        .map((ixs, index) => ({
          index,
          instructions: ixs.map((ii) => {
            const ci = ii.instruction();
            return {
              programIdIndex: ci.programIdIndex(),
              accounts: [...ci.accounts()],
              data: b58.decode(ci.data()),
              stackHeight: ii.stackHeight(),
            };
          }),
        }))
        .filter((g) => g.instructions.length > 0),
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: meta.logs(),
    },
    transaction: {
      message: {
        accountKeys: compiled.staticAccounts,
        instructions: compiled.instructions.map((ix) => ({
          programIdIndex: ix.programAddressIndex,
          accounts: ix.accountIndices ?? [],
          data: b58.decode(ix.data ?? new Uint8Array()),
          stackHeight: 1,
        })),
      },
      signatures: [getSignatureFromTransaction(tx)],
    },
    version: compiled.version === 'legacy' ? 'legacy' : compiled.version,
  };
}

run('QuickNode Stream path on LiteSVM transactions (filter -> webhook -> projector)', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let lc: Lifecycle;
  let offset = 0;
  const now = () => Date.now() + offset;
  let keyA: TestKey, keyB: TestKey;
  let A: SignedUp, B: SignedUp;
  let signerA: KeyPairSigner, signerB: KeyPairSigner;
  /** Every successful LiteSVM send, by signature (what a block would carry). */
  const landed = new Map<string, { tx: Transaction; meta: TransactionMetadata }>();
  let blockHeight = 410_000_000;
  const filter = loadQnFilter();

  const install = (o: { client?: ChainClient; timeoutMs?: number } = {}) => {
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => (o.client ? { ...rt, client: o.client } : rt),
        signer: 'server',
        send: { pollMs: 5, resendMs: 50, timeoutMs: o.timeoutMs ?? 2_000 },
        timers: false,
      }),
    );
  };
  /** The LiteSVM client whose status lookups come back null while `hide()` (a lost confirm). */
  const hiding = (hide: () => boolean): ChainClient => ({
    ...rt.client,
    signatureStatus: async (sig, opts) => (hide() ? null : rt.client.signatureStatus(sig, opts)),
  });
  const advance = (ms: number) => {
    offset += ms;
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
  };

  /** QuickNode's side: the block(s) holding `sigs`, through filter.js, signed, POSTed. */
  async function stream(...sigs: string[]) {
    const transactions = sigs.map((s) => {
      const l = landed.get(s);
      if (!l) throw new Error(`no landed tx ${s}`);
      return blockTx(l.tx, l.meta);
    });
    const out = filter.main({
      data: [
        {
          blockHeight: blockHeight++,
          blockTime: Math.floor(now() / 1000),
          parentSlot: 520_000_000,
          blockhash: '9TmP9DSp8AL7hBi3U6XC3sXq1YJ5LPHZwcgbnS45i4G',
          previousBlockhash: '9TmP9DSp8AL7hBi3U6XC3sXq1YJ5LPHZwcgbnS45i4G',
          transactions,
        },
      ],
      metadata: { network: 'solana-devnet', dataset: 'block' },
    });
    const body = new TextEncoder().encode(JSON.stringify(out));
    const res = await fetch(ctx.base + QUICKNODE_WEBHOOK_PATH, {
      method: 'POST',
      headers: qnSignedHeaders(body, TOKEN, now()),
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any>, out };
  }

  const txRow = async (betId: string, kind: 'atomic_lock' | 'resolve' | 'finalize') =>
    (
      await ctx.deps.db
        .select()
        .from(chainTxs)
        .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, kind)))
    )[0]!;
  const betRow = (id: string) => readBet(ctx.deps.db, id);
  const log = (id: string) => logOf(ctx.deps.db, id);
  const cues = async (id: string) =>
    (await log(id))
      .filter((e) => e.type === 'judge.cue')
      .map((e) => (e.envelope as any).payload.cue as string);

  beforeAll(async () => {
    const dbUrl = await ownDatabase(DB_URL!, 'qnproj');
    ctx = await startTestServer({
      now,
      env: {
        DATABASE_URL: dbUrl,
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
        ELEVENLABS_TOOL_SECRET: 'tool-secret',
        QN_STREAM_SECURITY_TOKEN: TOKEN,
      },
    });
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    // Record every landed tx with its metadata (inner instructions) as the block would.
    const sendTx = svm.svm.sendTransaction.bind(svm.svm);
    svm.svm.sendTransaction = (tx: Transaction) => {
      const r = sendTx(tx);
      if (!(r instanceof FailedTransactionMetadata))
        landed.set(getSignatureFromTransaction(tx), { tx, meta: r });
      return r;
    };
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
      programId: ESCROW_PROGRAM_ADDRESS,
      cluster: 'localnet',
    };
    await ctx.deps.db.delete(noncePool); // this database's pool = the SVM's pool
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    install();
    A = await signUpWith('Logan', keyA);
    B = await signUpWith('Jake', keyB);
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
  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, method, path, raw, { ts: now() }));
  };
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });

  /** challenge -> fixture terms -> confirm: the custodial lock is built, signed and sent. */
  async function confirmedBet(): Promise<string> {
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'Stream', kind: 'session' });
    await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code });
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    const betId = bet.json!.bet.bet_id as string;
    expect((await admin(`/v1/demo/bets/${betId}/terms`)).json).toMatchObject({ ok: true });
    expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle();
    return betId;
  }

  const ruling = (betId: string, termsHash: string, outcome: 'A_WINS' | 'B_WINS'): Ruling => ({
    schema_version: 1,
    ruling_id: randomUUID(),
    bet_id: betId,
    outcome,
    claim_result: outcome === 'A_WINS' ? 'NOT_MET' : 'MET',
    confidence: 0.93,
    reason: 'The bottle landed upright in frame 4.',
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
  });

  it('RPC first, Stream second: lock -> resolve -> finalize confirmed by the Stream, no state fight', async () => {
    const betId = await confirmedBet();
    const lockSig = (await txRow(betId, 'atomic_lock')).signature!;
    expect(await betRow(betId)).toMatchObject({
      state: 'LOCKED',
      onchain_status: 'none',
      onchain_pending: 'locked',
      pending_sig: lockSig,
    });
    const seq0 = (await log(betId)).length;

    // The real atomic lock tx: ONE signature, BetCreated + BetAccepted emitted via emit_cpi!
    const s1 = await stream(lockSig);
    expect(s1.out!.txs).toHaveLength(1);
    expect(s1.out!.txs[0]!.events.map((e: any) => e.name)).toEqual(['BetCreated', 'BetAccepted']);
    expect(s1.json).toMatchObject({ ok: true, inserted: 2, published: 2 });
    const locked = await betRow(betId);
    expect(locked).toMatchObject({
      state: 'LOCKED',
      onchain_status: 'locked',
      onchain_pending: null,
      pending_sig: null,
      create_sig: lockSig,
      accept_sig: lockSig,
    });
    expect(locked.locked_at).not.toBeNull();
    expect(locked.resolve_deadline).not.toBeNull();
    expect((await txRow(betId, 'atomic_lock')).stream_seen_at).not.toBeNull();
    expect((await log(betId)).slice(seq0).map((e) => e.type)).toEqual([
      'chain.BetCreated',
      'chain.BetAccepted',
    ]);

    // resolve by the PayoutService (RULED at its own confirm), then the Stream
    await lc.payout.onRuling(betId, ruling(betId, locked.terms_hash!, 'B_WINS'));
    await lc.idle();
    const ruled = await betRow(betId);
    expect(ruled.state).toBe('RULED');
    const resolveSig = (await txRow(betId, 'resolve')).signature!;
    const seq1 = (await log(betId)).length;
    expect((await stream(resolveSig)).json).toMatchObject({ inserted: 1, published: 1 });
    expect(await betRow(betId)).toMatchObject({
      state: 'RULED',
      onchain_status: 'resolved',
      resolve_sig: resolveSig,
      outcome: 'party_b',
      ruling_hash: ruled.ruling_hash,
      evidence_hash: ruled.evidence_hash,
      appeal_deadline: ruled.appeal_deadline,
    });
    expect((await log(betId)).slice(seq1).map((e) => e.type)).toEqual(['chain.BetResolved']);

    // finalize after the appeal window (PAID at the RPC confirm), then the Stream
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toEqual([betId]);
    await lc.idle();
    expect((await betRow(betId)).state).toBe('PAID');
    const finSig = (await txRow(betId, 'finalize')).signature!;
    const seq2 = (await log(betId)).length;
    const s3 = await stream(finSig);
    expect(s3.out!.txs[0]!.events.map((e: any) => e.name)).toEqual(['BetFinalized', 'BetClosed']);
    expect(s3.json).toMatchObject({ inserted: 2, published: 2 });
    const paid = await betRow(betId);
    expect(paid).toMatchObject({
      state: 'PAID',
      onchain_status: 'settled',
      outcome: 'party_b',
      payout_a: 0n,
      payout_b: 2n * USDC,
      payout_via: 'finalize',
      payout_sig: finSig,
      close_sig: finSig,
    });
    expect(paid.settled_at).not.toBeNull();
    expect(paid.closed_at).not.toBeNull();
    expect((await log(betId)).slice(seq2).map((e) => e.type)).toEqual([
      'chain.BetFinalized',
      'chain.BetClosed',
    ]);
    expect((await cues(betId)).filter((c) => c === 'PAID')).toHaveLength(1);

    // QuickNode re-delivers the whole history: nothing changes
    const version = paid.version;
    const again = await stream(lockSig, resolveSig, finSig);
    expect(again.json).toMatchObject({ inserted: 0, duplicates: 5, published: 0 });
    expect((await betRow(betId)).version).toBe(version);
  });

  it('missed lock confirm: the Stream locks the bet; the LockService sweep frees the nonce, no second cue', async () => {
    let hide = true;
    install({ client: hiding(() => hide), timeoutMs: 30 });
    let betId: string;
    try {
      betId = await confirmedBet(); // the lock landed, but its confirm never came back
      expect((await betRow(betId)).state).toBe('AWAITING_LOCK');
      expect((await txRow(betId, 'atomic_lock')).status).toBe('sent');
      const lockSig = (await txRow(betId, 'atomic_lock')).signature!;
      const s = await stream(lockSig);
      expect(s.json).toMatchObject({ inserted: 2, published: 4 });
      expect(await betRow(betId)).toMatchObject({
        state: 'LOCKED',
        onchain_status: 'locked',
        onchain_pending: null,
      });
      expect(await cues(betId)).toContain('LOCKED');
      // the lock row is still the LockService's: its sweep settles it and frees the nonce
      hide = false;
      install({ client: hiding(() => hide) });
      const r = await lc.lock.sweep(now());
      expect(r.landed).toContain(betId);
      await lc.idle();
      const lock = await txRow(betId, 'atomic_lock');
      expect(lock.status).toBe('confirmed');
      const [n] = await ctx.deps.db
        .select()
        .from(noncePool)
        .where(eq(noncePool.nonce_account, lock.nonce_account!));
      expect(n!.status).toBe('free');
      expect((await cues(betId)).filter((c) => c === 'LOCKED')).toHaveLength(1);
      // the LockService did not re-arm pending over the Stream's confirmation
      expect(await betRow(betId)).toMatchObject({ state: 'LOCKED', onchain_pending: null });
    } finally {
      install();
    }
  });

  it('missed finalize confirm: the Stream pays the bet out; the payout reconcile is a no-op', async () => {
    const betId = await confirmedBet();
    const row = await betRow(betId);
    await lc.payout.onRuling(betId, ruling(betId, row.terms_hash!, 'A_WINS'));
    await lc.idle();
    advance(12_000);
    let hide = true;
    install({ client: hiding(() => hide), timeoutMs: 30 });
    try {
      expect(await lc.payout.finalizeDue(now())).not.toContain(betId);
      await lc.idle();
      expect((await betRow(betId)).state).toBe('FINALIZED');
      const fin = await txRow(betId, 'finalize');
      expect(fin.status).toBe('sent');
      const lockSig = (await txRow(betId, 'atomic_lock')).signature!;
      const resolveSig = (await txRow(betId, 'resolve')).signature!;
      const s = await stream(lockSig, resolveSig, fin.signature!);
      expect(s.json).toMatchObject({ ok: true, inserted: 5 });
      expect(await betRow(betId)).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        payout_a: 2n * USDC,
        payout_b: 0n,
        payout_via: 'finalize',
      });
      const states = (await log(betId))
        .filter((e) => e.type === 'bet.state')
        .map((e) => (e.envelope as any).payload);
      expect(states.at(-1)).toMatchObject({
        state: 'PAID',
        prev: 'FINALIZED',
        chain_ack: 'stream',
        reason: 'finalize',
      });
      expect((await cues(betId)).filter((c) => c === 'PAID')).toHaveLength(1);
      // the payout reconcile finds the landed tx later: row confirmed, no second PAID
      hide = false;
      install({ client: hiding(() => hide) });
      await lc.payout.finalizeDue(now());
      await lc.idle();
      expect((await txRow(betId, 'finalize')).status).toBe('confirmed');
      expect((await cues(betId)).filter((c) => c === 'PAID')).toHaveLength(1);
      expect((await betRow(betId)).state).toBe('PAID');
    } finally {
      install();
    }
  });

  describe('Stream-gap reconciler (rpc_poll, DATA-MODEL §8.3)', () => {
    const eventsOf = (sig: string) =>
      ctx.deps.db.select().from(chainEvents).where(eq(chainEvents.signature, sig));

    it('fills what the Stream missed from getTransaction: same projection, observed_via rpc_poll', async () => {
      const gaps = new StreamGapReconciler();
      const betId = await confirmedBet();
      const lockSig = (await txRow(betId, 'atomic_lock')).signature!;
      // the Stream delivered the lock; then it went quiet (paused / out of credits)
      await stream(lockSig);
      await lc.payout.onRuling(betId, ruling(betId, (await betRow(betId)).terms_hash!, 'A_WINS'));
      await lc.idle();
      const resolveSig = (await txRow(betId, 'resolve')).signature!;
      // within STREAM_FALLBACK_MS of the send nothing is polled (the Stream gets its chance)
      expect((await gaps.run(ctx.deps, rt, now() + 1_000)).polled).toBe(0);
      expect(await eventsOf(resolveSig)).toEqual([]);
      advance(12_000);
      expect(await lc.payout.finalizeDue(now())).toEqual([betId]);
      await lc.idle();
      const finSig = (await txRow(betId, 'finalize')).signature!;
      expect(await betRow(betId)).toMatchObject({ state: 'PAID', onchain_status: 'locked' });

      const r = await gaps.run(ctx.deps, rt, now() + 6_000);
      expect(r).toMatchObject({ polled: 2, ingested: 3, missing: 0 });
      expect((await eventsOf(lockSig)).map((e) => e.source)).toEqual(['stream', 'stream']);
      const polled = [...(await eventsOf(resolveSig)), ...(await eventsOf(finSig))];
      expect(polled.map((e) => [e.event_name, e.source, e.slot !== null, e.block_height])).toEqual(
        expect.arrayContaining([
          ['BetResolved', 'rpc_poll', true, null],
          ['BetFinalized', 'rpc_poll', true, null],
          ['BetClosed', 'rpc_poll', true, null],
        ]),
      );
      expect(polled.every((e) => e.applied_at !== null && e.apply_error === null)).toBe(true);
      expect(await betRow(betId)).toMatchObject({
        state: 'PAID',
        onchain_status: 'settled',
        payout_a: 2n * USDC,
        payout_sig: finSig,
        close_sig: finSig,
        resolve_sig: resolveSig,
      });
      const chainEnvs = (await log(betId))
        .filter((e) => e.type.startsWith('chain.'))
        .map((e) => [e.type, (e.envelope as any).payload.observed_via]);
      expect(chainEnvs).toEqual([
        ['chain.BetCreated', 'quicknode_stream'],
        ['chain.BetAccepted', 'quicknode_stream'],
        ['chain.BetResolved', 'rpc_poll'],
        ['chain.BetFinalized', 'rpc_poll'],
        ['chain.BetClosed', 'rpc_poll'],
      ]);
      // rpc_poll never claims to be the Stream
      expect((await txRow(betId, 'finalize')).stream_seen_at).toBeNull();
      // nothing left to poll; a late Stream copy is a pure duplicate
      expect(await gaps.run(ctx.deps, rt, now() + 7_000)).toMatchObject({ polled: 0 });
      expect((await stream(resolveSig, finSig)).json).toMatchObject({ inserted: 0, published: 0 });
    });

    it('no Stream at all and a missed lock confirm: the reconciler locks the bet', async () => {
      const gaps = new StreamGapReconciler();
      let hide = true;
      install({ client: hiding(() => hide), timeoutMs: 30 });
      try {
        const betId = await confirmedBet();
        expect((await betRow(betId)).state).toBe('AWAITING_LOCK');
        const lockSig = (await txRow(betId, 'atomic_lock')).signature!;
        const r = await gaps.run(ctx.deps, { ...rt, client: hiding(() => hide) }, now() + 6_000);
        expect(r.ingested).toBeGreaterThanOrEqual(2);
        expect((await eventsOf(lockSig)).map((e) => [e.event_name, e.source])).toEqual([
          ['BetCreated', 'rpc_poll'],
          ['BetAccepted', 'rpc_poll'],
        ]);
        expect(await betRow(betId)).toMatchObject({ state: 'LOCKED', onchain_status: 'locked' });
        expect(await cues(betId)).toContain('LOCKED');
        hide = false;
      } finally {
        install();
      }
    });

    it('is a no-op without a chain runtime or a client that can getTransaction', async () => {
      const gaps = new StreamGapReconciler();
      expect(await gaps.run(ctx.deps, null, now())).toMatchObject({ polled: 0 });
      const { transaction: _t, ...noTx } = rt.client;
      expect(await gaps.run(ctx.deps, { ...rt, client: noTx }, now() + 6_000)).toMatchObject({
        polled: 0,
      });
    });
  });
});
