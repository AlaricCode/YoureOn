// CU1 (ESCROW §9.2, budgets §10.1): compute units of every instruction, standalone and in the
// bundled `[terminal ix, close_bet]` form the server sends, each asserted under its §10.1 budget
// (the top of each estimate range). The lock is measured across 64 random bet_ids because
// create_bet's `init` bump search varies per id. The Agave numbers (N11) are in test/validator;
// both go to docs/measurements.md (ESCROW_MEASURE_OUT=<file> appends JSON lines).
import { getAdvanceNonceAccountInstruction } from '@solana-program/system';
import type { Address, Instruction } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
  decodeBet,
  findBetPda,
  findVaultPda,
  getAcceptBetInstructionAsync,
  getAppealInstructionAsync,
  getCancelOpenBetInstructionAsync,
  getCloseBetInstructionAsync,
  getConcedeInstructionAsync,
  getCreateBetInstructionAsync,
  getFinalizeInstructionAsync,
  getResolveAppealInstructionAsync,
  getResolveInstructionAsync,
  getTimeoutRefundInstructionAsync,
  getUpdateConfigInstructionAsync,
  Outcome,
} from '@youre-on/shared/escrow-client';
import {
  betId,
  createPoolNonce,
  expectOk,
  HAVE_SO,
  hash32,
  newEnv,
  now,
  readNonce,
  send,
  setNow,
  submit,
  USDC,
  type Env,
} from './harness';
import { cosign, compileLock, lockBody } from './lock-tx';
import { measure } from './measure';

const STAKE = 5n * USDC;
const TERMS = hash32(0x7e);

/**
 * §10.1 budgets (upper end of each estimate). Config ixs have no estimate: the 200k per-ix default.
 * The lock's budget is create_bet + accept_bet (55k + 25k): §10.1 leaves it PENDING (N11).
 */
const BUDGET = {
  initialize_config: 200_000,
  update_config: 200_000,
  create_bet: 55_000,
  accept_bet: 25_000,
  lock: 80_000,
  nonce_advance: 3_000,
  resolve: 10_000,
  appeal: 10_000,
  payout: 35_000, // finalize, concede, resolve_appeal, timeout_refund, cancel_open_bet (standalone)
  close_bet: 20_000,
  bundled: 55_000, // payout ix + close_bet in one tx
} as const;

type Row = { ix: string; cu: bigint; budget: number };
const rows: Row[] = [];

async function cu(env: Env, label: string, budget: number, ixs: Instruction[], signer = env.s) {
  const sent = await send(env.svm, signer, ixs);
  const used = sent.meta.computeUnitsConsumed();
  rows.push({ ix: label, cu: used, budget });
  return used;
}

async function pdas(id: Uint8Array): Promise<{ bet: Address; vault: Address }> {
  return {
    bet: (await findBetPda({ betId: id }))[0],
    vault: (await findVaultPda({ betId: id }))[0],
  };
}

function createIx(env: Env, id: Uint8Array) {
  return getCreateBetInstructionAsync({
    payer: env.s,
    partyA: env.a,
    mint: env.mint,
    partyAToken: env.aToken,
    betId: id,
    partyB: env.b.address,
    stakeA: STAKE,
    stakeB: STAKE,
    termsHash: TERMS,
    acceptDeadline: now(env.svm) + 300n,
  });
}

async function acceptIx(env: Env, id: Uint8Array) {
  const { bet, vault } = await pdas(id);
  return getAcceptBetInstructionAsync({
    payer: env.s,
    partyB: env.b,
    bet,
    vault,
    mint: env.mint,
    partyBToken: env.bToken,
    expectedTermsHash: TERMS,
    expectedStakeA: STAKE,
    expectedStakeB: STAKE,
    expectedPartyA: env.a.address,
  });
}

/** Sequential create + accept (not measured), leaving a Locked bet. */
async function locked(env: Env, n: number): Promise<{ bet: Address; vault: Address }> {
  const id = betId(n);
  await send(env.svm, env.s, [await createIx(env, id), await acceptIx(env, id)]);
  return pdas(id);
}

