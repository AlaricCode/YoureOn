// The rolling-number maths (ui/RollingNumber draws it). Pure TS, worklet-safe (every function
// the UI thread calls carries the 'worklet' directive and touches only its arguments), so it is
// tested in Node.
//
// Two modes:
// - Cents (a balance, a payout): one animated value `v` in cents rolls from the old figure to the
//   new one. Each digit column is a strip "0 1 2 … 9 0" moved to row `odometerRow(v, k)`. The
//   lowest digit spins with v; every higher digit carries only while the digits below it pass
//   9 → 0, like a real odometer.
// - Text (the live market price): each changed digit rolls from its old digit to its new one,
//   all in one direction (up when the number went up), over `TICKER.tickMs`. The strip there is
//   "0 … 9 0 … 9" so a roll can wrap (9 → 0 going up is row 9 → 10).

import { ticker } from './tokens';

/** Ticker tuning (`tokens.ticker`). */
export const TICKER = ticker;

/** Cents-mode strip: 0-9 then 0 again, so 9 -> 0 rolls on (row 9 -> 10). */
export const CENTS_STRIP = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n0';
/** Text-mode strip: two turns, so any roll fits in one direction. */
export const TEXT_STRIP = `${CENTS_STRIP}\n1\n2\n3\n4\n5\n6\n7\n8\n9`;

/**
 * The strip row of digit column `k` (0 = cents ones, 1 = cents tens, 2 = dollars ones, …) for
 * the value `v` in cents (fractional while rolling). Row r shows digit r mod 10; rows are
 * continuous, so 9.5 is halfway from 9 to the 0 under it.
 * - k = 0: v mod 10 (spins continuously).
 * - k >= 1: floor(v / 10^k) mod 10, plus the carry: the fraction by which the digits below are
 *   past all-nines (only while they roll 99… -> 00…).
 */
export function odometerRow(v: number, k: number): number {
  'worklet';
  const a = v > 0 ? v : 0;
  if (k <= 0) return a % 10;
  const p = Math.pow(10, k);
  const rem = a % p;
  const carry = Math.min(1, Math.max(0, rem - (p - 1)));
  return (Math.floor(a / p) % 10) + carry;
}

/** Digit columns that always show: cents ones, cents tens and dollars ones ("$0.05"). */
export const FIXED_COLUMNS = 3;

/**
 * How open (0..1) leading column `k` is at `v` cents: 1 for the fixed columns (k < 3); for a
 * leading dollars digit, 0 below 10^k, 1 at or above it, and the carry fraction in between (so
 * $9.99 -> $10.00 opens the tens column exactly as the 1 rolls in).
 */
export function leadingReveal(v: number, k: number): number {
  'worklet';
  if (k < FIXED_COLUMNS) return 1;
  const p = Math.pow(10, k);
  return Math.min(1, Math.max(0, v - (p - 1)));
}

/** How many whole-dollar digits `cents` shows: "$0.05" 1, "$12.50" 2, "$1250.00" 4. */
export function dollarDigits(cents: number): number {
  return Math.max(1, String(Math.floor(Math.abs(Math.trunc(cents)) / 100)).length);
}

export type Column =
  | { readonly kind: 'digit'; readonly digit: number }
  | { readonly kind: 'glyph'; readonly ch: string };

/** "$1,234.50" -> digit and fixed-glyph columns ($ , . + − and anything else stay static). */
export function columnsOf(text: string): Column[] {
  return Array.from(text, (ch) =>
    ch >= '0' && ch <= '9'
      ? { kind: 'digit', digit: ch.charCodeAt(0) - 48 }
      : { kind: 'glyph', ch },
  );
}

/** The number a display string reads as ("$97,120.50" -> 97120.5, "−$3.00" -> -3), or NaN. */
export function numberOf(text: string): number {
  const negative = /^[^0-9]*[-−]/.test(text);
  const digits = text.replace(/[^0-9.]/g, '');
  if (!/[0-9]/.test(digits)) return Number.NaN;
  const n = Number(digits);
  return negative ? -n : n;
}

/** +1 if `to` reads as a bigger number than `from`, -1 smaller, 0 equal or unreadable. */
export function textDirection(from: string, to: string): -1 | 0 | 1 {
  const a = numberOf(from);
  const b = numberOf(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 0;
  return b > a ? 1 : -1;
}

export type RollColumn =
  | {
      readonly kind: 'digit';
      readonly digit: number;
      readonly fromRow: number;
      readonly toRow: number;
    }
  | { readonly kind: 'glyph'; readonly ch: string };

/**
 * Text mode: the columns of `to`, each digit with the TEXT_STRIP rows it rolls between. Columns
 * line up from the right (numbers grow to the left). Only a digit that changed, over a digit in
 * the same place, rolls; it rolls the way `dir` says (up: rows increase, wrapping 9 -> 0 via
 * row 10; down: rows decrease, starting a turn higher when it wraps; 0 counts as up). Everything
 * else (unchanged, new columns, glyph swaps) just shows its digit (fromRow = toRow = digit).
 */
export function rollPlan(from: string, to: string, dir: -1 | 0 | 1): RollColumn[] {
  const before = columnsOf(from);
  const after = columnsOf(to);
  const offset = before.length - after.length;
  return after.map((col, i) => {
    if (col.kind === 'glyph') return col;
    const b = col.digit;
    const old = before[i + offset];
    if (old === undefined || old.kind !== 'digit' || old.digit === b)
      return { kind: 'digit', digit: b, fromRow: b, toRow: b };
    const a = old.digit;
    if (dir >= 0) return { kind: 'digit', digit: b, fromRow: a, toRow: b > a ? b : b + 10 };
    return { kind: 'digit', digit: b, fromRow: b < a ? a : a + 10, toRow: b };
  });
}
