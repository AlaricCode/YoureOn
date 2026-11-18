// Pure logic and numbers behind the polish components (./press, ./StakePicker, ./Skeleton):
// press feedback targets, where the stake picker's sliding pill sits, the history list's
// loading / error / list choice, and the skeleton's bar widths. No react-native imports, so
// vitest loads it in Node.
//
// The timing numbers come from tokens.ts (`motion.press*`, `skeleton`); every component reads them
// only from here.

import { MAX_TRANSITION_MS, motion, skeleton as skeletonTokens } from './tokens';

/** Press feedback (`tokens.motion.press*`). */
export const press = {
  /** Scale-down on press-in. */
  inMs: motion.pressInMs,
  /** Back to rest on release. */
  outMs: motion.pressOutMs,
  /** Buttons. */
  scale: motion.pressScale,
  /** Stake chips (smaller targets, so a deeper press). */
  chipScale: motion.chipPressScale,
  /** The avatar disc on Home. */
  avatarScale: 0.92,
  /** Opacity while pressed, with the scale. */
  opacity: 0.85,
  /** Under Reduce Motion: no scale, the old pressed dim (kit `pressed`), instantly. */
  reducedOpacity: 0.7,
} as const;

/** The stake picker's sliding pill. */
export const stakePill = {
  /** The pill slides to the chosen chip over one standard transition. */
  slideMs: MAX_TRANSITION_MS,
  /** Chip label white <-> black. */
  inkMs: 150,
  /** The whole group while disabled (ChoiceChip's `choiceDisabled`). */
  disabledOpacity: 0.4,
} as const;

/** History loading skeleton (`tokens.skeleton` plus the row geometry). */
export const skeleton = {
  /** One leg of the pulse (1 -> low, then back). */
  pulseMs: skeletonTokens.pulseMs,
  low: skeletonTokens.low,
  /** Under Reduce Motion the rows hold still at this opacity. */
  reducedOpacity: 0.75,
  /** Bar height (the row title / amount line). */
  bar: skeletonTokens.bar,
  /** The caption bar under the amount. */
  caption: 10,
  /** Disc size, as the history avatar (avatarSize.md). */
  disc: 40,
  /** The amount bar. */
  amountWidth: 56,
  captionWidth: 32,
} as const;

// ---------------------------------------------------------------------------------------
// Press
// ---------------------------------------------------------------------------------------

export type PressTarget = { scale: number; opacity: number; ms: number };

/**
 * Where a pressable animates to. Pressed: scale down and dim over `inMs`; released: back over
 * `outMs`. Reduce Motion: no scale, the plain 0.7 dim, no animation (ms 0).
 */
export function pressTarget(pressed: boolean, reduced: boolean, scaleTo: number): PressTarget {
  if (reduced) return { scale: 1, opacity: pressed ? press.reducedOpacity : 1, ms: 0 };
  return pressed
    ? { scale: scaleTo, opacity: press.opacity, ms: press.inMs }
    : { scale: 1, opacity: 1, ms: press.outMs };
}

/** Scale and opacity at press amount `amt` (0 rest .. 1 pressed). Worklet-safe. */
export function pressAt(
  amt: number,
  reduced: boolean,
  scaleTo: number,
): { scale: number; opacity: number } {
  'worklet';
  const a = amt < 0 ? 0 : amt > 1 ? 1 : amt;
  if (reduced) return { scale: 1, opacity: 1 - (1 - press.reducedOpacity) * a };
  return { scale: 1 - (1 - scaleTo) * a, opacity: 1 - (1 - press.opacity) * a };
}

// ---------------------------------------------------------------------------------------
// Stake picker
// ---------------------------------------------------------------------------------------

export type Frame = { x: number; y: number; width: number; height: number };

/** True once every option's chip has reported its layout. */
export function allMeasured(
  options: readonly number[],
  frames: Readonly<Record<number, Frame | undefined>>,
): boolean {
  return options.length > 0 && options.every((o) => frames[o] !== undefined);
}

/** The frame the pill sits on, or null (not measured yet, or the value is not an option). */
export function pillFrame(
  options: readonly number[],
  frames: Readonly<Record<number, Frame | undefined>>,
  value: number,
): Frame | null {
  if (!allMeasured(options, frames) || !options.includes(value)) return null;
  return frames[value] ?? null;
}

/** Whether a frame changed enough to re-render (sub-pixel layout noise ignored). */
export function sameFrame(a: Frame | undefined, b: Frame): boolean {
  if (!a) return false;
  const near = (p: number, q: number) => Math.abs(p - q) < 0.5;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

/**
 * How the pill moves to its frame: the first placement (or Reduce Motion) jumps, so it never
 * flies in from the corner; after that it slides.
 */
export function pillMove(placedBefore: boolean, reduced: boolean): 'jump' | 'slide' {
  return placedBefore && !reduced ? 'slide' : 'jump';
}

/** A tap on chip `next`: always reported (as ChoiceChip did); the select haptic only on change. */
export function stakeTap(
  value: number,
  next: number,
  disabled: boolean,
): { report: boolean; haptic: boolean } {
  if (disabled) return { report: false, haptic: false };
  return { report: true, haptic: next !== value };
}

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

export type HistoryMode = 'skeleton' | 'error' | 'empty' | 'list';

/**
 * What History shows. Loading with nothing yet: the skeleton. Failed with nothing: the error.
 * Anything already loaded stays on screen (a reload is the pull-to-refresh spinner, not a blank).
 */
export function historyMode(
  status: 'loading' | 'ready' | 'failed',
  count: number,
): { mode: HistoryMode; refreshing: boolean } {
  if (count === 0) {
    if (status === 'loading') return { mode: 'skeleton', refreshing: false };
    if (status === 'failed') return { mode: 'error', refreshing: false };
    return { mode: 'empty', refreshing: false };
  }
  return { mode: 'list', refreshing: status === 'loading' };
}

// ---------------------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------------------

/** Title-bar widths as a fraction of the text column: varied, fixed (no random jitter). */
const TITLE_FRACTIONS = [0.62, 0.46, 0.7, 0.54, 0.66, 0.5] as const;

/** The title bar's width fraction for row `i` (repeats every six rows). */
export function skeletonTitleFraction(i: number): number {
  const n = TITLE_FRACTIONS.length;
  return TITLE_FRACTIONS[((i % n) + n) % n] ?? TITLE_FRACTIONS[0];
}