async function resolveIx(env: Env, bet: Address, outcome = Outcome.PartyA) {
  return getResolveInstructionAsync({
    payer: env.s,
    judgeAuthority: env.judge,
    bet,
    outcome,
    evidenceHash: hash32(0xe1),
    rulingHash: hash32(0x91),
  });
}

function payoutAccounts(env: Env, p: { bet: Address; vault: Address }) {
  return {
    payer: env.s,
    bet: p.bet,
    vault: p.vault,
    mint: env.mint,
    partyAToken: env.aToken,
    partyBToken: env.bToken,
  };
}

function closeIx(env: Env, p: { bet: Address; vault: Address }) {
  return getCloseBetInstructionAsync({
    payer: env.s,
    bet: p.bet,
    vault: p.vault,
    mint: env.mint,
    rentPayer: env.s.address,
  });
}

function appealDeadline(env: Env, bet: Address): bigint {
  const acc = env.svm.getAccount(bet);
  if (!acc.exists) throw new Error('bet missing');
  return decodeBet(acc).data.appealDeadline;
}

describe.skipIf(!HAVE_SO)('CU1: compute units per instruction vs ESCROW §10.1 (TS LiteSVM)', () => {
  it('every instruction stays under its budget', async () => {
    const env = await newEnv();
    rows.push({
      ix: 'initialize_config',
      cu: env.init!.meta.computeUnitsConsumed(),
      budget: BUDGET.initialize_config,
    });
    await cu(
      env,
      'update_config',
      BUDGET.update_config,
      [
        await getUpdateConfigInstructionAsync({
          admin: env.admin,
          newAdmin: null,
          judgeAuthority: null,
          appealAuthority: null,
          maxStake: 50n * USDC,
          appealWindowSecs: null,
          acceptDeadlineSecs: null,
          resolveDeadlineSecs: null,
          appealResolveSecs: null,
          allowedMints: null,
          paused: null,
        }),
      ],
      env.admin,
    );

    // Sequential fallback: create_bet then accept_bet, each alone.
    const seq = betId(1);
    await cu(env, 'create_bet (standalone)', BUDGET.create_bet, [await createIx(env, seq)]);
    await cu(env, 'accept_bet (standalone)', BUDGET.accept_bet, [await acceptIx(env, seq)]);

    // resolve → appeal → resolve_appeal (standalone) → close_bet (standalone).
    const ap = await pdas(seq);
    await cu(env, 'resolve', BUDGET.resolve, [await resolveIx(env, ap.bet)]);
    await cu(env, 'appeal', BUDGET.appeal, [
      await getAppealInstructionAsync({ payer: env.s, appellant: env.b, bet: ap.bet }),
    ]);
    await cu(env, 'resolve_appeal (standalone)', BUDGET.payout, [
      await getResolveAppealInstructionAsync({
        ...payoutAccounts(env, ap),
        appealAuthority: env.appeal,
        finalOutcome: Outcome.Split,
        appealRulingHash: hash32(0xa9),
      }),
    ]);
    await cu(env, 'close_bet (standalone)', BUDGET.close_bet, [await closeIx(env, ap)]);

    // finalize: standalone, then bundled with close_bet.
    for (const [n, bundled] of [
      [2, false],
      [3, true],
    ] as const) {
      const p = await locked(env, n);
      await send(env.svm, env.s, [await resolveIx(env, p.bet)]);
      setNow(env.svm, appealDeadline(env, p.bet));
      const fin = await getFinalizeInstructionAsync(payoutAccounts(env, p));
      if (bundled) {
        await cu(env, '[finalize, close_bet]', BUDGET.bundled, [fin, await closeIx(env, p)]);
      } else {
        await cu(env, 'finalize (standalone)', BUDGET.payout, [fin]);
        await send(env.svm, env.s, [await closeIx(env, p)]);
      }
    }

    // concede by the loser (B after a PartyA ruling): standalone and bundled.
    for (const [n, bundled] of [
      [4, false],
      [5, true],
    ] as const) {
      const p = await locked(env, n);
      await send(env.svm, env.s, [await resolveIx(env, p.bet)]);
      const ix = await getConcedeInstructionAsync({ ...payoutAccounts(env, p), party: env.b });
      if (bundled)
        await cu(env, '[concede, close_bet]', BUDGET.bundled, [ix, await closeIx(env, p)]);
      else await cu(env, 'concede (standalone)', BUDGET.payout, [ix]);
    }

    // resolve_appeal bundled.
    {
      const p = await locked(env, 6);
      await send(env.svm, env.s, [await resolveIx(env, p.bet)]);
      await send(env.svm, env.s, [
        await getAppealInstructionAsync({ payer: env.s, appellant: env.b, bet: p.bet }),
      ]);
      const ix = await getResolveAppealInstructionAsync({
        ...payoutAccounts(env, p),
        appealAuthority: env.appeal,
        finalOutcome: Outcome.PartyB,
        appealRulingHash: hash32(0xa9),
      });
      await cu(env, '[resolve_appeal, close_bet]', BUDGET.bundled, [ix, await closeIx(env, p)]);
    }

    // timeout_refund from Locked past resolve_deadline: standalone and bundled.
    for (const [n, bundled] of [
      [7, false],
      [8, true],
    ] as const) {
      const p = await locked(env, n);
      const acc = env.svm.getAccount(p.bet);
      if (!acc.exists) throw new Error('bet missing');
      setNow(env.svm, decodeBet(acc).data.resolveDeadline);
      const ix = await getTimeoutRefundInstructionAsync(payoutAccounts(env, p));
      if (bundled) {
        await cu(env, '[timeout_refund, close_bet]', BUDGET.bundled, [ix, await closeIx(env, p)]);
      } else {
        await cu(env, 'timeout_refund (standalone)', BUDGET.payout, [ix]);
      }
    }

    // cancel_open_bet by A: standalone and bundled.
    for (const [n, bundled] of [
      [9, false],
      [10, true],
    ] as const) {
      const id = betId(n);
      await send(env.svm, env.s, [await createIx(env, id)]);
      const p = await pdas(id);
      const ix = await getCancelOpenBetInstructionAsync({
        payer: env.s,
        canceller: env.a,
        bet: p.bet,
        vault: p.vault,
        mint: env.mint,
        partyAToken: env.aToken,
      });
      if (bundled) {
        await cu(env, '[cancel_open_bet, close_bet]', BUDGET.bundled, [ix, await closeIx(env, p)]);
      } else {
        await cu(env, 'cancel_open_bet (standalone)', BUDGET.payout, [ix]);
      }
    }

    // nonce_advance (revoke).
    const nonce = await createPoolNonce(env, 0);
    await cu(env, 'nonce_advance', BUDGET.nonce_advance, [
      getAdvanceNonceAccountInstruction({ nonceAccount: nonce.account, nonceAuthority: env.s }),
    ]);

    for (const r of rows) measure('CU1 (TS LiteSVM)', { ...r });
    for (const r of rows) expect(Number(r.cu), r.ix).toBeLessThan(r.budget);
  });

  it('atomic lock CU across 64 random bet_ids stays under the lock budget', async () => {
    const env = await newEnv();
    const nonce = await createPoolNonce(env, 0);
    const used: number[] = [];
    for (let i = 0; i < 64; i++) {
      const value = readNonce(env.svm, nonce.account);
      const ixs = await lockBody(env, {
        betId: betId(i),
        stakeA: 1n * USDC,
        stakeB: 1n * USDC,
        termsHash: TERMS,
        acceptDeadline: now(env.svm) + 300n,
        cuPrice: 1_000n,
      });
      const tx = await cosign(
        compileLock(env.s.address, { account: nonce.account, value }, ixs),
        env.a,
        env.b,
        env.s,
      );
      used.push(Number(expectOk(submit(env.svm, tx)).meta.computeUnitsConsumed()));
    }
    used.sort((x, y) => x - y);
    const stats = {
      n: used.length,
      min: used[0],
      p50: used[Math.floor(used.length / 2)],
      max: used[used.length - 1],
    };
    measure('CU1 lock across bet_ids (TS LiteSVM)', stats);
    expect(stats.max).toBeLessThan(BUDGET.lock);
  });
});
