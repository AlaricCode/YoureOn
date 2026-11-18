/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// DEMO_MODE nonce shares (security wave 2, auth-02): signups are open and a lock leases one of
// the 5 durable nonces for 300 s, so a stranger's never-signed bets could hold the whole pool and
// fail every demo lock with nonce_pool_exhausted. A bet that is not between two demo players gets
// at most one lease for its parties and never one of the last 2 free nonces (LockService
// assertNonceShare). Over HTTP + Postgres (its own database: it owns nonce_pool) + LiteSVM running
// the real escrow.so. Skips without DATABASE_URL or escrow.so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { betEvents, bets, chainTxs, noncePool } from '@youre-on/db';
import type { Session } from '@youre-on/shared/api';
import { ESCROW_PROGRAM_ADDRESS } from '@youre-on/shared/escrow-client';
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
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { DEMO_RESERVED_NONCES, NON_DEMO_LEASES_PER_USER } from '../src/lock/service';
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
const ADMIN = 'demo-admin-token-for-tests';
const POOL = 4;

run('DEMO_MODE: a stranger cannot lease the nonce pool away from the demo (auth-02)', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let lc: Lifecycle;
  const now = () => Date.now();

  async function fund(owner: KeyPairSigner) {
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

  async function signUpWith(name: string, wallet: TestKey = newKey()): Promise<SignedUp> {
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
  async function funded(name: string): Promise<SignedUp> {
    const wallet = newKey();
    await fund(await createKeyPairSignerFromPrivateKeyBytes(wallet.secret));
    return signUpWith(name, wallet);
  }

  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, method, path, raw, { ts: now() }));
  };
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });

  async function room(owner: SignedUp, ...members: SignedUp[]): Promise<string> {
    const r = await signed(owner, 'POST', '/v1/rooms', { name: 'Pool', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members)
      expect((await signed(m, 'POST', '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    return r.json!.room_id as string;
  }

  /** Challenge -> fixture terms -> confirm (the lock starts) -> the lock build has settled. */
  async function confirmed(a: SignedUp, b: SignedUp, roomId: string): Promise<string> {
    const bet = await signed(a, 'POST', '/v1/bets', {
      room_id: roomId,
      opponent_user_id: b.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    expect((await admin(`/v1/demo/bets/${betId}/terms`)).json).toMatchObject({ ok: true });
    expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle();
    return betId;
  }

  /** 'built' (a nonce is leased) or the reason the lock failed. */
  async function outcome(betId: string): Promise<string> {
    const [lock] = await ctx.deps.db
      .select({ status: chainTxs.status })
      .from(chainTxs)
      .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, 'atomic_lock')));
    if (lock?.status === 'built') return 'built';
    const [row] = await ctx.deps.db.select().from(bets).where(eq(bets.id, betId));
    const states = await ctx.deps.db
      .select({ envelope: betEvents.envelope })
      .from(betEvents)
      .where(and(eq(betEvents.bet_id, betId), eq(betEvents.type, 'bet.state')))
      .orderBy(asc(betEvents.seq));
    const last = states.at(-1)?.envelope as any;
    return `${row!.state}:${last?.payload?.reason ?? ''}`;
  }
  const freeNonces = async () =>
    (await ctx.deps.db.select().from(noncePool).where(eq(noncePool.status, 'free'))).length;

  let A: SignedUp;
  let B: SignedUp;

  beforeAll(async () => {
    ctx = await startTestServer({
      now,
      env: {
        DATABASE_URL: await ownDatabase(DB_URL!, 'nonceshare'),
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
      },
    });
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    const keyA = newKey();
    const keyB = newKey();
    const signerA = await createKeyPairSignerFromPrivateKeyBytes(keyA.secret);
    const signerB = await createKeyPairSignerFromPrivateKeyBytes(keyB.secret);
    for (const owner of [signerA, signerB]) await fund(owner);
    for (let k = 0; k < POOL; k++) await createPoolNonce(svm, k);
    const rt: ChainRuntime = {
      client: liteSvmClient(svm.svm),
      keys: {
        feePayer: svm.s,
        judge: svm.judge,
        appeal: svm.appeal,
        treasury: null,
        // The demo players are whoever holds these (decision D-A).
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
        signer: 'phones', // the default: nobody signs here, so every lease is held
        send: { pollMs: 5, resendMs: 50, timeoutMs: 2_000 },
        timers: false,
      }),
    );
    A = await signUpWith('Demo A', keyA);
    B = await signUpWith('Demo B', keyB);
  }, 60_000);
  afterAll(async () => {
    await lc?.idle();
    lc?.stop();
    await ctx?.server.close();
  });

  it('one lease per stranger pair, never the last 2 free nonces; the demo pair still locks', async () => {
    expect(DEMO_RESERVED_NONCES).toBe(2);
    expect(NON_DEMO_LEASES_PER_USER).toBe(1);
    // One at a time: the SVM funding txs must not race for a blockhash.
    const s1 = await funded('S1');
    const s2 = await funded('S2');
    const s3 = await funded('S3');
    const s4 = await funded('S4');
    // Never get as far as the simulation, so no funds.
    const s5 = await signUpWith('S5');
    const s6 = await signUpWith('S6');
    const strangers = await room(s1, s2, s3, s4, s5, s6);

    // Their first bet leases a nonce (they never sign: it is held for 300 s).
    expect(await outcome(await confirmed(s1, s2, strangers))).toBe('built');
    expect(await freeNonces()).toBe(POOL - 1);
    // S1 already holds one: refused, though 3 are free.
    expect(await outcome(await confirmed(s1, s3, strangers))).toBe(
      'CANCELLED:lock_failed:nonce_pool_exhausted',
    );
    expect(await outcome(await confirmed(s3, s4, strangers))).toBe('built');
    expect(await freeNonces()).toBe(DEMO_RESERVED_NONCES);
    // Only the reserved 2 are left: no stranger gets them.
    expect(await outcome(await confirmed(s5, s6, strangers))).toBe(
      'CANCELLED:lock_failed:nonce_pool_exhausted',
    );

    // The demo pair (the demo-a / demo-b wallets) still locks.
    const demoRoom = await room(A, B);
    expect(await outcome(await confirmed(A, B, demoRoom))).toBe('built');
    expect(await freeNonces()).toBe(DEMO_RESERVED_NONCES - 1);
  }, 60_000);
});
