// Sequential-fallback lock rows ESCROW §9.2 A14, A15 (§5.0.3, LOCK_MODE=sequential) on npm LiteSVM
// with the Codama client. Two transactions, each with a recent blockhash and no nonce: A's
// `create_bet` and B's `accept_bet`, fee payer S. "B first": B's phone signs its `accept_bet` before
// the Bet exists and the server holds the signed tx until `create_bet` lands (A14). A held tx whose
// blockhash expired is dead: `BlockhashNotFound`, nothing moves, and B re-authorizes (A15).
import { FailedTransactionMetadata } from 'litesvm';
import { describe, expect, it } from 'vitest';

import {
  BetStatus,
  decodeBet,
  findBetPda,
  findVaultPda,
  getAcceptBetInstructionAsync,
  getCreateBetInstructionAsync,
} from '@youre-on/shared/escrow-client';
import {
  betId,
  buildTx,
  expectOk,
  FUNDED,
  HAVE_SO,
  hash32,
  lamportsOf,
  newEnv,
  now,
  submit,
  tokenAmount,
  USDC,
  type Env,
} from './harness';

const STAKE_A = 5n * USDC;
const STAKE_B = 3n * USDC;
const TERMS = hash32(0x5e);
/**
 * Agave accepts a blockhash for 150 slots. LiteSVM (MEASURED, litesvm 1.6.2) accepts only the
 * LATEST one: a single expireBlockhash() already kills a held tx. So A14 lands create_bet with
 * `svm.sendTransaction` (no expiry, as if both landed within the window), and A15 expires past
 * the Agave window anyway so the row means the same thing on both.
 */
const PAST_BLOCKHASH_WINDOW = 151;

// litesvm TransactionErrorFieldless.BlockhashNotFound (const enum; mirrored like atomic-lock.test).
const TX_ERR_BLOCKHASH_NOT_FOUND = 7;

async function seqIxs(env: Env, id: Uint8Array) {
  const [bet] = await findBetPda({ betId: id });
  const [vault] = await findVaultPda({ betId: id });
  const create = await getCreateBetInstructionAsync({
    payer: env.s,
    partyA: env.a,
    mint: env.mint,
    partyAToken: env.aToken,
    betId: id,
    partyB: env.b.address,
    stakeA: STAKE_A,
    stakeB: STAKE_B,
    termsHash: TERMS,
    acceptDeadline: now(env.svm) + 300n,
  });
  const accept = await getAcceptBetInstructionAsync({
    payer: env.s,
    partyB: env.b,
    bet,
    vault,
    mint: env.mint,
    partyBToken: env.bToken,
    expectedTermsHash: TERMS,
    expectedStakeA: STAKE_A,
    expectedStakeB: STAKE_B,
    expectedPartyA: env.a.address,
  });
  return { bet, vault, create, accept };
}

function betOf(env: Env, addr: Parameters<Env['svm']['getAccount']>[0]) {
  const acc = env.svm.getAccount(addr);
  if (!acc.exists) throw new Error(`bet ${addr} missing`);
  return decodeBet(acc).data;
}

describe.skipIf(!HAVE_SO)('sequential fallback A14/A15 (ESCROW §9.2, §5.0.3, TS LiteSVM)', () => {
  it('A14: B signs accept_bet before the Bet exists; submitted after create_bet lands it locks', async () => {
    const env = await newEnv();
    const id = betId(14);
    const { bet, vault, create, accept } = await seqIxs(env, id);

    // B authorizes first: B's device signs its own tx (S co-signs as fee payer) while the Bet
    // does not exist yet. The server holds it.
    const heldB = await buildTx(env.svm, env.s, [accept]);
    expect(env.svm.getAccount(bet).exists).toBe(false);

    // A authorizes: create_bet lands alone. B's stake has not moved.
    const createTx = await buildTx(env.svm, env.s, [create]);
    const created = env.svm.sendTransaction(createTx);
    if (created instanceof FailedTransactionMetadata) throw new Error(created.toString());
    expect(betOf(env, bet).status).toBe(BetStatus.Open);
    expect(tokenAmount(env.svm, env.aToken)).toBe(FUNDED - STAKE_A);
    expect(tokenAmount(env.svm, env.bToken)).toBe(FUNDED);

    // The held tx, still within its blockhash lifetime, is submitted unchanged.
    expectOk(submit(env.svm, heldB));
    const locked = betOf(env, bet);
    expect(locked.status).toBe(BetStatus.Locked);
    expect(tokenAmount(env.svm, vault)).toBe(STAKE_A + STAKE_B);
    expect(tokenAmount(env.svm, env.bToken)).toBe(FUNDED - STAKE_B);
    // Device keys never pay (§5.0).
    expect(lamportsOf(env.svm, env.a.address)).toBe(0n);
    expect(lamportsOf(env.svm, env.b.address)).toBe(0n);
  });

  it('A15: a held accept_bet past its blockhash lifetime fails BlockhashNotFound; a fresh one locks', async () => {
    const env = await newEnv();
    const id = betId(15);
    const { bet, vault, create, accept } = await seqIxs(env, id);

    const heldB = await buildTx(env.svm, env.s, [accept]);
    expectOk(submit(env.svm, await buildTx(env.svm, env.s, [create])));
    expect(betOf(env, bet).status).toBe(BetStatus.Open);

    for (let i = 0; i < PAST_BLOCKHASH_WINDOW; i++) env.svm.expireBlockhash();
    const bBefore = tokenAmount(env.svm, env.bToken);
    const sBefore = lamportsOf(env.svm, env.s.address);
    const vBefore = tokenAmount(env.svm, vault);
    const res = submit(env.svm, heldB);
    if (!('failed' in res)) throw new Error('expired held accept_bet landed');
    expect(res.failed.err()).toBe(TX_ERR_BLOCKHASH_NOT_FOUND);
    // Rejected before execution: no fee, B's stake and the vault untouched, still Open.
    expect(tokenAmount(env.svm, env.bToken)).toBe(bBefore);
    expect(bBefore).toBe(FUNDED);
    expect(lamportsOf(env.svm, env.s.address)).toBe(sBefore);
    expect(tokenAmount(env.svm, vault)).toBe(vBefore);
    expect(betOf(env, bet).status).toBe(BetStatus.Open);

    // B re-authorizes: the server fetches a fresh message, B signs again, it locks.
    const fresh = await buildTx(env.svm, env.s, [accept]);
    expectOk(submit(env.svm, fresh));
    expect(betOf(env, bet).status).toBe(BetStatus.Locked);
    expect(tokenAmount(env.svm, env.bToken)).toBe(FUNDED - STAKE_B);
    expect(tokenAmount(env.svm, vault)).toBe(STAKE_A + STAKE_B);
  });
});
