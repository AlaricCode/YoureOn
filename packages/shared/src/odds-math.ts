// SCHEMAS §3.5 — odds between friends: the numbers, all in code (pure; money is bigint micro-USDC).
//
// Odds are unequal stakes. "3 to 1" = the favourite puts in three for every one the underdog puts
// in; the winner takes the whole pot. A skill bet's odds are bounded by MAX_ODDS_RATIO : 1
// (TermsV1 refinement), each stake by MIN_STAKE..max_stake, whole cents.
//
// The judge's suggestion ("Judge, what odds are fair?") is computed here and only worded by a
// model: shrunkRate() blends the performer's record in this category with the category base rate
// (so 1 for 1 is not 100 %), attemptsRate() applies the bet's attempt rule, fairOdds() turns the
// chance into a ratio, band() is the only rungs a model may pick from, and stakesFor() turns the
// chosen rung into concrete stakes. A model can never set a stake, a chance or a ratio outside
// the band.
import { z } from 'zod/v4';
import { CENT, MAX_ODDS_RATIO, MAX_STAKE, MIN_STAKE } from './constants';
import { formatUsd } from './money';
import type { Party } from './primitives';

// ---- the ladder ----------------------------------------------------------------------------

/** Friendly ratios, shortest first. */
export const ODDS_LADDER = ['1:1', '3:2', '2:1', '3:1', '5:1', '10:1'] as const;
export const OddsRatio = z.enum(ODDS_LADDER);
export type OddsRatio = z.infer<typeof OddsRatio>;

export const RUNG: Record<OddsRatio, { num: number; den: number }> = {
  '1:1': { num: 1, den: 1 },
  '3:2': { num: 3, den: 2 },
  '2:1': { num: 2, den: 1 },
  '3:1': { num: 3, den: 1 },
  '5:1': { num: 5, den: 1 },
  '10:1': { num: 10, den: 1 },
};
const rungValue = (r: OddsRatio) => RUNG[r].num / RUNG[r].den;

/** Pseudo-count of the prior: k = 4 "virtual tries" at the category base rate. */
export const PRIOR_STRENGTH = 4;
/** At least this many tries in the category before the record is quoted as the anchor. */
export const MEANINGFUL_SAMPLE = 3;
/** Within 2 % of a rung reads (and bands) as that rung. */
const RUNG_TOLERANCE = 0.02;

// ---- chance -----------------------------------------------------------------------------------

/** Bayesian blend: (made + k·base) / (tries + k). 1 for 1 on bottle flips -> 0.40, not 1. */
export function shrunkRate(made: number, tries: number, base: number): number {
  return (made + PRIOR_STRENGTH * base) / (tries + PRIOR_STRENGTH);
}

export type AttemptsLike = {
  count: number;
  rule: 'single' | 'first_success' | 'best_of' | 'all_of';
};

