// Atomic-lock composition rows ESCROW §9.2 N1-N16 (TASKS D1-L2, §6.3) on npm LiteSVM with the
// Codama client. The lock is compiled once into stored bytes and each key signs those bytes
// separately (lock-tx.ts), exactly as LockService does. N17 is the server suite (D2-L2).
//
// What LiteSVM hides (MEASURED, litesvm 1.6.2): a lock that fails IN EXECUTION is charged its fee
// (15,000 + priority) but the durable nonce is NOT advanced, and there is no preflight. Agave
// advances the nonce on a committed failure, and preflight rejects for 0 lamports. Those rows
// (N1, N8, N10, N11, N13-N15 on Agave) are in test/validator (`npm run test:validator`).
//
// Rust overlap (tests/matrix/lock.rs): N1-N6, N8, N9 (landed), N12-N14 there too.
import {
  assertIsFullySignedTransaction,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  verifySignature,
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { getAdvanceNonceAccountInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import {
  BetStatus,
  decodeBet,
  ESCROW_ERROR__INVALID_DEADLINE,
  ESCROW_ERROR__PARTY_MISMATCH,
  ESCROW_ERROR__PAUSED,
  ESCROW_ERROR__STAKE_MISMATCH,
  ESCROW_ERROR__TERMS_HASH_MISMATCH,
  EscrowEvent,
  findBetPda,
  findVaultPda,
  getCloseBetInstructionAsync,
  getCreateBetInstructionAsync,
  getFinalizeInstructionAsync,
  getResolveInstructionAsync,
  getUpdateConfigInstructionAsync,
  Outcome,
} from '@youre-on/shared/escrow-client';
import {
  betId,
  createPoolNonce,
  customError,
  escrowEvents,
  expectOk,
  FUNDED,
  HAVE_SO,
  hash32,
  lamportsOf,
  newEnv,
  now,
  readNonce,
  send,
  setNow,
  SIG_FEE,
  submit,
  TOKEN_ACCOUNT_SIZE,
  tokenAmount,
  USDC,
  type Env,
  type Failed,
  type Sent,
} from './harness';
import {
  compileLock,
  cosign,
  lockBody,
  MAX_TX_BYTES,
  priorityFee,
  wireSize,
  type LockArgs,
  type NonceRef,
} from './lock-tx';
import { measure } from './measure';

const STAKE_A = 5n * USDC;
const STAKE_B = 5n * USDC;
const TERMS = hash32(0x7e);
const CU_LIMIT = 200_000;
const CU_PRICE = 1_000n; // micro-lamports: 200 lamports of priority at 200k CU
/** 3 signatures + priority: what a lock that fails in execution costs S without preflight. */
const LOCK_FEE = 3n * SIG_FEE + priorityFee(CU_LIMIT, CU_PRICE);

/** anchor-lang ErrorCode::AccountNotInitialized. */
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;
/** SystemError::AccountAlreadyInUse, surfaced by Anchor's `init` CPI. */
const SYSTEM_ACCOUNT_ALREADY_IN_USE = 0;
/** spl_token::error::TokenError::InsufficientFunds. */
const TOKEN_INSUFFICIENT_FUNDS = 1;

// litesvm TransactionErrorFieldless (const enum in its .d.ts; mirrored to stay isolatedModules-safe).
const TX_ERR = { AlreadyProcessed: 6, BlockhashNotFound: 7, SignatureFailure: 11 } as const;

type Lock = {
  id: Uint8Array;
  bet: Address;
  vault: Address;
  /** Stored, unsigned bytes. */
  stored: Transaction;
};

async function buildLock(
  env: Env,
  nonce: NonceRef,
  over: Partial<LockArgs> = {},
  tag = 1,
): Promise<Lock> {
  const id = over.betId ?? betId(tag);
  const args: LockArgs = {
    betId: id,
    stakeA: STAKE_A,
    stakeB: STAKE_B,
    termsHash: TERMS,
    acceptDeadline: now(env.svm) + 300n,
    cuLimit: CU_LIMIT,
    cuPrice: CU_PRICE,
    ...over,
  };
  const [bet] = await findBetPda({ betId: id });
  const [vault] = await findVaultPda({ betId: id });
  return { id, bet, vault, stored: compileLock(env.s.address, nonce, await lockBody(env, args)) };
}

/** All three signatures, in the order the server collects them (A, B, then S at submit). */
function signAll(env: Env, tx: Transaction): Promise<Transaction> {
  return cosign(tx, env.a, env.b, env.s);
}

function failed(r: Sent | Failed): Failed['failed'] {
  if (!('failed' in r)) throw new Error('expected the tx to fail, it landed');
  return r.failed;
}

/** The fieldless TransactionError code of a failure, or null for InstructionError etc. */
function txErr(f: Failed['failed']): number | null {
  const e = f.err() as unknown;
  return typeof e === 'number' ? e : null;
}

function snapshot(env: Env) {
  return {
    a: tokenAmount(env.svm, env.aToken),
    b: tokenAmount(env.svm, env.bToken),
    aSol: lamportsOf(env.svm, env.a.address),
    bSol: lamportsOf(env.svm, env.b.address),
    sSol: lamportsOf(env.svm, env.s.address),
  };
}

/**
 * "Nothing moved": no Bet, no vault, both token balances and A's and B's SOL unchanged. S is
 * charged `charged`: 0 for a tx rejected before execution (signature, nonce), LOCK_FEE for one
 * that failed inside an instruction (LiteSVM charges it like Agave's skipPreflight path).
 */
function expectNothingMoved(
  env: Env,
  lock: Lock,
  before: ReturnType<typeof snapshot>,
  charged = 0n,
): void {
  expect(env.svm.getAccount(lock.bet).exists).toBe(false);
  expect(env.svm.getAccount(lock.vault).exists).toBe(false);
  expect(snapshot(env)).toEqual({ ...before, sSol: before.sSol - charged });
}

function betOf(env: Env, addr: Address) {
  const acc = env.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`bet ${addr} missing`);
  return decodeBet(acc).data;
}

/** Fee-payer-only `AdvanceNonceAccount` (revoke; kind `nonce_advance`). */
async function revoke(env: Env, nonce: NonceRef): Promise<Sent> {
  return send(env.svm, env.s, [
    getAdvanceNonceAccountInstruction({ nonceAccount: nonce.account, nonceAuthority: env.s }),
  ]);
}

/** Mallory: an unrelated key with her own SOL and a funded USDC ATA (§9.2 shorthand). */
async function mallory(env: Env): Promise<{ m: KeyPairSigner; token: Address }> {
  const m = await generateKeyPairSigner();
  env.svm.airdrop(m.address, lamports(1_000_000_000n));
  const [token] = await findAssociatedTokenPda({
    owner: m.address,
    mint: env.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await send(env.svm, env.s, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: env.s,
      owner: m.address,
      mint: env.mint,
    }),
    getMintToCheckedInstruction({
      mint: env.mint,
      token,
      mintAuthority: env.s,
      amount: FUNDED,
      decimals: 6,
    }),
  ]);
  return { m, token };
}

