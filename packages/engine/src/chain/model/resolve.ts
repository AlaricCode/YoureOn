/**
 * §9.4 #10 consent, #11 dispute, #12 settle_panel, #15 refund.
 */
import {
  BET_STATE,
  DISPUTE_BOND_DIV,
  DISPUTE_BOND_MIN,
  LIVE_GRACE_S,
  PANEL_TIMEOUT_S,
  PERCEPTION_TIMEOUT_S,
  REFUND_REASON,
  SETTLE_PATH,
  START_WINDOW_S,
} from '../../constants.js';
import type { BetAccount, InstructionArgsMap, RefundReasonCode, SettlePathCode } from '../../types.js';
import { panelMessage } from '../../booth/panel.js';
import { checkPanelInstruction } from '../ed25519.js';
import { allMask, check, type Env, fail, participantIndex } from './env.js';
import { NO_CONTEST_REFUND, refundAll, settleTo } from './payout.js';

/** #10 consent. */
export function consent(bet: BetAccount, env: Env, a: InstructionArgsMap['consent']): void {
  const auth = env.signer('authority');
  check(bet.state === BET_STATE.PreRuled, 'InvalidState');
  check(a.winner_mask === bet.winner_mask && a.evidence_root.toLowerCase() === bet.evidence_root, 'ConsentMismatch');
  env.checkOracleAccount(bet);
  const i = participantIndex(bet, auth);
  const beforeDeadline = env.now <= bet.consent_deadline;
  if (beforeDeadline) {
    check(i >= 0, 'DeadlineNotReached');
    check(((bet.consent_mask >> i) & 1) === 0, 'AlreadyConsented');
    bet.consent_mask |= 1 << i;
    env.emit('Consented', { bet: env.betKey, participant: auth, consent_mask: bet.consent_mask });
    if (bet.consent_mask !== allMask(bet)) return;
  }
  const path: SettlePathCode = bet.tracks_finalized === 2 ? SETTLE_PATH.RULE : SETTLE_PATH.CONSENT;
  settleTo(bet, env, bet.winner_mask, false, path);
}

/** §9.4 #11 bond: `max(min_i stakes[i] / DISPUTE_BOND_DIV, DISPUTE_BOND_MIN)`. */
export function disputeBond(bet: Pick<BetAccount, 'n_participants' | 'stakes'>): bigint {
  let min = -1n;
  for (let i = 0; i < bet.n_participants; i++) {
    const s = bet.stakes[i]!;
    if (min < 0n || s < min) min = s;
  }
  const b = min / BigInt(DISPUTE_BOND_DIV);
  const floor = BigInt(DISPUTE_BOND_MIN);
  return b > floor ? b : floor;
}

/** #11 dispute. */
export function dispute(bet: BetAccount, env: Env, a: InstructionArgsMap['dispute']): void {
  const signer = env.signer('disputer');
  check(bet.state === BET_STATE.PreRuled, 'InvalidState');
  // Order matches dispute.rs: state, deadline, reason, evidence_root, participant, consented.
  check(env.now <= bet.consent_deadline, 'DeadlinePassed');
  check(Number.isInteger(a.reason) && a.reason >= 1 && a.reason <= 4, 'BadReason');
  check(a.evidence_root.toLowerCase() === bet.evidence_root, 'ConsentMismatch');
  const i = participantIndex(bet, signer);
  check(i >= 0, 'NotParticipant');
  check(((bet.consent_mask >> i) & 1) === 0, 'AlreadyConsented');
  const bond = disputeBond(bet);
  const src = env.account('disputer_token');
  env.checkTokenOwner(src, signer);
  env.transfer(src, env.account('vault'), bond);
  bet.state = BET_STATE.Disputed;
  bet.disputer = signer;
  bet.dispute_bond = bond;
  bet.dispute_reason = a.reason as BetAccount['dispute_reason'];
  bet.disputed_at = env.now;
  env.emit('Disputed', { bet: env.betKey, disputer: signer, reason: a.reason, bond });
}

/** Mask of the participants on `side` (0 or 1). */
export function sideMask(bet: Pick<BetAccount, 'n_participants' | 'side_b_mask'>, side: 0 | 1): number {
  const all = (1 << bet.n_participants) - 1;
  return side === 1 ? bet.side_b_mask & all : all & ~bet.side_b_mask;
}

/** #12 settle_panel. */
export function settlePanel(bet: BetAccount, env: Env, a: InstructionArgsMap['settle_panel']): void {
  check(bet.state === BET_STATE.Disputed, 'InvalidState');
  check(Number.isInteger(a.outcome) && a.outcome >= 0 && a.outcome <= 2, 'BadOutcome');
  // After the panel timeout only `refund` (reason 6) applies; matches settle_panel.rs.
  check(env.now <= bet.disputed_at + BigInt(PANEL_TIMEOUT_S), 'DeadlinePassed');
  const programId = env.ctx.program_id;
  check(!!programId, 'BadEd25519Instruction');
  const M = panelMessage(programId, env.betKey, a.outcome, bet.evidence_root, bet.program_hash);
  const err = checkPanelInstruction(
    env.ctx.prev_instruction,
    env.opts.ed25519ProgramId,
    M,
    bet.judges,
    env.opts.verifyEd25519Signatures,
  );
  if (err) fail(err);
  env.checkOracleAccount(bet);
  if (a.outcome === 0) {
    refundAll(bet, env, NO_CONTEST_REFUND);
    return;
  }
  const mask = sideMask(bet, a.outcome === 1 ? 0 : 1);
  const upheld = bet.preruling === 1 && mask === bet.winner_mask;
  settleTo(bet, env, mask, upheld, SETTLE_PATH.PANEL);
}

/** The §9.4 #15 refund reason applicable now, or null. */
export function refundCondition(bet: BetAccount, now: bigint): RefundReasonCode | null {
  switch (bet.state) {
    case BET_STATE.Proposed:
      return now > bet.fund_deadline ? REFUND_REASON.fund_timeout : null;
    case BET_STATE.Funded:
      return now > bet.funded_at + BigInt(START_WINDOW_S) ? REFUND_REASON.start_timeout : null;
    case BET_STATE.Live:
      return now > bet.started_at + BigInt(bet.time_limit_s) + BigInt(LIVE_GRACE_S) ? REFUND_REASON.live_timeout : null;
    case BET_STATE.Perceiving:
      return now > bet.ended_at + BigInt(PERCEPTION_TIMEOUT_S) ? REFUND_REASON.perception_timeout : null;
    case BET_STATE.Disputed:
      return now > bet.disputed_at + BigInt(PANEL_TIMEOUT_S) ? REFUND_REASON.panel_timeout : null;
    case BET_STATE.PreRuled:
      return now > bet.consent_deadline + BigInt(PANEL_TIMEOUT_S) ? REFUND_REASON.consent_timeout : null;
    default:
      return null;
  }
}

/** #15 refund (permissionless). */
export function refund(bet: BetAccount, env: Env): void {
  const reason = refundCondition(bet, env.now);
  check(reason !== null, 'NotRefundable');
  env.checkOracleAccount(bet);
  refundAll(bet, env, reason);
}
