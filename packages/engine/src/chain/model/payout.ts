/**
 * Terminal transitions shared by cancel / consent / settle_panel / refund:
 * §9.8 payouts, the §9.4 dust rule, vault transfers and account closing.
 */
import { BET_STATE, REFUND_REASON, SETTLE_PATH } from '../../constants.js';
import type { BetAccount, RefundReasonCode, SettlePathCode } from '../../types.js';
import { payouts } from '../../settle.js';
import { ZERO_KEY } from '../bytes.js';
import { check, type Env, pad8 } from './env.js';

/** Σ funded stakes + bond held in the vault. */
export function accountedAmount(bet: BetAccount): bigint {
  let a = 0n;
  for (let i = 0; i < bet.n_participants; i++) if ((bet.funded_mask >> i) & 1) a += bet.stakes[i]!;
  if (bet.dispute_bond > 0n && bet.disputer !== ZERO_KEY) a += bet.dispute_bond;
  return a;
}

/**
 * Applies the dust rule to `amounts` (adds `vault.amount − accounted` to
 * `dustIdx`), transfers from the vault to the payout accounts, and closes the
 * vault and TrackBuffer.
 */
function disburse(bet: BetAccount, env: Env, amounts: bigint[], dustIdx: number): bigint[] {
  const accounts = env.payoutAccounts(bet);
  const accounted = accountedAmount(bet);
  const sum = amounts.reduce((a, b) => a + b, 0n);
  check(sum === accounted, 'MathOverflow');
  const vaultAmount = env.ctx.vault_amount ?? accounted;
  check(vaultAmount >= accounted, 'MathOverflow');
  const out = amounts.slice();
  out[dustIdx] = out[dustIdx]! + (vaultAmount - accounted);
  const vault = env.account('vault');
  for (let i = 0; i < bet.n_participants; i++) env.transfer(vault, accounts[i]!, out[i]!);
  env.closeAccounts(bet);
  return out;
}

/** Refund every funded stake and any bond → Refunded with `reason`. Emits `Refunded`. */
export function refundAll(bet: BetAccount, env: Env, reason: RefundReasonCode): void {
  const r = payouts(bet, 0, false);
  const amounts = disburse(bet, env, r.payouts, 0);
  bet.state = BET_STATE.Refunded;
  bet.refund_reason = reason;
  bet.settle_path = SETTLE_PATH.REFUND;
  bet.final_winner_mask = 0;
  bet.settled_at = env.now;
  env.emit('Refunded', { bet: env.betKey, reason, amounts: pad8(amounts, 0n) });
}

/** Settle to `winnerMask` via `path`. Emits `Settled`. */
export function settleTo(
  bet: BetAccount,
  env: Env,
  winnerMask: number,
  bondUpheld: boolean,
  path: SettlePathCode,
): void {
  check(winnerMask !== 0, 'BadOutcome');
  const r = payouts(bet, winnerMask, bondUpheld);
  let lowest = 0;
  while (((winnerMask >> lowest) & 1) === 0) lowest++;
  const amounts = disburse(bet, env, r.payouts, lowest);
  bet.state = BET_STATE.Settled;
  bet.settle_path = path;
  bet.final_winner_mask = winnerMask;
  bet.settled_at = env.now;
  env.emit('Settled', {
    bet: env.betKey,
    path,
    winner_mask: winnerMask,
    pot: r.pot,
    payouts: pad8(amounts, 0n),
  });
}

export const NO_CONTEST_REFUND = REFUND_REASON.no_contest as RefundReasonCode;
