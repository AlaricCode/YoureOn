/**
 * User-signed lifecycle transactions (§12.1 sign payloads): fund (the second
 * tap, gas sponsored by the fee payer), consent ("Agree") and dispute (with
 * bond). Each returns `{sign}`; the app submits via POST /tx/:id/submit.
 */
import {
  BET_STATE,
  disputeBond,
  termsHash,
  ZERO_HASH_HEX,
  type BetAccount,
} from '@verdict/engine';
import { consentIx, disputeIx, fundIx } from '../chain/ixs.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import type { SignPayload } from '../tx/service.js';
import { chainBet, ixEnv, participantIndex, requireState, type BetInfo } from './betInfo.js';
import { ensurePayoutAtas, participantsOf } from './oracle.js';
import { calibrationComplete } from './scene.js';
import { pinCommittedCalibration, type LifecycleStores } from './stores.js';

/** §12.9 money: "$1,234.50" from USDC base units. */
export function formatUsd(units: bigint | number): string {
  const u = BigInt(units);
  const neg = u < 0n;
  const cents = (neg ? -u : u) / 10_000n;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = `$${dollars}.${(cents % 100n).toString().padStart(2, '0')}`;
  return neg ? `−${s}` : s;
}

function requireParticipant(info: BetInfo, user: UserRecord): number {
  const i = participantIndex(info, user);
  if (i < 0) throw new ApiError('WRONG_STATE', 'not a participant');
  return i;
}

async function requireBalance(ctx: AppContext, wallet: string, need: bigint): Promise<void> {
  const have = await ctx.chain.getUsdcBalance(wallet);
  if (have < need) throw new ApiError('INSUFFICIENT_FUNDS', `${have} < ${need}`);
}

/** POST /bets/:id/fund → {sign} (§9.4 #3 with the current calibration/program/terms hashes). */
export async function fundSign(ctx: AppContext, s: LifecycleStores, info: BetInfo, user: UserRecord): Promise<{ sign: SignPayload }> {
  const idx = requireParticipant(info, user);
  const bet = await chainBet(ctx, info.id);
  requireState(bet, BET_STATE.Proposed);
  if ((bet.funded_mask >> idx) & 1) throw new ApiError('WRONG_STATE', 'already funded');
  if ((await ctx.chain.nowSeconds()) > bet.fund_deadline) throw new ApiError('WRONG_STATE', 'fund window closed');

  let calibrationHashHex = ZERO_HASH_HEX;
  if (info.program.kind === 'rules') {
    // Once a fund committed a calibration_hash, that calibration is the scene (not a later PUT).
    const scene = pinCommittedCalibration(s, info.id, bet.calibration_hash);
    if (bet.calibration_hash !== ZERO_HASH_HEX && scene?.calibration_hash !== bet.calibration_hash) {
      throw new ApiError('CALIBRATION_LOCKED', 'calibration differs from the committed one');
    }
    if (!scene?.calibration || !scene.calibration_hash || !calibrationComplete(info.program, scene.calibration)) {
      throw new ApiError('CALIBRATION_INCOMPLETE');
    }
    calibrationHashHex = scene.calibration_hash;
  }
  const stake = bet.stakes[idx]!;
  await requireBalance(ctx, user.wallet, stake);
  const terms = termsHash(bet.oracle, bet.judges, bet.acceptance_audio_hash);
  return ctx.txs.request({
    user,
    kind: 'fund',
    ixs: [
      fundIx(ixEnv(ctx), info.id, user.wallet, {
        calibration_hash: calibrationHashHex,
        program_hash: bet.program_hash,
        terms_hash: terms,
      }),
    ],
    summary: `Stake ${formatUsd(stake)}`,
    meta: { bet: info.id, participant: idx, calibration_hash: calibrationHashHex },
  });
}

function consentBit(bet: BetAccount, idx: number): boolean {
  return ((bet.consent_mask >> idx) & 1) === 1;
}

/** POST /bets/:id/consent → {sign} ("Agree", §9.4 #10). */
export async function consentSign(ctx: AppContext, info: BetInfo, user: UserRecord): Promise<{ sign: SignPayload }> {
  const idx = requireParticipant(info, user);
  const bet = await chainBet(ctx, info.id);
  requireState(bet, BET_STATE.PreRuled);
  if (consentBit(bet, idx)) throw new ApiError('WRONG_STATE', 'already consented');
  // The tx may settle (last consent or past the deadline): payout ATAs must exist (§12.6 step 8).
  await ensurePayoutAtas(ctx, bet);
  return ctx.txs.request({
    user,
    kind: 'consent',
    ixs: [
      consentIx(ixEnv(ctx), info.id, user.wallet, participantsOf(bet), {
        winner_mask: bet.winner_mask,
        evidence_root: bet.evidence_root,
      }),
    ],
    summary: 'Agree',
    meta: { bet: info.id, participant: idx },
  });
}

/** POST /bets/:id/dispute {reason 1..4} → {sign, bond_units} (§9.4 #11). */
export async function disputeSign(
  ctx: AppContext,
  info: BetInfo,
  user: UserRecord,
  reason: number,
): Promise<{ sign: SignPayload; bond_units: number }> {
  if (!Number.isInteger(reason) || reason < 1 || reason > 4) throw new ApiError('WRONG_STATE', 'reason must be 1..4', 400);
  const idx = requireParticipant(info, user);
  const bet = await chainBet(ctx, info.id);
  requireState(bet, BET_STATE.PreRuled);
  if (consentBit(bet, idx)) throw new ApiError('WRONG_STATE', 'already consented');
  if ((await ctx.chain.nowSeconds()) > bet.consent_deadline) throw new ApiError('WRONG_STATE', 'consent window closed');
  const bond = disputeBond(bet);
  await requireBalance(ctx, user.wallet, bond);
  const { sign } = await ctx.txs.request({
    user,
    kind: 'dispute',
    ixs: [disputeIx(ixEnv(ctx), info.id, user.wallet, { reason, evidence_root: bet.evidence_root })],
    summary: `Bond ${formatUsd(bond)}`,
    meta: { bet: info.id, participant: idx, reason },
  });
  return { sign, bond_units: Number(bond) };
}
