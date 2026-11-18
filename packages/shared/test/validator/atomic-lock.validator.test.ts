// Local-validator suite (ESCROW §9.1, TASKS D1-L2): the atomic-lock rows LiteSVM hides, on a real
// Agave 4.1.2 solana-test-validator started by scripts/test-validator.sh (`npm run test:validator`).
//
//   N1   clean lock on Agave, preflight on: one signature, events at outer ix 3 + 4, fee exact
//   N10  doomed lock: preflight on → -32002, 0 lamports, nonce kept; skipPreflight → committed
//        with an error, 15,000 + priority charged, nonce ADVANCED (LiteSVM keeps it)
//   N8, N13, N14, N15, N6 on Agave: each rejected at preflight, 0 lamports, nonce unchanged
//   N11  CU across 50 random bet_ids with the LockService rule (simulated × 1.3, floor), then a
//        cap below the measured max reproduces "exceeded CUs meter"; plus lock timing
//
// Measurements go to stderr (MEASURE lines) and ESCROW_MEASURE_OUT; see docs/measurements.md.
import { getAdvanceNonceAccountInstruction } from '@solana-program/system';
import { getMintToCheckedInstruction, getTransferCheckedInstruction } from '@solana-program/token';
import { getCompiledTransactionMessageDecoder, type Address, type Transaction } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  BetStatus,
  ESCROW_ERROR__INVALID_DEADLINE,
  ESCROW_ERROR__PAUSED,
  ESCROW_ERROR__TERMS_HASH_MISMATCH,
  EscrowEvent,
  findBetPda,
  findVaultPda,
  getCreateBetInstructionAsync,
  getUpdateConfigInstructionAsync,
} from '@youre-on/shared/escrow-client';
import {
  compileLock,
  cosign,
  lockBody,
  MAX_TX_BYTES,
  priorityFee,
  wireSize,
  type LockArgs,
  type NonceRef,
} from '../../src/chain/lock-tx';
import { measure } from '../escrow/measure';
import {
  balance,
  betId,
  clockNow,
  createPoolNonce,
  exists,
  expectPreflightReject,
  HAVE_VALIDATOR,
  hash32,
  readBet,
  readNonce,
  rentExempt,
  send,
  sendAndConfirm,
  setupValidatorEnv,
  simulateCu,
  sleepMs,
  SIG_FEE,
  TOKEN_ACCOUNT_SIZE,
  tokenAmount,
  txInfo,
  USDC,
  type VEnv,
} from './rpc-harness';

const STAKE = 1n * USDC;
const TERMS = hash32(0x7e);
const CU_PRICE = 1_000n;
/**
 * LockService floor until devnet numbers exist (§10.1: measured max + 10%). Highest lock CU seen on
 * local Agave across runs: 67,791 (docs/measurements.md), so 75,000.
 */
const CU_FLOOR = 75_000;
const N11_LOCKS = 50;

/** Custom program error as Agave logs it. */
const customLog = (code: number) => `custom program error: 0x${code.toString(16)}`;

type Lock = { id: Uint8Array; bet: Address; vault: Address; stored: Transaction };

let env: VEnv;

async function buildLock(nonce: NonceRef, over: Partial<LockArgs> = {}): Promise<Lock> {
  const id = over.betId ?? betId(1);
  const now = await clockNow();
  const args: LockArgs = {
    betId: id,
    stakeA: STAKE,
    stakeB: STAKE,
    termsHash: TERMS,
    acceptDeadline: now + 300n,
    cuLimit: 200_000,
    cuPrice: CU_PRICE,
    ...over,
  };
  const [bet] = await findBetPda({ betId: id });
  const [vault] = await findVaultPda({ betId: id });
  return { id, bet, vault, stored: compileLock(env.s.address, nonce, await lockBody(env, args)) };
}

async function liveNonce(account: Address): Promise<NonceRef> {
  return { account, value: await readNonce(account) };
}

async function snapshot() {
  const [s, a, b, aTok, bTok] = await Promise.all([
    balance(env.s.address),
    balance(env.a.address),
    balance(env.b.address),
    tokenAmount(env.aToken),
    tokenAmount(env.bToken),
  ]);
  return { s, a, b, aTok, bTok };
}

