/**
 * §11.2 stake split and §11.3 parlay probability (bigint math).
 */
import {
  BPS_DENOM,
  MAX_PARLAY_LEGS,
  MAX_STAKE_UNITS,
  MIN_STAKE_UNITS,
  PROB_CLAMP_MAX_BPS,
  PROB_CLAMP_MIN_BPS,
  STAKE_GRANULARITY_UNITS,
} from '../constants.js';
import type { MarketSide, StakeSplit } from '../types.js';

/** Error thrown by World Mode math; `code` is the §12.8 API error code. */
export class WorldMathError extends Error {
  constructor(
    readonly code: 'BAD_STAKE' | 'DRAFT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'WorldMathError';
  }
}

function assertBps(p: number, label: string): void {
  if (!Number.isInteger(p) || p < 0 || p > BPS_DENOM) throw new WorldMathError('DRAFT_INVALID', `${label} must be an integer 0..10000`);
}

/** Clamps a probability to [PROB_CLAMP_MIN_BPS, PROB_CLAMP_MAX_BPS]. */
export function clampProb(pBps: number): number {
  assertBps(pBps, 'p_bps');
  return Math.min(PROB_CLAMP_MAX_BPS, Math.max(PROB_CLAMP_MIN_BPS, pBps));
}

/** Probability of the proposer's side: yes → prob_bps, no → 10000 − prob_bps (unclamped). */
export function sideProb(probBps: number, side: MarketSide): number {
  assertBps(probBps, 'prob_bps');
  return side === 'yes' ? probBps : BPS_DENOM - probBps;
}

/**
 * §11.2: `proposer_stake = floor(T·p / 10000 / 10_000) · 10_000`,
 * `counterparty_stake = T − proposer_stake`, with `p` clamped first.
 * Both stakes must be in [MIN_STAKE_UNITS, MAX_STAKE_UNITS], else BAD_STAKE.
 */
export function stakeSplit(total: bigint | number, pBps: number): StakeSplit {
  if (typeof total === 'number' && !Number.isSafeInteger(total)) {
    throw new WorldMathError('BAD_STAKE', 'total must be an integer');
  }
  const T = BigInt(total);
  if (T <= 0n) throw new WorldMathError('BAD_STAKE', 'total must be positive');
  const p = BigInt(clampProb(pBps));
  const g = BigInt(STAKE_GRANULARITY_UNITS);
  const proposer = ((T * p) / BigInt(BPS_DENOM) / g) * g;
  const counter = T - proposer;
  const min = BigInt(MIN_STAKE_UNITS);
  const max = BigInt(MAX_STAKE_UNITS);
  if (proposer < min || counter < min || proposer > max || counter > max) {
    throw new WorldMathError('BAD_STAKE', `stake split out of range: ${proposer} / ${counter}`);
  }
  return { proposer_stake: proposer, counterparty_stake: counter };
}

/**
 * §11.3: `P = p_1; P = floor(P · p_i / 10000)` for i = 2..n, in leg order.
 * `ps` are the proposer-side probabilities per leg (1..MAX_PARLAY_LEGS).
 * The result is unclamped; {@link stakeSplit} clamps it.
 */
export function parlayProb(ps: readonly number[]): number {
  if (ps.length < 1 || ps.length > MAX_PARLAY_LEGS) {
    throw new WorldMathError('DRAFT_INVALID', `parlay needs 1..${MAX_PARLAY_LEGS} legs`);
  }
  ps.forEach((p, i) => assertBps(p, `ps[${i}]`));
  let P = BigInt(ps[0]!);
  for (let i = 1; i < ps.length; i++) P = (P * BigInt(ps[i]!)) / BigInt(BPS_DENOM);
  return Number(P);
}