/** P(the claim succeeds) given a single-try rate p and the bet's attempt rule. */
export function attemptsRate(p: number, a: AttemptsLike): number {
  const n = Math.max(1, Math.floor(a.count));
  switch (a.rule) {
    case 'single':
      return p;
    case 'first_success':
      return 1 - (1 - p) ** n;
    case 'all_of':
      return p ** n;
    case 'best_of': {
      const need = Math.ceil(n / 2);
      let sum = 0;
      for (let k = need; k <= n; k++) sum += binom(n, k) * p ** k * (1 - p) ** (n - k);
      return sum;
    }
  }
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const MAX_R = Number(MAX_ODDS_RATIO);
/** Clamp to [1/11, 10/11]: the chance at which fair odds hit the 10:1 bound. */
export function clampChance(p: number): number {
  const lo = 1 / (MAX_R + 1);
  const hi = MAX_R / (MAX_R + 1);
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(hi, Math.max(lo, p));
}

/**
 * Fair odds for a claim that succeeds with chance p. `favored` is the side more likely to win:
 * 'performer' = the claim's side (it succeeds), 'opponent' = the other. r = max(p,1-p)/min(p,1-p).
 * The favourite stakes r times the underdog (stakes proportional to each side's chance).
 */
export function fairOdds(p: number): { favored: 'performer' | 'opponent' | null; r: number } {
  const q = clampChance(p);
  const hi = Math.max(q, 1 - q);
  const lo = Math.min(q, 1 - q);
  const r = hi / lo;
  if (Math.abs(r - 1) <= 1e-9) return { favored: null, r: 1 };
  return { favored: q > 0.5 ? 'performer' : 'opponent', r };
}

/** The rung nearest r in log space. */
export function nearestRung(r: number): OddsRatio {
  let best: OddsRatio = '1:1';
  let d = Infinity;
  for (const rung of ODDS_LADDER) {
    const x = Math.abs(Math.log(Math.max(r, 1)) - Math.log(rungValue(rung)));
    if (x < d - 1e-12) {
      d = x;
      best = rung;
    }
  }
  return best;
}

/** The rung r is within RUNG_TOLERANCE of, or null. */
function onRung(r: number): OddsRatio | null {
  for (const rung of ODDS_LADDER)
    if (Math.abs(r / rungValue(rung) - 1) <= RUNG_TOLERANCE) return rung;
  return null;
}

/** The rungs a model may choose: the two bracketing r, or just one when r is on a rung. */
export function band(r: number): OddsRatio[] {
  const exact = onRung(r);
  if (exact) return [exact];
  if (r <= 1) return ['1:1'];
  for (let i = 0; i < ODDS_LADDER.length - 1; i++) {
    const lo = ODDS_LADDER[i]!;
    const hi = ODDS_LADDER[i + 1]!;
    if (r > rungValue(lo) && r < rungValue(hi)) return [lo, hi];
  }
  return ['10:1'];
}

// ---- stakes -----------------------------------------------------------------------------------

export type OddsIssueCode = 'STAKE_BELOW_MIN' | 'STAKE_ABOVE_MAX' | 'ODDS_TOO_LONG' | 'AMBIGUOUS';
export interface OddsIssue {
  code: OddsIssueCode;
  message: string;
}

const roundHalfUpToCent = (micro: bigint): bigint => ((micro + CENT / 2n) / CENT) * CENT;
const floorToCent = (micro: bigint): bigint => (micro / CENT) * CENT;

/**
 * Concrete stakes for a rung. The underdog stakes `baseMicro`; the favourite stakes
 * base × num/den rounded half-up to the cent. A favourite over maxStake stakes maxStake and the
 * underdog maxStake × den/num (floored to the cent). An underdog below MIN_STAKE: ODDS_TOO_LONG.
 * favored null (or 1:1): both stake base.
 */
export function stakesFor(i: {
  ratio: OddsRatio;
  favored: Party | null;
  baseMicro: bigint;
  maxStake?: bigint;
}): { a: bigint; b: bigint } | { issue: OddsIssue } {
  const max = i.maxStake ?? MAX_STAKE;
  const base = i.baseMicro;
  if (base % CENT !== 0n) return { issue: { code: 'AMBIGUOUS', message: 'whole cents only' } };
  if (base < MIN_STAKE)
    return { issue: { code: 'STAKE_BELOW_MIN', message: 'stake below MIN_STAKE' } };
  if (base > max) return { issue: { code: 'STAKE_ABOVE_MAX', message: 'stake above max_stake' } };
  const { num, den } = RUNG[i.ratio];
  if (i.favored === null || num === den) return { a: base, b: base };
  let fav = roundHalfUpToCent((base * BigInt(num)) / BigInt(den));
  let dog = base;
  if (fav > max) {
    fav = max;
    dog = floorToCent((max * BigInt(den)) / BigInt(num));
  }
  if (dog < MIN_STAKE)
    return { issue: { code: 'ODDS_TOO_LONG', message: 'underdog stake below MIN_STAKE' } };
  return i.favored === 'A' ? { a: fav, b: dog } : { a: dog, b: fav };
}

/** Both sides' stakes as the server enforces them for a skill bet; null = fine. */
export function checkOddsStakes(
  a: bigint,
  b: bigint,
  maxStake: bigint = MAX_STAKE,
): OddsIssue | null {
  for (const s of [a, b]) {
    if (s % CENT !== 0n) return { code: 'AMBIGUOUS', message: 'whole cents only' };
    if (s < MIN_STAKE) return { code: 'STAKE_BELOW_MIN', message: 'stake below MIN_STAKE' };
    if (s > maxStake) return { code: 'STAKE_ABOVE_MAX', message: 'stake above max_stake' };
  }
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  if (hi > MAX_ODDS_RATIO * lo) return { code: 'ODDS_TOO_LONG', message: 'odds above 10:1' };
  return null;
}

// ---- display ----------------------------------------------------------------------------------

const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? x : gcd(y, x % y));