/** Rejected at preflight: S paid nothing, A/B untouched, no Bet, the nonce value unchanged. */
async function expectFreeRejection(
  lock: Lock,
  nonce: NonceRef,
  before: Awaited<ReturnType<typeof snapshot>>,
): Promise<void> {
  expect(await snapshot()).toEqual(before);
  expect(await exists(lock.bet)).toBe(false);
  expect(await readNonce(nonce.account)).toBe(nonce.value);
}

function stats(xs: number[]) {
  const s = [...xs].sort((x, y) => x - y);
  return {
    n: s.length,
    min: s[0],
    p50: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
  };
}

const round = (x: number) => Math.round(x);

describe.skipIf(!HAVE_VALIDATOR)('atomic lock on local Agave (solana-test-validator)', () => {
  const nonces: Address[] = [];

  beforeAll(async () => {
    env = await setupValidatorEnv(1_000n * USDC);
    for (let k = 0; k < 4; k++) nonces.push((await createPoolNonce(env, k)).account);
  });

  it('N1 (Agave): clean lock, preflight on: one signature, BetCreated@3 + BetAccepted@4, exact fee', async () => {
    const nonce = await liveNonce(nonces[0]!);
    const lock = await buildLock(nonce, { betId: betId(1) });
    const tx = await cosign(lock.stored, env.a, env.b, env.s);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(compiled.header.numSignerAccounts).toBe(3);
    expect(compiled.staticAccounts).toHaveLength(16);
    const size = wireSize(tx);
    expect(size).toBeLessThanOrEqual(MAX_TX_BYTES);

    const before = await snapshot();
    const landed = await sendAndConfirm(tx);
    expect(landed.err).toBeNull();
    const info = await txInfo(landed.signature);
    expect(info.err).toBeNull();
    expect(info.events).toEqual([
      { outer: 3, kind: EscrowEvent.BetCreated },
      { outer: 4, kind: EscrowEvent.BetAccepted },
    ]);
    // 3 signatures + priority = ceil(200,000 CU × 1,000 µlamports / 1e6) = 200.
    expect(info.fee).toBe(3n * SIG_FEE + priorityFee(200_000, CU_PRICE));

    const { data: bet, len } = await readBet(lock.bet);
    expect(bet.status).toBe(BetStatus.Locked);
    expect(bet.lockedAt).toBe(bet.createdAt);
    expect(bet.rentPayer).toBe(env.s.address);
    expect(await tokenAmount(lock.vault)).toBe(2n * STAKE);
    const rent = (await rentExempt(len)) + (await rentExempt(TOKEN_ACCOUNT_SIZE));
    const after = await snapshot();
    expect(before.s - after.s).toBe(info.fee + rent);
    expect([after.a, after.b]).toEqual([0n, 0n]);
    expect([before.aTok - after.aTok, before.bTok - after.bTok]).toEqual([STAKE, STAKE]);
    expect(await readNonce(nonce.account)).not.toBe(nonce.value);
    measure('N1 lock on Agave', {
      cu: info.cu,
      fee: info.fee,
      bytes: size,
      processedMs: round(landed.processedMs),
      confirmedMs: round(landed.confirmedMs),
    });
  });

  it('N10: doomed lock: preflight on → -32002, free, nonce kept; skipPreflight → charged, nonce advanced', async () => {
    const nonce = await liveNonce(nonces[1]!);
    const lock = await buildLock(nonce, {
      betId: betId(2),
      accept: { expectedTermsHash: hash32(0x01) },
    });
    const tx = await cosign(lock.stored, env.a, env.b, env.s);

    // Preflight on (the server's only mode): refused, costs 0, the nonce is untouched.
    let before = await snapshot();
    const rej = await expectPreflightReject(tx);
    expect(rej.logs.join('\n')).toContain(customLog(ESCROW_ERROR__TERMS_HASH_MISMATCH));
    await expectFreeRejection(lock, nonce, before);

    // The very same bytes with skipPreflight: committed WITH an error, both signatures burned.
    before = await snapshot();
    const landed = await sendAndConfirm(tx, { skipPreflight: true });
    expect(landed.err).not.toBeNull();
    const info = await txInfo(landed.signature);
    expect(info.err).not.toBeNull();
    expect(info.logs.join('\n')).toContain(customLog(ESCROW_ERROR__TERMS_HASH_MISMATCH));
    expect(info.fee).toBe(3n * SIG_FEE + priorityFee(200_000, CU_PRICE));
    const after = await snapshot();
    expect(before.s - after.s).toBe(info.fee);
    expect({ ...after, s: before.s }).toEqual(before); // only S's fee moved
    expect(await exists(lock.bet)).toBe(false);
    expect(await exists(lock.vault)).toBe(false);
    expect(await readNonce(nonce.account)).not.toBe(nonce.value);
    measure('N10 doomed lock on Agave', {
      preflightOn: { lamports: 0, nonceAdvanced: false },
      skipPreflight: { lamports: info.fee, nonceAdvanced: true, cu: info.cu },
    });
  });

  it('N8 (Agave): held past accept_deadline: preflight rejects, 0 lamports, nonce NOT advanced', async () => {
    const nonce = await liveNonce(nonces[2]!);
    const deadline = (await clockNow()) + 3n;
    const lock = await buildLock(nonce, { betId: betId(3), acceptDeadline: deadline });
    const tx = await cosign(lock.stored, env.a, env.b, env.s);
    // Wait (real time) until the cluster clock reaches accept_deadline.
    for (let i = 0; i < 100 && (await clockNow()) < deadline; i++) await sleepMs(200);
    expect(await clockNow()).toBeGreaterThanOrEqual(deadline);
    const before = await snapshot();
    const rej = await expectPreflightReject(tx);
    // create_bet's `now < accept_deadline` (P10) fires before accept_bet's AcceptDeadlinePassed.
    expect(rej.logs.join('\n')).toContain(customLog(ESCROW_ERROR__INVALID_DEADLINE));
    await expectFreeRejection(lock, nonce, before);
  });

  it('N13 (Agave): squatted bet_id: preflight rejects (already in use), free, nonce kept', async () => {
    const nonce = await liveNonce(nonces[2]!);
    const lock = await buildLock(nonce, { betId: betId(4) });
    const tx = await cosign(lock.stored, env.a, env.b, env.s);
    await send(env.m, [
      await getCreateBetInstructionAsync({
        payer: env.m,
        partyA: env.m,
        mint: env.mint,
        partyAToken: env.mToken,
        betId: lock.id,
        partyB: env.b.address,
        stakeA: STAKE,
        stakeB: STAKE,
        termsHash: TERMS,
        acceptDeadline: (await clockNow()) + 300n,
      }),
    ]);
    const before = await snapshot();
    const rej = await expectPreflightReject(tx);
    expect(rej.logs.join('\n')).toMatch(/already in use/);
    expect(await snapshot()).toEqual(before);
    expect((await readBet(lock.bet)).data.partyA).toBe(env.m.address);
    expect(await readNonce(nonce.account)).toBe(nonce.value);
  });

  it('N14 (Agave): paused after signing: preflight rejects Paused, free, nonce kept', async () => {
    const nonce = await liveNonce(nonces[2]!);
    const lock = await buildLock(nonce, { betId: betId(5) });
    const tx = await cosign(lock.stored, env.a, env.b, env.s);
    const setPaused = async (paused: boolean) =>
      send(env.admin, [
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
          paused,
        }),
      ]);
    await setPaused(true);
    try {
      const before = await snapshot();
      const rej = await expectPreflightReject(tx);
      expect(rej.logs.join('\n')).toContain(customLog(ESCROW_ERROR__PAUSED));
      await expectFreeRejection(lock, nonce, before);
    } finally {
      await setPaused(false);
    }
  });

  it("N15 (Agave): A's USDC drops below stake_a after signing: preflight rejects, nothing burned", async () => {
    const nonce = await liveNonce(nonces[2]!);
    const lock = await buildLock(nonce, { betId: betId(6) });
    const signedByA = await cosign(lock.stored, env.a);
    const held = await tokenAmount(env.aToken);
    const drained = held - (STAKE - 1n);
    await send(env.s, [
      getTransferCheckedInstruction({
        source: env.aToken,
        mint: env.mint,
        destination: env.mToken,
        authority: env.a,
        amount: drained,
        decimals: 6,
      }),
    ]);
    try {
      const tx = await cosign(signedByA, env.b, env.s);
      const before = await snapshot();
      const rej = await expectPreflightReject(tx);
      expect(rej.logs.join('\n')).toMatch(/insufficient funds|custom program error: 0x1\b/i);
      await expectFreeRejection(lock, nonce, before);
    } finally {
      // Refill A for the N11 run.
      await send(env.s, [
        getMintToCheckedInstruction({
          mint: env.mint,
          token: env.aToken,
          mintAuthority: env.mintAuthority,
          amount: drained,
          decimals: 6,
        }),
      ]);
    }
  });

  it('N6 (Agave): revoke after A signed: 5,000-lamport advance; the stored lock then fails preflight', async () => {
    const nonce = await liveNonce(nonces[3]!);
    const lock = await buildLock(nonce, { betId: betId(7) });
    const signedByA = await cosign(lock.stored, env.a);
    const revoke = await send(env.s, [
      getAdvanceNonceAccountInstruction({ nonceAccount: nonce.account, nonceAuthority: env.s }),
    ]);
    expect((await txInfo(revoke.signature)).fee).toBe(SIG_FEE);
    const moved: NonceRef = await liveNonce(nonce.account);
    expect(moved.value).not.toBe(nonce.value);
    const tx = await cosign(signedByA, env.b, env.s);
    const before = await snapshot();
    const rej = await expectPreflightReject(tx);
    expect(rej.detail).toMatch(/blockhash|nonce/i);
    await expectFreeRejection(lock, moved, before);
  });

  it(`N11: CU across ${N11_LOCKS} random bet_ids (simulated × 1.3, floor); a cap below max fails; timing`, async () => {
    const nonceAcc = nonces[0]!;
    const sim: number[] = [];
    const used: number[] = [];
    const limits: number[] = [];
    const processed: number[] = [];
    const confirmed: number[] = [];
    for (let i = 0; i < N11_LOCKS; i++) {
      const nonce = await liveNonce(nonceAcc);
      const id = betId(100 + i);
      const deadline = (await clockNow()) + 300n;
      // LockService step 3: simulate the unsigned message, set the limit from the result.
      const probe = await buildLock(nonce, { betId: id, acceptDeadline: deadline });
      const s = await simulateCu(probe.stored);
      expect(s.err).toBeNull();
      const limit = Math.max(Math.ceil(Number(s.units) * 1.3), CU_FLOOR);
      const lock = await buildLock(nonce, { betId: id, acceptDeadline: deadline, cuLimit: limit });
      const landed = await sendAndConfirm(await cosign(lock.stored, env.a, env.b, env.s));
      expect(landed.err).toBeNull();
      const info = await txInfo(landed.signature);
      expect(info.cu).toBeLessThanOrEqual(BigInt(limit));
      sim.push(Number(s.units));
      used.push(Number(info.cu));
      limits.push(limit);
      processed.push(landed.processedMs);
      confirmed.push(landed.confirmedMs);
    }
    const cu = stats(used);
    const max = cu.max!;
    // The executed CU equals the simulated CU for the same bet_id (the limit rule's premise).
    expect(used).toEqual(sim);

    // A cap of (measured max − 1) on a bet_id that needs the max: search fresh ids by simulation
    // (CU steps with create_bet's bump search). Fallback after 400 tries: that id's own CU − 1.
    const nonce = await liveNonce(nonceAcc);
    let pick: { id: Uint8Array; units: number } | undefined;
    let last = { id: betId(200), units: 0 };
    let tries = 0;
    while (!pick && tries < 400) {
      tries++;
      const probe = await buildLock(nonce, { betId: betId(200) });
      last = { id: probe.id, units: Number((await simulateCu(probe.stored)).units) };
      if (last.units >= max) pick = last;
    }
    const cap = (pick ? max : last.units) - 1;
    const lowCap = await buildLock(nonce, { betId: (pick ?? last).id, cuLimit: cap });
    const beforeCap = await snapshot();
    const rej = await expectPreflightReject(await cosign(lowCap.stored, env.a, env.b, env.s));
    // Agave words it by where the meter runs out: inside BPF code or at a syscall/CPI boundary.
    expect(rej.logs.join('\n')).toMatch(/exceeded CUs meter|Computational budget exceeded/);
    await expectFreeRejection(lowCap, nonce, beforeCap);
    measure('N11 low cap on Agave', {
      cap,
      needed: (pick ?? last).units,
      capIsMaxMinus1: pick !== undefined,
      searchTries: tries,
    });

    measure('N11 lock CU on Agave', {
      ...cu,
      over60k: used.filter((x) => x > 60_000).length,
      limitMin: Math.min(...limits),
      limitMax: Math.max(...limits),
    });
    measure('N11 lock timing on Agave (send → status)', {
      processedMs: stats(processed.map(round)),
      confirmedMs: stats(confirmed.map(round)),
    });
  });
});
