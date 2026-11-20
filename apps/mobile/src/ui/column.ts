// One column. Every screen is designed at a phone's width; on an iPad the same column sits in
// the middle of the screen instead of stretching to its edges (a 56 pt button a thousand points
// wide is not a button). Light that belongs to the whole screen (the aurora, the voice edge
// light, a full-screen replay or dance display) still uses the whole screen.
//
// A phone on its side is left alone: its short side is under `tabletMinSide`, so the judge cam on
// a tripod keeps the full width. A narrow iPad window (Split View, Slide Over) is already
// phone-sized and is left alone too.
//
// Pure TS (the hook that reads the window lives in ./kit), tested in node.
import { layout } from './tokens';

export type Column = {
  /** The width content is laid out in. */
  readonly width: number;
  /** The margin either side of the column (0 when it fills the window). */
  readonly inset: number;
  /** The window is wider than the column: screens centre themselves in it. */
  readonly wide: boolean;
};

/** The content column for a `width` x `height` (pt) window, either orientation. */
export function columnFor(width: number, height: number): Column {
  const tablet = Math.min(width, height) >= layout.tabletMinSide;
  const wide = tablet && width > layout.maxContentWidth;
  const w = wide ? layout.maxContentWidth : width;
  return { width: w, inset: (width - w) / 2, wide };
}