describe.skipIf(!HAVE_SO)('atomic lock N rows (ESCROW §9.2, TS LiteSVM)', () => {
  it('N1 + N12: [AdvanceNonce, CU limit, CU price, create_bet, accept_bet] signed by S, A, B', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);

    // The stored bytes: fee payer S first, exactly 3 required signers, 16 unique keys, no ALT.
    const compiled = getCompiledTransactionMessageDecoder().decode(lock.stored.messageBytes);
    expect(compiled.staticAccounts[0]).toBe(env.s.address);
    expect(compiled.header.numSignerAccounts).toBe(3);
    expect(compiled.staticAccounts).toHaveLength(16);
    expect(decompileTransactionMessage(compiled).instructions).toHaveLength(5);
    expect('addressTableLookups' in compiled ? (compiled.addressTableLookups ?? []) : []).toEqual(
      [],
    );
    expect(Object.keys(lock.stored.signatures).sort()).toEqual(
      [env.s.address, env.a.address, env.b.address].sort(),
    );

    // Either phone order: B signs before A here; the bytes never change.
    const bytes = lock.stored.messageBytes;
    const tx = await cosign(await cosign(await cosign(lock.stored, env.b), env.a), env.s);
    expect(tx.messageBytes).toBe(bytes);
    assertIsFullySignedTransaction(tx);

    // N12: wire size recorded, within the packet limit.
    const size = wireSize(tx);
    measure('N12 lock wire size (TS LiteSVM)', { bytes: size, limit: MAX_TX_BYTES });
    expect(size).toBeLessThanOrEqual(MAX_TX_BYTES);

    const before = snapshot(env);
    const sent = expectOk(submit(env.svm, tx));
    measure('N1 lock CU (TS LiteSVM)', { cu: sent.meta.computeUnitsConsumed() });

    const b = betOf(env, lock.bet);
    expect(b.status).toBe(BetStatus.Locked);
    expect(b.lockedAt).toBe(b.createdAt);
    expect(b.rentPayer).toBe(env.s.address);
    expect(tokenAmount(env.svm, lock.vault)).toBe(STAKE_A + STAKE_B);
    expect(tokenAmount(env.svm, env.aToken)).toBe(before.a - STAKE_A);
    expect(tokenAmount(env.svm, env.bToken)).toBe(before.b - STAKE_B);

    // One signature: BetCreated under outer ix 3, BetAccepted under outer ix 4.
    expect(escrowEvents(sent).map((e) => [e.outer, e.kind])).toEqual([
      [3, EscrowEvent.BetCreated],
      [4, EscrowEvent.BetAccepted],
    ]);

    // A and B SOL unchanged (0); S charged 15,000 + priority, plus the Bet + vault rent it fronts.
    expect(lamportsOf(env.svm, env.a.address)).toBe(0n);
    expect(lamportsOf(env.svm, env.b.address)).toBe(0n);
    const betAcc = env.svm.getAccount(lock.bet);
    const rent =
      env.svm.minimumBalanceForRentExemption(BigInt(betAcc.exists ? betAcc.data.length : 0)) +
      env.svm.minimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
    expect(before.sSol - lamportsOf(env.svm, env.s.address)).toBe(
      3n * SIG_FEE + priorityFee(CU_LIMIT, CU_PRICE) + rent,
    );
    expect(readNonce(env.svm, nonce.account)).not.toBe(nonce.value);
  });

  it('N2: only A signed (B slot empty): rejected for the missing signature, nothing moves', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);
    const partial = await cosign(lock.stored, env.a, env.s);
    expect(partial.signatures[env.b.address]).toBeNull();
    // The client refuses to treat it as sendable...
    expect(() => assertIsFullySignedTransaction(partial)).toThrow();
    // ...and the runtime rejects the empty (all-zero) slot on the wire outright.
    const wire = {
      ...partial,
      signatures: { ...partial.signatures, [env.b.address]: new Uint8Array(64) as SignatureBytes },
    };
    const before = snapshot(env);
    expect(txErr(failed(submit(env.svm, wire)))).toBe(TX_ERR.SignatureFailure);
    expectNothingMoved(env, lock, before);
    expect(readNonce(env.svm, nonce.account)).toBe(nonce.value);
  });

  it('N3: accept_bet fails inside the lock (terms hash / stake_b / party_a): whole tx fails', async () => {
    const cases = [
      [{ expectedTermsHash: hash32(0x01) }, ESCROW_ERROR__TERMS_HASH_MISMATCH],
      [{ expectedStakeB: STAKE_B + 1n }, ESCROW_ERROR__STAKE_MISMATCH],
      [{ expectedPartyA: (await generateKeyPairSigner()).address }, ESCROW_ERROR__PARTY_MISMATCH],
    ] as const;
    for (const [accept, code] of cases) {
      const env = await newEnv();
      const nonce = await createPoolNonce(env, 0);
      const lock = await buildLock(env, nonce, { accept });
      const before = snapshot(env);
      const f = failed(submit(env.svm, await signAll(env, lock.stored)));
      // accept_bet is outer ix 4; create_bet (ix 3) had already run and is rolled back.
      expect(customError(f)).toEqual({ index: 4, code });
      expectNothingMoved(env, lock, before, LOCK_FEE);
    }
  });

  it('N4: reversed order [..., accept_bet, create_bet]: AccountNotInitialized, nothing created', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce, { reversed: true });
    const before = snapshot(env);
    const f = failed(submit(env.svm, await signAll(env, lock.stored)));
    expect(customError(f)).toEqual({ index: 3, code: ANCHOR_ACCOUNT_NOT_INITIALIZED });
    expectNothingMoved(env, lock, before, LOCK_FEE);
  });

  it('N5: signed, then submitted after 300 blockhash expiries: the durable nonce keeps it valid', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);
    const tx = await signAll(env, lock.stored);
    for (let i = 0; i < 300; i++) env.svm.expireBlockhash();
    expectOk(submit(env.svm, tx));
    expect(betOf(env, lock.bet).status).toBe(BetStatus.Locked);
  });

  it('N6: revoke after A signed, and after both signed: the stored lock is dead, nothing moves', async () => {
    for (const signedBeforeRevoke of ['A', 'A+B'] as const) {
      const env = await newEnv();
      const nonce = await createPoolNonce(env, 0);
      const lock = await buildLock(env, nonce);
      let tx = await cosign(lock.stored, env.a);
      if (signedBeforeRevoke === 'A+B') tx = await cosign(tx, env.b);

      // Fee-payer-only revoke: one signature, 5,000 lamports, the nonce moves.
      const sBefore = lamportsOf(env.svm, env.s.address);
      await revoke(env, nonce);
      expect(sBefore - lamportsOf(env.svm, env.s.address)).toBe(SIG_FEE);
      expect(readNonce(env.svm, nonce.account)).not.toBe(nonce.value);

      // The late signature(s) arrive and the server submits the stored bytes anyway.
      if (signedBeforeRevoke === 'A') tx = await cosign(tx, env.b);
      tx = await cosign(tx, env.s);
      const before = snapshot(env);
      expect(txErr(failed(submit(env.svm, tx)))).toBe(TX_ERR.BlockhashNotFound);
      expectNothingMoved(env, lock, before);
    }
  });

  it('N7: two bets built on the same nonce value: the first lands, the second fails', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const first = await buildLock(env, nonce, {}, 1);
    const second = await buildLock(env, nonce, {}, 2);
    const tx1 = await signAll(env, first.stored);
    const tx2 = await signAll(env, second.stored);
    expectOk(submit(env.svm, tx1));
    expect(betOf(env, first.bet).status).toBe(BetStatus.Locked);
    const before = snapshot(env);
    expect(txErr(failed(submit(env.svm, tx2)))).toBe(TX_ERR.BlockhashNotFound);
    expectNothingMoved(env, second, before);
  });

  it('N8: submitted at accept_deadline (warp): rejected, nothing moves; at deadline - 1 it lands', async () => {
    {
      const env = await newEnv();
      const nonce = await createPoolNonce(env, 0);
      const lock = await buildLock(env, nonce);
      const tx = await signAll(env, lock.stored);
      setNow(env.svm, now(env.svm) + 300n); // = accept_deadline
      const before = snapshot(env);
      const f = failed(submit(env.svm, tx));
      // create_bet's own bound `now < accept_deadline` (P10) fires first, at outer ix 3, so the
      // error is InvalidDeadline; accept_bet's AcceptDeadlinePassed is unreachable inside a lock.
      expect(customError(f)).toEqual({ index: 3, code: ESCROW_ERROR__INVALID_DEADLINE });
      expectNothingMoved(env, lock, before, LOCK_FEE);
      // LiteSVM keeps the nonce on an execution failure; Agave's preflight-on path: test/validator.
      expect(readNonce(env.svm, nonce.account)).toBe(nonce.value);
    }
    {
      const env = await newEnv();
      const nonce = await createPoolNonce(env, 0);
      const lock = await buildLock(env, nonce);
      const tx = await signAll(env, lock.stored);
      setNow(env.svm, now(env.svm) + 299n);
      expectOk(submit(env.svm, tx));
      expect(betOf(env, lock.bet).status).toBe(BetStatus.Locked);
    }
  });

  it('N9: replay a landed lock, then again after the bet settled and close_bet freed the PDA', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);
    const tx = await signAll(env, lock.stored);
    const wire = getTransactionEncoder().encode(tx);
    expectOk(submit(env.svm, tx));

    // Same bytes again: rejected by the advanced nonce (or the status cache), charged nothing.
    const sBefore = lamportsOf(env.svm, env.s.address);
    expect([TX_ERR.AlreadyProcessed, TX_ERR.BlockhashNotFound]).toContain(
      txErr(failed(submit(env.svm, tx))),
    );
    expect(lamportsOf(env.svm, env.s.address)).toBe(sBefore);

    // With the status cache disabled, the nonce alone still rejects it.
    env.svm.withTransactionHistory(0n);
    expect(txErr(failed(submit(env.svm, tx)))).toBe(TX_ERR.BlockhashNotFound);

    // Settle: resolve → (appeal window) → [finalize, close_bet]. Bet + vault PDAs are freed.
    await send(env.svm, env.s, [
      await getResolveInstructionAsync({
        payer: env.s,
        judgeAuthority: env.judge,
        bet: lock.bet,
        outcome: Outcome.PartyA,
        evidenceHash: hash32(0xe1),
        rulingHash: hash32(0x91),
      }),
    ]);
    setNow(env.svm, betOf(env, lock.bet).appealDeadline);
    await send(env.svm, env.s, [
      await getFinalizeInstructionAsync({
        payer: env.s,
        bet: lock.bet,
        vault: lock.vault,
        mint: env.mint,
        partyAToken: env.aToken,
        partyBToken: env.bToken,
      }),
      await getCloseBetInstructionAsync({
        payer: env.s,
        bet: lock.bet,
        vault: lock.vault,
        mint: env.mint,
        rentPayer: env.s.address,
      }),
    ]);
    expect(env.svm.getAccount(lock.bet).exists).toBe(false);
    expect(env.svm.getAccount(lock.vault).exists).toBe(false);

    // A re-run would re-create the bet and pull both stakes again; the nonce makes it impossible.
    const before = snapshot(env);
    expect(getTransactionEncoder().encode(tx)).toEqual(wire);
    expect(txErr(failed(submit(env.svm, tx)))).toBe(TX_ERR.BlockhashNotFound);
    expectNothingMoved(env, lock, before);
  });

  it("N13: Mallory squats A's bet_id first: the lock fails (already in use); B's stake never moves", async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);
    const tx = await signAll(env, lock.stored);
    const { m, token } = await mallory(env);
    await send(env.svm, m, [
      await getCreateBetInstructionAsync({
        payer: m,
        partyA: m,
        mint: env.mint,
        partyAToken: token,
        betId: lock.id,
        partyB: env.b.address,
        stakeA: STAKE_A,
        stakeB: STAKE_B,
        termsHash: TERMS,
        acceptDeadline: now(env.svm) + 300n,
      }),
    ]);
    const before = snapshot(env);
    const f = failed(submit(env.svm, tx));
    expect(customError(f)).toEqual({ index: 3, code: SYSTEM_ACCOUNT_ALREADY_IN_USE });
    expect(snapshot(env)).toEqual({ ...before, sSol: before.sSol - LOCK_FEE });
    const squat = betOf(env, lock.bet);
    expect(squat.partyA).toBe(m.address);
    expect(squat.status).toBe(BetStatus.Open);
    expect(readNonce(env.svm, nonce.account)).toBe(nonce.value);
  });

  it('N14: config.paused = true after signing: the lock fails Paused, nothing moves', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);
    const tx = await signAll(env, lock.stored);
    await send(env.svm, env.admin, [
      await getUpdateConfigInstructionAsync({
        admin: env.admin,
        newAdmin: null,
        judgeAuthority: null,
        appealAuthority: null,
        maxStake: null,
        appealWindowSecs: null,
        acceptDeadlineSecs: null,
        resolveDeadlineSecs: null,
        appealResolveSecs: null,
        allowedMints: null,
        paused: true,
      }),
    ]);
    const before = snapshot(env);
    expect(customError(failed(submit(env.svm, tx)))).toEqual({
      index: 3,
      code: ESCROW_ERROR__PAUSED,
    });
    expectNothingMoved(env, lock, before, LOCK_FEE);
  });

  it("N15: A's USDC drops below stake_a after A signed: the lock fails, nothing moves", async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const lock = await buildLock(env, nonce);
    const signedByA = await cosign(lock.stored, env.a);

    // A moves funds out (S pays the fee; A still holds 0 SOL), leaving stake_a - 1.
    const { token: sink } = await mallory(env);
    const keep = STAKE_A - 1n;
    await send(env.svm, env.s, [
      getTransferCheckedInstruction({
        source: env.aToken,
        mint: env.mint,
        destination: sink,
        authority: env.a,
        amount: tokenAmount(env.svm, env.aToken) - keep,
        decimals: 6,
      }),
    ]);
    expect(tokenAmount(env.svm, env.aToken)).toBe(keep);

    const tx = await cosign(signedByA, env.b, env.s);
    const before = snapshot(env);
    // create_bet's transfer_checked CPI (outer ix 3) fails in SPL Token.
    expect(customError(failed(submit(env.svm, tx)))).toEqual({
      index: 3,
      code: TOKEN_INSUFFICIENT_FUNDS,
    });
    expectNothingMoved(env, lock, before, LOCK_FEE);
    expect(readNonce(env.svm, nonce.account)).toBe(nonce.value);
  });

  it("N16: terms edited after A signed: A's signature fails on the new bytes; old nonce revoked", async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const old = await buildLock(env, nonce, { termsHash: TERMS }, 1);
    const signedByA = await cosign(old.stored, env.a);
    const sigA = signedByA.signatures[env.a.address] as SignatureBytes;
    expect(await verifySignature(env.a.keyPair.publicKey, sigA, old.stored.messageBytes)).toBe(
      true,
    );

    // Terms edit: revoke the old nonce, continue on a new bet_id with the new terms (SCHEMAS §9.2).
    await revoke(env, nonce);
    const fresh: NonceRef = { account: nonce.account, value: readNonce(env.svm, nonce.account) };
    const NEW_TERMS = hash32(0x7f);
    const next = await buildLock(env, fresh, { termsHash: NEW_TERMS }, 2);
    expect(next.stored.messageBytes).not.toEqual(old.stored.messageBytes);

    // A's stored signature does not verify over the new message...
    expect(await verifySignature(env.a.keyPair.publicKey, sigA, next.stored.messageBytes)).toBe(
      false,
    );
    // ...so grafting it onto the new bytes is rejected by the runtime.
    const grafted = await cosign(
      { ...next.stored, signatures: { ...next.stored.signatures, [env.a.address]: sigA } },
      env.b,
      env.s,
    );
    let before = snapshot(env);
    expect(txErr(failed(submit(env.svm, grafted)))).toBe(TX_ERR.SignatureFailure);
    expectNothingMoved(env, next, before);

    // The old message, completed late by B and S, is dead (revoked nonce).
    const lateOld = await cosign(signedByA, env.b, env.s);
    before = snapshot(env);
    expect(txErr(failed(submit(env.svm, lateOld)))).toBe(TX_ERR.BlockhashNotFound);
    expectNothingMoved(env, old, before);

    // A re-authorizes the new bytes; the new lock lands with the new terms.
    expectOk(submit(env.svm, await signAll(env, next.stored)));
    expect(betOf(env, next.bet)).toMatchObject({ status: BetStatus.Locked, termsHash: NEW_TERMS });
    expect(env.svm.getAccount(old.bet).exists).toBe(false);
  });
});
