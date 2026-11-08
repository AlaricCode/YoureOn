/**
 * Settlement facts for BetView / ruling / leaderboard (§9.8, §12.2, §12.3):
 * the final per-participant amounts come from the `Settled` / `Refunded`
 * event (receipt event log, fed by every chain event source); if the log
 * missed the event (e.g. the backend restarted) they are recomputed from the
 * Bet account with the engine's settlement math, which is what the program
 * transferred (dust aside).
 */
import { BET_STATE, payouts, SETTLE_PATH, type BetAccount } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { eventLog } from '../routes/receipt.js';

export const ZERO_KEY = '11111111111111111111111111111111';

export type SettlePathName = 'consent' | 'rule' | 'panel' | 'refund';

export interface SettlementFacts {
  path: SettlePathName;
  winner_mask: number;
  /** per participant (units), total transferred incl. returned bonds */
  amounts: number[];
  tx_signature: string;
}

export function settlePathName(bet: BetAccount): SettlePathName {
  if (bet.state === BET_STATE.Refunded) return 'refund';
  switch (bet.settle_path) {
    case SETTLE_PATH.RULE:
      return 'rule';
    case SETTLE_PATH.PANEL:
      return 'panel';
    case SETTLE_PATH.REFUND:
      return 'refund';
    default:
      return 'consent';
  }
}

/** True when the dispute bond was upheld (the disputer's side won the panel). */
function bondUpheld(bet: BetAccount): boolean {
  if (bet.dispute_bond === 0n || bet.disputer === ZERO_KEY) return false;
  const i = bet.participants.slice(0, bet.n_participants).indexOf(bet.disputer);
  return i >= 0 && ((bet.final_winner_mask >> i) & 1) === 1;
}

/** Settlement facts of a terminal bet, else null. */
export function settlementFacts(ctx: AppContext, bet: BetAccount, betId: string): SettlementFacts | null {
  if (bet.state !== BET_STATE.Settled && bet.state !== BET_STATE.Refunded) return null;
  const ev = eventLog(ctx)
    .of(betId)
    .filter((e) => e.name === 'Settled' || e.name === 'Refunded')
    .at(-1);
  const P = bet.n_participants;
  let amounts: number[];
  const raw = ev ? (ev.data['payouts'] ?? ev.data['amounts']) : null;
  if (Array.isArray(raw)) {
    amounts = raw.slice(0, P).map((x) => Number(x));
  } else {
    try {
      const mask = bet.state === BET_STATE.Refunded ? 0 : bet.final_winner_mask;
      amounts = payouts(bet, mask, bondUpheld(bet)).payouts.map((x) => Number(x));
    } catch {
      amounts = new Array<number>(P).fill(0);
    }
  }
  return {
    path: settlePathName(bet),
    winner_mask: bet.state === BET_STATE.Refunded ? 0 : bet.final_winner_mask,
    amounts,
    tx_signature: ev?.signature ?? '',
  };
}

/** Funded stake of participant i (0 when it never funded). */
export function fundedStake(bet: BetAccount, i: number): number {
  return ((bet.funded_mask >> i) & 1) === 1 ? Number(bet.stakes[i] ?? 0n) : 0;
}

/** Bond paid by participant i (it disputed), else 0. */
export function bondPaid(bet: BetAccount, i: number): number {
  if (bet.dispute_bond === 0n || bet.disputer === ZERO_KEY) return 0;
  return bet.participants[i] === bet.disputer ? Number(bet.dispute_bond) : 0;
}

/**
 * Net result of participant i of a terminal bet (§12.3 leaderboard):
 * everything received minus everything paid in (stake + bond).
 */
export function netUnits(bet: BetAccount, facts: SettlementFacts, i: number): number {
  return (facts.amounts[i] ?? 0) - fundedStake(bet, i) - bondPaid(bet, i);
}
