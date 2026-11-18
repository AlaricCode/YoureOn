// The sparkline scrub maths (ui/ScrubSparkline draws it, ui/figures BalanceHeader shows the
// value). Pure TS, worklet-safe where the UI thread calls it, tested in Node.
//
// While a finger is on the Home sparkline the hairline snaps to the nearest balance point; the
// figure shows that point's balance and the change line shows the change from the first point
// up to it (Robinhood's meaning: the line at rest already reads "change over the range").

import { centsToUsd, signedCentsToUsd } from './money';
import { scrub } from './tokens';

/** Scrub tuning (`tokens.scrub`). */
export const SCRUB = scrub;

/**
 * The series index nearest to `x` on a sparkline of `n` points laid out by spark.sparkPoints
 * across `width` with insets `pad` (right) and `padLeft` (left). Clamped to [0, n - 1].
 */
export function indexAtX(x: number, n: number, width: number, pad: number, padLeft = pad): number {
  'worklet';
  if (n <= 1) return 0;
  const w = width - padLeft - pad;
  if (!(w > 0)) return n - 1;
  const i = Math.round(((x - padLeft) / w) * (n - 1));
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
}

/** The change from the first point up to point `i` (clamped into the series); 0 if empty. */
export function scrubDelta(series: readonly number[], i: number): number {
  if (series.length === 0) return 0;
  const j = Math.min(series.length - 1, Math.max(0, Math.round(i)));
  return (series[j] as number) - (series[0] as number);
}

/**
 * VoiceOver's adjustable step over the series: `at` is the point being read (null = live, the
 * last point). Decrement walks back toward the first point; increment walks forward and returns
 * to live (null) at the last point. Visible state never changes.
 */
export function scrubStep(at: number | null, n: number, dir: 1 | -1): number | null {
  if (n < 2) return null;
  const cur = at ?? n - 1;
  const next = Math.min(n - 1, Math.max(0, cur + dir));
  return next >= n - 1 ? null : next;
}

/**
 * The balance block's accessibilityValue: "$32.15, +$2.15" (balance, then the change). Live
 * (`at` null) reads the live balance and the resting change (and a payout `delta` when one is
 * showing); a point reads that point's balance and the change up to it.
 */
export function balanceA11yValue({
  cents,
  series,
  at,
  changeCents,
  delta,
  inBetsUsd,
}: {
  cents: number;
  series: readonly number[];
  at: number | null;
  changeCents?: number | null | undefined;
  delta?: string | null | undefined;
  inBetsUsd?: string | null | undefined;
}): string {
  const parts: string[] = [];
  if (at !== null && series.length > 0) {
    const j = Math.min(series.length - 1, Math.max(0, at));
    parts.push(centsToUsd(series[j] as number), signedCentsToUsd(scrubDelta(series, j)));
  } else {
    parts.push(centsToUsd(cents));
    if (delta) parts.push(delta);
    else if (changeCents !== null && changeCents !== undefined)
      parts.push(signedCentsToUsd(changeCents));
  }
  if (inBetsUsd) parts.push(`In bets ${inBetsUsd}`);
  return parts.join(', ');
}
