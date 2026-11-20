// Form factor: how big the interface is drawn on this device. A phone is 1. An iPad is not a
// big phone: it sits further away (on a stand, on a table between two people), so everything is
// drawn larger, type, controls, spacing and all, and the layout column grows with it
// (./tokens scales every size token by this; ./column lays the screens out).
//
// The scale is set ONCE, before any style module is evaluated: ./formFactorBoot is the first
// import of the app entry (index.ts) and calls setUiScale; ./tokens reads uiScale() as it loads.
// Anything that loads the tokens without the boot (the node tests) gets 1, the phone.
//
// Pure TS: no react-native import, so the tokens stay loadable in node.

/** The largest an interface is drawn (a 13-inch iPad). */
export const UI_SCALE_MAX = 1.5;
/** The smallest an iPad's is (an iPad mini): still clearly not a phone. */
export const UI_SCALE_MIN_TABLET = 1.15;
/** The short side (pt) an iPad's scale is measured against: at 640 it would be 1. */
const TABLET_REFERENCE_SIDE = 640;

let scale = 1;

/** Under this short side (pt) an iPad's window is a phone's: a split, a slide-over. */
export const TABLET_MIN_SIDE = 600;

/**
 * The scale for a device from the short side (pt) of what it draws on: 1 on every phone, and on
 * an iPad whose window is phone-sized; otherwise the short side over 640, in steps of 0.05,
 * within [1.15, 1.5]. An 11-inch iPad (834 pt) is 1.3, so its content column is about five
 * sixths of the screen held upright.
 */
export function scaleFor(shortSide: number, isPad: boolean): number {
  if (!isPad || !(shortSide >= TABLET_MIN_SIDE)) return 1;
  const k = Math.round((shortSide / TABLET_REFERENCE_SIDE) * 20) / 20;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN_TABLET, k));
}

/** Set the scale. Call once at startup, before anything imports ./tokens. */
export function setUiScale(k: number): void {
  scale = Number.isFinite(k) ? Math.min(UI_SCALE_MAX, Math.max(1, k)) : 1;
}

/** The scale this interface is drawn at (1 until setUiScale is called). */
export function uiScale(): number {
  return scale;
}
