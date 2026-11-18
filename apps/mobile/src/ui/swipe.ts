// Swipe to confirm: the pure maths behind SwipeToConfirm (and the drain bar's sync), kept free of
// react-native so vitest can load it in Node. Every function is a worklet: the gesture callbacks
// call them on the UI thread, so a drag never touches the JS thread except at the tick, arm and
// release crossings.
//
// Sign convention: RNGH's translationY is negative going up; `lift` is the stretch in points,
// positive going up.

import { motion, swipe } from './tokens';

/** Swipe geometry and timing (`tokens.swipe`). */
export const SWIPE = swipe;

/**
 * The settle spring after a release (`tokens.motion.settle`): critically damped and clamped, so
 * it never bounces. A spring only here, because a released finger's velocity has to carry into
 * the settle.
 */
export const SETTLE = motion.settle;

const clamp01 = (v: number): number => {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/**
 * The stretch for a finger translation `dy` (negative = up): 1:1 up to `travel`, then a rubber
 * band at `overdragFactor`, capped at `maxOverdrag` past `travel`. Never negative: pulling down
 * leaves the pill at rest.
 */
export function swipeLift(dy: number): number {
  'worklet';
  const up = -dy;
  if (!(up > 0)) return 0;
  if (up <= SWIPE.travel) return up;
  const extra = (up - SWIPE.travel) * SWIPE.overdragFactor;
  return SWIPE.travel + (extra < SWIPE.maxOverdrag ? extra : SWIPE.maxOverdrag);
}

/** 0..1 along the commit travel (the overdrag does not count). */
export function swipeProgress(lift: number): number {
  'worklet';
  return clamp01(lift / SWIPE.travel);
}

/** Armed: a release now commits. */
export function swipeArmed(lift: number): boolean {
  'worklet';
  return lift >= SWIPE.travel;
}

/**
 * How many tick marks were crossed going UP between two progress readings (`prev` exclusive,
 * `next` inclusive). Going down crosses none: the ticks are a climb, not a ruler.
 */
export function ticksCrossed(prev: number, next: number): number {
  'worklet';
  if (!(next > prev)) return 0;
  let n = 0;
  for (let i = 0; i < SWIPE.ticks.length; i++) {
    const t = SWIPE.ticks[i] as number;
    if (prev < t && next >= t) n++;
  }
  return n;
}

export type SwipeOutcome = 'commit' | 'settle';

/**
 * What a release does. Commit only when the gesture ended normally (not canceled by the system,
 * a disabled control or another gesture) AND either the pill is armed or the finger flicked up
 * fast from far enough along. Everything else settles back with no effect.
 */
export function swipeOutcome(r: {
  lift: number;
  velocityY: number;
  canceled: boolean;
}): SwipeOutcome {
  'worklet';
  if (r.canceled) return 'settle';
  if (swipeArmed(r.lift)) return 'commit';
  if (r.velocityY <= -SWIPE.flingVelocity && swipeProgress(r.lift) >= SWIPE.flingMinProgress) {
    return 'commit';
  }
  return 'settle';
}

/** The green bridge between the resting pill and the lifted cap: its scaleY for a lift. */
export function bridgeScale(lift: number): number {
  'worklet';
  return clamp01(lift / (SWIPE.travel + SWIPE.maxOverdrag));
}

/** Upward release speed in lift units (pt/s, positive = up) for the settle spring. */
export function liftVelocity(velocityY: number): number {
  'worklet';
  return -velocityY;
}

// ---------------------------------------------------------------------------------------
// Drain bar (DrainBar): where the bar starts and how long it drains
// ---------------------------------------------------------------------------------------

/**
 * The drain bar's state at `nowMs`: the fraction still left (0..1), how long it stays full first
 * (a deadline further out than the window) and how long it then takes to empty. A window of 0 or
 * less, or a deadline already past, is an empty bar that does not animate.
 */
export function drainFrom(
  endsAtMs: number,
  windowMs: number,
  nowMs: number,
): { fraction: number; holdMs: number; drainMs: number } {
  const remainingMs = Math.max(0, endsAtMs - nowMs);
  if (!(windowMs > 0) || !Number.isFinite(remainingMs) || remainingMs === 0) {
    return { fraction: 0, holdMs: 0, drainMs: 0 };
  }
  const drainMs = Math.min(remainingMs, windowMs);
  return { fraction: drainMs / windowMs, holdMs: remainingMs - drainMs, drainMs };
}
