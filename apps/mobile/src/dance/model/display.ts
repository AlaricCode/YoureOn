// What the Dance Off display (../DanceDisplayScreen) draws over the reference, sized from the
// screen it is on. Any device can be the display (it is whichever one is signed in as B): a
// phone keeps exactly the sizes it always had, and a bigger screen gets proportionally bigger
// words, so on an iPad the count-in and the names read from across a room. Pure TS, tested in
// node.
import type { Size } from './overlay';

/**
 * The sizes on a phone (pt). They are the app's own type sizes at a phone's scale (heading 17,
 * subtitle 22, section 15, a 48 pt margin; ../../ui/tokens), written out here because the
 * display has its own scale: the tokens grow by a third on an iPad, the display by the screen.
 */
export const DISPLAY_PHONE = {
  /** The count-in numeral: as big as a phone held at arm's length needs. */
  numeral: 240,
  title: 17,
  name: 22,
  vs: 15,
  status: 22,
  bar: 2,
  edge: 48,
} as const;

/** The widest phone (pt, short side). Up to here the display is drawn at the phone's sizes. */
export const DISPLAY_PHONE_SIDE = 440;

export type DisplaySizes = {
  /** The count-in numeral's font size. */
  readonly numeral: number;
  /** The routine's title. */
  readonly title: number;
  /** The two names. */
  readonly name: number;
  /** The "vs" between them. */
  readonly vs: number;
  /** "Get ready", "Scoring". */
  readonly status: number;
  /** The progress bar's thickness. */
  readonly bar: number;
  /** How far the words sit from the top and the bottom edge: the same on every screen. */
  readonly edge: number;
};

/** How much bigger than a phone's a `box` (pt, either way up) is drawn: 1 on every phone. */
export function displayScale(box: Size): number {
  const short = Math.min(box.width, box.height);
  return short > DISPLAY_PHONE_SIDE ? short / DISPLAY_PHONE_SIDE : 1;
}

/**
 * Sizes for a `box`: the phone's, times the box's short side over the widest phone's. An
 * 11-inch iPad (834 pt) is 1.9 times a phone, a 13-inch (1032 pt) 2.3 times.
 */
export function displaySizes(box: Size): DisplaySizes {
  const k = displayScale(box);
  const at = (n: number) => Math.round(n * k);
  return {
    numeral: at(DISPLAY_PHONE.numeral),
    title: at(DISPLAY_PHONE.title),
    name: at(DISPLAY_PHONE.name),
    vs: at(DISPLAY_PHONE.vs),
    status: at(DISPLAY_PHONE.status),
    bar: at(DISPLAY_PHONE.bar),
    // Not scaled: a bigger screen's words stay in the band above and below the reference
    // rather than growing down over the dancer's head and feet.
    edge: DISPLAY_PHONE.edge,
  };
}

/** A type size with the line height it needs. */
export const sized = (fontSize: number) => ({ fontSize, lineHeight: Math.round(fontSize * 1.25) });