/**
 * "Even", "3 to 1" / "3 to 2" (within 2 % of a rung), "15 to 7" (reduced cents, both ≤ 20),
 * else "2.1 to 1". Larger stake first; who gives is favoredParty().
 */
export function ratioLabel(a: bigint | string, b: bigint | string): string {
  const x = BigInt(a);
  const y = BigInt(b);
  if (x === y) return 'Even';
  if (x <= 0n || y <= 0n) return 'Even';
  const hi = x > y ? x : y;
  const lo = x > y ? y : x;
  const r = Number(hi) / Number(lo);
  for (const rung of ODDS_LADDER) {
    if (rung === '1:1') continue;
    if (Math.abs(r / rungValue(rung) - 1) <= RUNG_TOLERANCE)
      return `${RUNG[rung].num} to ${RUNG[rung].den}`;
  }
  if (hi % CENT === 0n && lo % CENT === 0n) {
    const g = gcd(hi / CENT, lo / CENT);
    const h = hi / CENT / g;
    const l = lo / CENT / g;
    if (h <= 20n && l <= 20n) return `${h} to ${l}`;
  }
  return `${(Math.round(r * 10) / 10).toFixed(1)} to 1`;
}

/** Who stakes more (the favourite), or null for even. */
export function favoredParty(a: bigint | string, b: bigint | string): Party | null {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? null : x > y ? 'A' : 'B';
}

/** "You put in $5 to win $20" (the pot). */
export function toWinLine(my: bigint | string, pot: bigint | string): string {
  return `You put in ${formatUsd(BigInt(my).toString())} to win ${formatUsd(BigInt(pot).toString())}`;
}

export interface OfferLike {
  from: Party | 'judge';
  stakes: { a: string; b: string };
  ratio_label: string;
}

/**
 * The offer card's title for viewer `me` (null = the stage):
 *   "Jake offers 3 to 1: your $5 to win $20"   (Jake puts in more)
 *   "Jake asks 3 to 1: your $15 to win $20"    (you'd put in more)
 *   "You offer 3 to 1: your $15 to win $20"
 *   "Judge suggests 3 to 1"
 */
export function offerLine(fromName: string, offer: OfferLike, me: Party | null): string {
  const ratio = offer.ratio_label === 'Even' ? 'even money' : offer.ratio_label;
  if (offer.from === 'judge') return `Judge suggests ${ratio}`;
  const a = BigInt(offer.stakes.a);
  const b = BigInt(offer.stakes.b);
  const pot = a + b;
  if (me === null) return `${fromName} offers ${ratio}`;
  const mine = me === 'A' ? a : b;
  const theirs = me === 'A' ? b : a;
  const tail = `your ${formatUsd(mine.toString())} to win ${formatUsd(pot.toString())}`;
  if (offer.from === me) return `You offer ${ratio}: ${tail}`;
  return `${fromName} ${theirs >= mine ? 'offers' : 'asks'} ${ratio}: ${tail}`;
}

export interface StatLineInput {
  category_label: string;
  in_category: { made: number; tries: number };
  h2h: { wins: number; losses: number };
}

/** "Bottle flips 10–2 · vs Logan 4–7" (the performer's record; en dashes). */
export function statLine(s: StatLineInput, opponentName?: string): string {
  const made = s.in_category.made;
  const missed = s.in_category.tries - made;
  const plural = s.category_label.endsWith('s') ? s.category_label : `${s.category_label}s`;
  const head = `${plural} ${made}–${missed}`;
  const h2h = `${s.h2h.wins}–${s.h2h.losses}`;
  return opponentName ? `${head} · vs ${opponentName} ${h2h}` : `${head} · head-to-head ${h2h}`;
}
