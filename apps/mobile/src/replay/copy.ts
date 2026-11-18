// Every string the slow-mo replay shows on a phone, with its copy-rule role (ui/copyRule): labels
// are 1-3 words and never a sentence; names and the detector's measurement ("Toe 17 cm over") are
// data. The judge's spoken reason is deliberately not shown on the phone (the stage carries it).
// ./__tests__/copy.test.ts runs checkCopy over this table.
import type { CopyRole } from '../ui/copyRule';

export const REPLAY_COPY = {
  /** The button on the payout screen. */
  replay: 'Replay',
  /** The badge over the player. */
  badge: 'Slow-mo replay',
  /** What the badge illustrates: a win (mode A). */
  win: 'Winning moment',
  /** What the badge illustrates: a confirmed foul (mode B). */
  foul: 'Foul',
  /** The tag on the held frame when the judge cited it. */
  judgesFrame: "Judge's frame",
  again: 'Replay again',
  done: 'Done',
  /** Accessibility label of the close cross (no visible text). */
  close: 'Close',
  error: 'Replay unavailable',
} as const;

export type ReplayCopyKey = keyof typeof REPLAY_COPY;

/** The role checkCopy applies to each string. */
export const REPLAY_COPY_ROLES: Record<ReplayCopyKey, CopyRole> = {
  replay: 'label',
  badge: 'label',
  win: 'label',
  foul: 'label',
  judgesFrame: 'label',
  again: 'label',
  done: 'label',
  close: 'label',
  error: 'error',
};

/** "{name} wins": data (a display name), so exempt from the word limit. */
export const winsChip = (name: string): string => `${name} wins`;

/** The speed tag beside the badge, e.g. "0.25x" (data). */
export const speedTag = (rate: number): string => `${Number(rate.toFixed(2))}x`;
