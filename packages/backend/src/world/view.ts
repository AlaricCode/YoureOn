/**
 * §12.2 BetView for World Mode (market) bets, built from the world bet record
 * and the on-chain Bet. Used when the bets module has not registered a
 * `betView` source (integration/sources.ts); market bets have no scene,
 * calibration, witnesses or conditions.
 */
import { BET_STATE, type BetAccount, type MarketPick, type Program } from '@verdict/engine';
import { PANEL_TIMEOUT_S, START_WINDOW_S } from '@verdict/engine';

export const BET_STATE_NAMES = ['proposed', 'funded', 'live', 'perceiving', 'preruled', 'disputed', 'settled', 'refunded'] as const;
export type BetStateName = (typeof BET_STATE_NAMES)[number];

/** §12.9 state labels. */
export function stateLabel(state: BetStateName, opts: { bystander: boolean; won: boolean | null }): string {
  switch (state) {
    case 'proposed':
      return 'Waiting';
    case 'funded':
      return 'Ready';
    case 'live':
      return 'Live';
    case 'perceiving':
      return 'Reviewing';
    case 'preruled':
      return 'Ruled';
    case 'disputed':
      return 'Replay booth';
    case 'settled':
      return opts.bystander || opts.won === null ? 'Settled' : opts.won ? 'Won' : 'Lost';
    case 'refunded':
      return 'Refunded';
  }
}

export interface WorldBetParticipant {
  user_id: string;
  display_name: string;
  wallet: string;
  side: 0 | 1;
}

/** Persisted World Mode bet (`world_bets`, keyed by the Bet PDA). */
export interface WorldBetRecord {
  bet: string;
  quote_id: string;
  kind: 'market';
  title: string;
  program: Program;
  yaml: string;
  readback: string[];
  labels: Record<string, string>;
  program_hash: string;
  /** u64 decimal */
  nonce: string;
  creator_user_id: string;
  participants: WorldBetParticipant[];
  picks: MarketPick[];
  create_tx_id: string;
  /** create_bet confirmed */
  created: boolean;
  /** terminal state observed (keeper stops) */
  done: boolean;
  created_at_ms: number;
  updated_at_ms: number;
  last_error: string | null;
}

/** All-zero pubkey (no disputer). */
const ZERO_KEY = '11111111111111111111111111111111';
const ms = (s: bigint): number | null => (s > 0n ? Number(s) * 1000 : null);

export interface SettlementInfo {
  signature: string | null;
  /** per participant, units */
  amounts: number[];
}

export function marketBetView(
  r: WorldBetRecord,
  bet: BetAccount | null,
  userId: string,
  boothStatus: string | null,
  settled: SettlementInfo | null,
): Record<string, unknown> {
  const myIndex = r.participants.findIndex((p) => p.user_id === userId);
  const state: BetStateName = bet ? BET_STATE_NAMES[bet.state]! : 'proposed';
  const stakes = r.program.stakes ?? [];
  const funded = (i: number) => (bet ? ((bet.funded_mask >> i) & 1) === 1 : false);
  const consentOf = (i: number, wallet: string): 'pending' | 'agree' | 'dispute' => {
    if (!bet) return 'pending';
    if (bet.disputer !== ZERO_KEY && bet.disputer === wallet) return 'dispute';
    return ((bet.consent_mask >> i) & 1) === 1 ? 'agree' : 'pending';
  };
  const winnerMask = bet?.state === BET_STATE.Settled ? bet.final_winner_mask : 0;
  const won = myIndex >= 0 && bet?.state === BET_STATE.Settled ? ((winnerMask >> myIndex) & 1) === 1 : null;
  const winnerSide = (mask: number): 0 | 1 | null => (mask === 0 ? null : (mask & 0b10) !== 0 ? 1 : 0);
  return {
    id: r.bet,
    title: r.title,
    kind: 'market',
    ai_judged: false,
    state,
    state_label: stateLabel(state, { bystander: myIndex < 0, won }),
    creator_user_id: r.creator_user_id,
    participants: r.participants.map((p, i) => ({
      user_id: p.user_id,
      display_name: p.display_name,
      wallet: p.wallet,
      side: p.side,
      // Counterparty `fund` = acceptance (D-32); the proposer accepted by proposing.
      accepted: i === 0 || funded(i),
      funded: funded(i),
      consent: consentOf(i, p.wallet),
    })),
    my_index: myIndex >= 0 ? myIndex : null,
    my_role: myIndex >= 0 ? 'participant' : 'bystander',
    stake_each_units: null,
    stakes_units: stakes,
    pot_units: stakes.reduce((a, b) => a + b, 0),
    time_limit_s: r.program.time_limit_s,
    actor_bound: false,
    program: r.program,
    yaml: r.yaml,
    readback: r.readback,
    program_hash: r.program_hash,
    labels: r.labels,
    calibration: null,
    calibration_hash: null,
    conditions: [],
    deadlines_ms: {
      fund: bet ? ms(bet.fund_deadline) : null,
      start: bet && bet.funded_at > 0n ? ms(bet.funded_at + BigInt(START_WINDOW_S)) : null,
      live_end: bet && bet.started_at > 0n ? ms(bet.started_at + BigInt(bet.time_limit_s)) : null,
      consent: bet && bet.consent_deadline > 0n ? ms(bet.consent_deadline) : null,
      panel: bet && bet.disputed_at > 0n ? ms(bet.disputed_at + BigInt(PANEL_TIMEOUT_S)) : null,
    },
    started_at_ms: bet ? ms(bet.started_at) : null,
    t0_ms: null,
    ended_at_ms: bet ? ms(bet.ended_at) : null,
    witnesses: [],
    gap_mask: bet?.gap_mask ?? 0,
    preruling:
      bet && bet.preruling !== 0
        ? {
            code: bet.preruling,
            reason: bet.prerule_reason,
            winner_side: winnerSide(bet.winner_mask),
            winner_mask: bet.winner_mask,
            leg_results: bet.leg_results.slice(0, r.program.legs.length),
            consent_deadline_ms: bet.consent_deadline > 0n ? Number(bet.consent_deadline) * 1000 : null,
          }
        : null,
    dispute:
      bet && bet.dispute_reason !== 0
        ? {
            by_user_id: r.participants.find((p) => p.wallet === bet.disputer)?.user_id ?? null,
            reason: bet.dispute_reason,
            bond_units: Number(bet.dispute_bond),
          }
        : null,
    booth_status: boothStatus,
    settlement:
      bet && (bet.state === BET_STATE.Settled || bet.state === BET_STATE.Refunded)
        ? {
            path: (['consent', 'consent', 'rule', 'panel', 'refund'] as const)[bet.settle_path] ?? (bet.state === BET_STATE.Refunded ? 'refund' : 'consent'),
            winner_mask: bet.final_winner_mask,
            payouts: r.participants.map((p, i) => ({ user_id: p.user_id, amount_units: settled?.amounts[i] ?? 0 })),
            tx_signature: settled?.signature ?? '',
          }
        : null,
    refund_reason: bet && bet.refund_reason !== 0 ? bet.refund_reason : null,
    updated_at_ms: r.updated_at_ms,
  };
}

