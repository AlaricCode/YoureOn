/**
 * §12.2 BetView for bets created through `POST /bets` (rules / ai_judged),
 * assembled from the bets mirror (program, labels, title), the chain Bet
 * account (state, masks, deadlines), the lifecycle (calibration, witnesses,
 * timing), the replay booth (status) and the settlement event.
 * World Mode bets keep their own view (world/view.ts).
 */
import {
  BET_STATE,
  conditionRows,
  PANEL_TIMEOUT_S,
  START_WINDOW_S,
  toYaml,
  type BetAccount,
  type Calibration,
  type Program,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import type { BetInfo } from '../lifecycle/betInfo.js';
import { lifecycleView } from '../lifecycle/view.js';
import { boothService } from '../routes/replayBooth.js';
import { BET_STATE_NAMES, stateLabel, type BetStateName } from '../world/view.js';
import type { BetMirrorRecord } from './records.js';
import { settlementFacts, ZERO_KEY } from './settlement.js';

export type ConsentState = 'pending' | 'agree' | 'dispute';

export interface ParticipantView {
  user_id: string;
  display_name: string;
  wallet: string;
  side: 0 | 1;
  accepted: boolean;
  funded: boolean;
  consent: ConsentState;
}

export interface BetView {
  id: string;
  title: string;
  kind: 'rules' | 'ai_judged' | 'market';
  ai_judged: boolean;
  state: BetStateName;
  state_label: string;
  creator_user_id: string;
  participants: ParticipantView[];
  my_index: number | null;
  my_role: 'participant' | 'bystander';
  stake_each_units: number | null;
  stakes_units: number[];
  pot_units: number;
  time_limit_s: number;
  actor_bound: boolean;
  program: Program;
  yaml: string;
  readback: string[];
  program_hash: string;
  labels: Record<string, string>;
  calibration: Calibration | null;
  calibration_hash: string | null;
  conditions: { leg: number; field: 'valid_attempt' | 'success'; path: string; label: string }[];
  deadlines_ms: { fund: number | null; start: number | null; live_end: number | null; consent: number | null; panel: number | null };
  started_at_ms: number | null;
  t0_ms: number | null;
  ended_at_ms: number | null;
  witnesses: { id: string; label: string; kind: 'camera' | 'audio' | 'detections'; user_id: string | null; synced: boolean | null }[];
  gap_mask: number;
  preruling: {
    code: 1 | 2 | 3;
    reason: number;
    winner_side: 0 | 1 | null;
    winner_mask: number;
    leg_results: number[];
    consent_deadline_ms: number | null;
  } | null;
  dispute: { by_user_id: string | null; reason: number; bond_units: number } | null;
  booth_status: 'collecting' | 'judging' | 'ruled' | 'submitted' | null;
  settlement: { path: 'consent' | 'rule' | 'panel' | 'refund'; winner_mask: number; payouts: { user_id: string; amount_units: number }[]; tx_signature: string } | null;
  refund_reason: number | null;
  updated_at_ms: number;
}

const secMs = (s: bigint): number | null => (s > 0n ? Number(s) * 1000 : null);

export function stateName(bet: BetAccount | null): BetStateName {
  return bet ? (BET_STATE_NAMES[bet.state] ?? 'proposed') : 'proposed';
}

/** Side of a winner mask (the side of its lowest set bit), null for 0. */
export function winnerSide(program: Program, mask: number): 0 | 1 | null {
  for (let i = 0; i < program.participants.length; i++) if ((mask >> i) & 1) return program.sides[i] ?? 0;
  return null;
}

export function consentOf(bet: BetAccount | null, i: number, wallet: string): ConsentState {
  if (!bet) return 'pending';
  if (bet.disputer !== ZERO_KEY && bet.disputer === wallet) return 'dispute';
  return ((bet.consent_mask >> i) & 1) === 1 ? 'agree' : 'pending';
}

export function buildBetView(ctx: AppContext, rec: BetMirrorRecord, info: BetInfo, bet: BetAccount | null, userId: string): BetView {
  const p = rec.program;
  const user = ctx.auth.requireUser(userId);
  const myIndex = info.participants.findIndex((x) => x.wallet === user.wallet);
  const state = stateName(bet);
  const accepted = new Set(rec.acceptances.filter((a) => a.accepted).map((a) => a.user_id));
  const funded = (i: number) => (bet ? ((bet.funded_mask >> i) & 1) === 1 : false);
  const stakes = bet
    ? bet.stakes.slice(0, bet.n_participants).map((s) => Number(s))
    : p.participants.map(() => p.stake_each ?? 0);
  const facts = bet ? settlementFacts(ctx, bet, rec.id) : null;
  const won = myIndex >= 0 && bet?.state === BET_STATE.Settled ? ((bet.final_winner_mask >> myIndex) & 1) === 1 : null;
  const lc = lifecycleView(ctx, rec.id);
  const booth = boothService(ctx).get(rec.id);
  return {
    id: rec.id,
    title: rec.title,
    kind: p.kind === 'ai_judged' ? 'ai_judged' : 'rules',
    ai_judged: p.kind === 'ai_judged',
    state,
    state_label: stateLabel(state, { bystander: myIndex < 0, won }),
    creator_user_id: rec.creator_user_id,
    participants: info.participants.map((x, i) => ({
      user_id: x.user_id ?? '',
      display_name: x.display_name,
      wallet: x.wallet,
      side: x.side,
      // The creator accepted by proposing; create_bet required every counterparty's acceptance.
      accepted: i === 0 || (x.user_id !== null && accepted.has(x.user_id)),
      funded: funded(i),
      consent: consentOf(bet, i, x.wallet),
    })),
    my_index: myIndex >= 0 ? myIndex : null,
    my_role: myIndex >= 0 ? 'participant' : 'bystander',
    stake_each_units: p.stake_each ?? (bet && bet.stake_each > 0n ? Number(bet.stake_each) : null),
    stakes_units: stakes,
    pot_units: stakes.reduce((a, b) => a + b, 0),
    time_limit_s: p.time_limit_s,
    actor_bound: p.legs.some((l) => l.actor_bound),
    program: p,
    yaml: rec.yaml ?? toYaml(p),
    readback: rec.readback,
    program_hash: rec.program_hash,
    labels: rec.labels,
    calibration: lc.calibration ?? rec.calibration ?? null,
    calibration_hash: lc.calibration_hash ?? rec.calibration_hash ?? null,
    conditions: p.kind === 'rules' ? conditionRows(p, rec.labels) : [],
    deadlines_ms: {
      fund: bet ? secMs(bet.fund_deadline) : null,
      start: bet && bet.funded_at > 0n ? secMs(bet.funded_at + BigInt(START_WINDOW_S)) : null,
      live_end: bet && bet.started_at > 0n ? secMs(bet.started_at + BigInt(bet.time_limit_s)) : null,
      consent: bet && bet.consent_deadline > 0n ? secMs(bet.consent_deadline) : null,
      panel: bet && bet.disputed_at > 0n ? secMs(bet.disputed_at + BigInt(PANEL_TIMEOUT_S)) : null,
    },
    started_at_ms: lc.started_at_ms ?? (bet ? secMs(bet.started_at) : null),
    t0_ms: lc.t0_ms,
    ended_at_ms: lc.ended_at_ms ?? (bet ? secMs(bet.ended_at) : null),
    witnesses: lc.witnesses,
    gap_mask: bet?.gap_mask ?? 0,
    preruling:
      bet && bet.preruling !== 0
        ? {
            code: bet.preruling as 1 | 2 | 3,
            reason: bet.prerule_reason,
            winner_side: winnerSide(p, bet.winner_mask),
            winner_mask: bet.winner_mask,
            leg_results: bet.leg_results.slice(0, p.legs.length),
            consent_deadline_ms: secMs(bet.consent_deadline),
          }
        : null,
    dispute:
      bet && bet.dispute_reason !== 0
        ? {
            by_user_id: info.participants.find((x) => x.wallet === bet.disputer)?.user_id ?? null,
            reason: bet.dispute_reason,
            bond_units: Number(bet.dispute_bond),
          }
        : null,
    booth_status: booth?.status ?? null,
    settlement: facts
      ? {
          path: facts.path,
          winner_mask: facts.winner_mask,
          payouts: info.participants.map((x, i) => ({ user_id: x.user_id ?? '', amount_units: facts.amounts[i] ?? 0 })),
          tx_signature: facts.tx_signature,
        }
      : null,
    refund_reason: bet && bet.refund_reason !== 0 ? bet.refund_reason : null,
    updated_at_ms: Math.max(rec.updated_at_ms, lc.ended_at_ms ?? 0, booth?.updated_at_ms ?? 0),
  };
}
