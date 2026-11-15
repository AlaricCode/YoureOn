/**
 * `GET /bets/:id/ruling` (§12.3, §12.10 Ruling) and the announcer text
 * (`GET /bets/:id/announce.mp3`).
 *
 *   outcome_text: "You win" / "You lose" / "{Name} wins" (bystander) /
 *                 "No contest" / "Replay booth"
 *   amount_units: net (payout − stake − bond paid) for participants; null for
 *                 NEEDS_PANEL / the replay booth and for bystanders
 *   can_respond:  state = preruled, caller is a participant, consent pending
 */
import { BET_STATE, disputeBond, evaluate, formatUsd, payouts, splitPayload, type BetAccount, type TrackBufferAccount } from '@verdict/engine';
import { ApiError } from '../errors.js';
import type { BetInfo } from '../lifecycle/betInfo.js';
import { netUnits, settlementFacts, type SettlementFacts } from './settlement.js';
import { consentOf, winnerSide } from './view.js';

export interface RulingView {
  outcome_text: string;
  preruling: {
    code: 1 | 2 | 3;
    reason: number;
    winner_side: 0 | 1 | null;
    winner_mask: number;
    leg_results: number[];
    consent_deadline_ms: number | null;
  } | null;
  readback: string[];
  legs: { id: number; result: number; decisive_frames: number[] }[];
  amount_units: number | null;
  can_respond: boolean;
  bond_units: number;
}

/** Per-leg decisive frames from the finalized TrackBuffer (verified = Bet.bio); [] when unavailable. */
export function decisiveFramesPerLeg(bet: BetAccount, buffer: TrackBufferAccount | null, nLegs: number): number[][] {
  const empty = Array.from({ length: nLegs }, () => [] as number[]);
  if (!buffer || buffer.header.finalized !== 1) return empty;
  try {
    const parts = splitPayload(buffer.payload.subarray(0, buffer.header.written));
    if (!parts.tracks_bin || !parts.tracks) return empty;
    const verified = bet.bio.slice(0, bet.n_bio).map((b) => ({ participant: b.participant, frame: b.frame }));
    const r = evaluate(parts.program_bin, parts.calibration_bin, parts.tracks_bin, verified);
    return empty.map((_, i) => [...(r.decisive_frames[i] ?? [])].sort((a, b) => a - b));
  } catch {
    return empty;
  }
}

/** Winner mask the screen shows, or null for "Replay booth" (no verdict yet). */
function shownMask(bet: BetAccount): { mask: number | null; noContest: boolean } {
  switch (bet.state) {
    case BET_STATE.Settled:
      return { mask: bet.final_winner_mask, noContest: bet.final_winner_mask === 0 };
    case BET_STATE.Refunded:
      return { mask: 0, noContest: true };
    case BET_STATE.Disputed:
      return { mask: null, noContest: false };
    case BET_STATE.PreRuled:
      if (bet.preruling === 1) return { mask: bet.winner_mask, noContest: bet.winner_mask === 0 };
      if (bet.preruling === 2) return { mask: 0, noContest: true };
      return { mask: null, noContest: false };
    default:
      throw new ApiError('WRONG_STATE', 'no ruling yet');
  }
}

/** Display names of the winning side ("{Names} win{s}"), in participant order. */
function winnerNames(info: BetInfo, mask: number): string[] {
  return info.participants.filter((_, i) => (mask >> i) & 1).map((p) => p.display_name);
}

function outcomeText(info: BetInfo, mask: number | null, noContest: boolean, myIndex: number): string {
  if (mask === null) return 'Replay booth';
  if (noContest) return 'No contest';
  if (myIndex >= 0) return (mask >> myIndex) & 1 ? 'You win' : 'You lose';
  const side = winnerSide(info.program, mask);
  const first = info.participants.find((p) => p.side === side);
  return `${first?.display_name ?? 'Side'} wins`;
}

function amountFor(bet: BetAccount, facts: SettlementFacts | null, mask: number | null, myIndex: number): number | null {
  if (myIndex < 0 || mask === null) return null;
  if (facts) return netUnits(bet, facts, myIndex);
  // Pre-ruling: the payout if the ruling stands (consent path, bond not involved).
  try {
    const out = payouts({ ...bet, dispute_bond: 0n }, mask, false).payouts;
    const stake = ((bet.funded_mask >> myIndex) & 1) === 1 ? Number(bet.stakes[myIndex] ?? 0n) : 0;
    return Number(out[myIndex] ?? 0n) - stake;
  } catch {
    return null;
  }
}

export function buildRuling(
  ctxFacts: (bet: BetAccount) => SettlementFacts | null,
  info: BetInfo,
  bet: BetAccount,
  buffer: TrackBufferAccount | null,
  readback: string[],
  myWallet: string,
): RulingView {
  const { mask, noContest } = shownMask(bet);
  const myIndex = info.participants.findIndex((p) => p.wallet === myWallet);
  const p = info.program;
  const frames = decisiveFramesPerLeg(bet, buffer, p.legs.length);
  return {
    outcome_text: outcomeText(info, mask, noContest, myIndex),
    preruling:
      bet.preruling !== 0
        ? {
            code: bet.preruling as 1 | 2 | 3,
            reason: bet.prerule_reason,
            winner_side: winnerSide(p, bet.winner_mask),
            winner_mask: bet.winner_mask,
            leg_results: bet.leg_results.slice(0, p.legs.length),
            consent_deadline_ms: bet.consent_deadline > 0n ? Number(bet.consent_deadline) * 1000 : null,
          }
        : null,
    readback,
    legs: p.legs.map((l, i) => ({ id: l.id, result: bet.leg_results[i] ?? 255, decisive_frames: frames[i] ?? [] })),
    amount_units: amountFor(bet, ctxFacts(bet), mask, myIndex),
    can_respond: bet.state === BET_STATE.PreRuled && myIndex >= 0 && consentOf(bet, myIndex, myWallet) === 'pending',
    bond_units: Number(disputeBond(bet)),
  };
}

/** §12.10 announcer text: "{Names} win{s} ${x}" / "No contest" (x = the winners' combined net). */
export function announceText(info: BetInfo, bet: BetAccount, facts: SettlementFacts | null): string {
  const { mask, noContest } = shownMask(bet);
  if (mask === null) return 'Replay booth';
  if (noContest) return 'No contest';
  const names = winnerNames(info, mask);
  let net = 0;
  for (let i = 0; i < info.participants.length; i++) {
    if (!((mask >> i) & 1)) continue;
    net += amountFor(bet, facts, mask, i) ?? 0;
  }
  const who = names.length <= 1 ? (names[0] ?? 'Winner') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${who} win${names.length === 1 ? 's' : ''} ${formatUsd(Math.max(0, net))}`;
}

export { settlementFacts };
