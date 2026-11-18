// The permissionless exits of an escrow Bet (ESCROW §5.2 / §8.2, I10 / I12): which instruction
// may move a Bet out of its current status at chain time `now`, and what it pays. Shared by
// scripts/crank.ts (anyone, the server-gone emergency) and the server's timeout-refund and orphan
// sweeps (apps/server/src/payout/refund.ts), so both apply exactly the program's rules:
//
//   Open      now >= accept_deadline           -> timeout_refund   (to_a = V,       to_b = 0)
//   Locked    now >= resolve_deadline          -> timeout_refund   (to_a = stake_a, to_b = V - stake_a)
//   Appealed  now >= appeal_resolve_deadline   -> timeout_refund   (same as Locked)
//   Resolved  now >= appeal_deadline           -> finalize         (the stored outcome)
//   Settled / Refunded / Cancelled             -> close_bet        (a terminal ix landed without its close)
//
// Half-open windows (I10): the action and its timeout are never both valid at one `now`.
import { BetStatus, Outcome, type Bet } from './generated';

export type ExitAction = 'timeout_refund' | 'finalize' | 'close_bet';

type Deadlines = Pick<
  Bet,
  'status' | 'acceptDeadline' | 'resolveDeadline' | 'appealDeadline' | 'appealResolveDeadline'
>;

/**
 * Byte offset of `Bet.rent_payer` in the account data (discriminator 8 + bet_id 16 + party_a 32 +
 * party_b 32 + mint 32): a getProgramAccounts memcmp on it lists the Bets a fee payer created.
 */
export const BET_RENT_PAYER_OFFSET = 120;

/** The chain time after which the current status' exit is allowed, or null (no timed exit). */
export function exitDeadline(bet: Deadlines): bigint | null {
  switch (bet.status) {
    case BetStatus.Open:
      return bet.acceptDeadline;
    case BetStatus.Locked:
      return bet.resolveDeadline;
    case BetStatus.Appealed:
      return bet.appealResolveDeadline;
    case BetStatus.Resolved:
      return bet.appealDeadline;
    default:
      return null;
  }
}

/** What may be sent for `bet` at chain time `now`, or null when nothing is due yet. */
export function exitActionFor(bet: Deadlines, now: bigint): ExitAction | null {
  switch (bet.status) {
    case BetStatus.Open:
    case BetStatus.Locked:
    case BetStatus.Appealed:
      return now >= exitDeadline(bet)! ? 'timeout_refund' : null;
    case BetStatus.Resolved:
      return now >= bet.appealDeadline ? 'finalize' : null;
    case BetStatus.Settled:
    case BetStatus.Refunded:
    case BetStatus.Cancelled:
      return 'close_bet';
    default:
      return null;
  }
}

/** DATA-MODEL §3.5 BetRefunded: the offchain end_reason for a refund from `from`. */
export function refundEndReason(
  from: BetStatus,
): 'accept_timeout' | 'resolve_timeout' | 'appeal_timeout' | null {
  if (from === BetStatus.Open) return 'accept_timeout';
  if (from === BetStatus.Locked) return 'resolve_timeout';
  if (from === BetStatus.Appealed) return 'appeal_timeout';
  return null;
}

/**
 * What an exit pays from a vault holding `v` (ESCROW §6): a refund from Open (and cancel_open_bet)
 * returns everything to A; from Locked / Appealed each side gets its own stake (excess to B);
 * finalize applies the stored outcome. Null for close_bet (only a residual, to A).
 */
export function exitPayout(
  bet: Pick<Bet, 'status' | 'stakeA' | 'outcome'>,
  action: ExitAction | 'cancel_open_bet',
  v: bigint,
): { to_a: bigint; to_b: bigint } | null {
  if (action === 'close_bet') return null;
  if (action === 'cancel_open_bet' || bet.status === BetStatus.Open) return { to_a: v, to_b: 0n };
  if (action === 'timeout_refund') {
    const a = bet.stakeA < v ? bet.stakeA : v;
    return { to_a: a, to_b: v - a };
  }
  const o = bet.outcome as { __option: 'Some'; value: Outcome } | { __option: 'None' };
  if (o.__option !== 'Some') return null;
  switch (o.value) {
    case Outcome.PartyA:
      return { to_a: v, to_b: 0n };
    case Outcome.PartyB:
      return { to_a: 0n, to_b: v };
    case Outcome.Split: {
      const half = v / 2n;
      return { to_a: half, to_b: v - half };
    }
    case Outcome.Refund: {
      const a = bet.stakeA < v ? bet.stakeA : v;
      return { to_a: a, to_b: v - a };
    }
  }
  return null;
}
