// The Dance Off's colours, from the Obsidian palette only: A is green (the accent), B is white,
// anyone else dim; a key-move grade is green (PERFECT), white (GOOD) or grey (MISS: nothing was
// lost yet, so no red).
import type { KeyMoveGrade } from '@youre-on/shared/dance/score';

import { palette } from '../ui/tokens';

export const PLAYER_TINT = { A: palette.accent, B: palette.text } as const;

/** Everyone the tracker did not assign (a third person, a passer-by). */
export const OTHER_TINT = palette.textTertiary;

/** The reference skeleton. */
export const REFERENCE_TINT = palette.text;

export const GRADE_TINT: Readonly<Record<KeyMoveGrade, string>> = {
  PERFECT: palette.accent,
  GOOD: palette.text,
  MISS: palette.textSecondary,
};
