/**
 * §9.8 settlement math (bigint; must match the Rust u128 implementation).
 *
 *   pot      = Σ_{i funded} stakes[i] + (bond_upheld ? dispute_bond : 0)
 *   SW       = Σ_{i ∈ W} stakes[i]
 *   payout_i = floor(pot · stakes[i] / SW)   for i ∈ W
 *   rem      = pot − Σ payout_i → lowest-index winner
 *   refund   : payout_i = stakes[i] for funded i   (winnerMask = 0)
 *   bond     : when not upheld, returned to the disputer (by participant index)
 *
 * The §9.4 dust rule (vault balance above the accounted amount) is applied by
 * the chain model after this, since it depends on the vault balance.
 */
import type { BetAccount, PayoutResult } from './types.js';

/** Minimal Bet fields used by {@link payouts}. */
export type SettleBet = Pick<
  BetAccount,
  'n_participants' | 'participants' | 'stakes' | 'funded_mask' | 'dispute_bond' | 'disputer'
>;

const ZERO_KEY = '11111111111111111111111111111111';

/**
 * Payouts for settlement with `winnerMask` (bit i ⇔ participant i wins).
 * `winnerMask = 0` is the refund path (every funded stake returned).
 * Returns `payouts` of length `n_participants`, each the total transferred to
 * participant i including a returned bond.
 */
export function payouts(bet: SettleBet, winnerMask: number, bondUpheld: boolean): PayoutResult {
  const P = bet.n_participants;
  if (!Number.isInteger(P) || P < 0 || P > 8) throw new Error('payouts: n_participants out of range');
  if (!Number.isInteger(winnerMask) || winnerMask < 0 || winnerMask >= 1 << P) {
    throw new Error('payouts: winner mask has bits outside the participants');
  }
  const stakes = bet.stakes.slice(0, P).map((s) => BigInt(s));
  const funded = (i: number): boolean => ((bet.funded_mask >> i) & 1) === 1;
  const bond = BigInt(bet.dispute_bond);
  const hasBond = bond > 0n;
  const disputerIdx = hasBond ? bet.participants.slice(0, P).indexOf(bet.disputer) : -1;
  if (hasBond && (bet.disputer === ZERO_KEY || disputerIdx < 0)) {
    throw new Error('payouts: bond held but disputer is not a participant');
  }
  const out: bigint[] = new Array<bigint>(P).fill(0n);

  if (winnerMask === 0) {
    for (let i = 0; i < P; i++) if (funded(i)) out[i] = stakes[i]!;
    let pot = out.reduce((a, b) => a + b, 0n);
    if (hasBond) {
      out[disputerIdx] = out[disputerIdx]! + bond;
      pot += bond;
    }
    return { pot, payouts: out, bond_refund: hasBond ? bond : 0n };
  }

  const upheld = hasBond && bondUpheld;
  let pot = 0n;
  for (let i = 0; i < P; i++) if (funded(i)) pot += stakes[i]!;
  if (upheld) pot += bond;

  let sw = 0n;
  let lowest = -1;
  for (let i = 0; i < P; i++) {
    if ((winnerMask >> i) & 1) {
      sw += stakes[i]!;
      if (lowest < 0) lowest = i;
    }
  }
  if (sw === 0n) throw new Error('payouts: winners have zero total stake');
  let paid = 0n;
  for (let i = 0; i < P; i++) {
    if ((winnerMask >> i) & 1) {
      out[i] = (pot * stakes[i]!) / sw;
      paid += out[i]!;
    }
  }
  out[lowest] = out[lowest]! + (pot - paid);

  let bondRefund = 0n;
  if (hasBond && !upheld) {
    bondRefund = bond;
    out[disputerIdx] = out[disputerIdx]! + bond;
  }
  return { pot, payouts: out, bond_refund: bondRefund };
}
