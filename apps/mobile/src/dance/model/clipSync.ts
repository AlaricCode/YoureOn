// Keeping the reference clip on the round's clock (../ReferenceVideo), without hitches.
//
// The clip used to be corrected by seeking: checked every 2 s, and re-seeked when it was more
// than 150 ms off. A seek is exact, so the player decodes from the keyframe before the target,
// and the routine clips have a keyframe only every ~8 s: one seek costs a few hundred ms, during
// which the clock moves on. The clip came back as far behind as the seek took, was seeked again
// 2 s later, and never caught up: measured on a simulator, 11 seeks in 22 s and the picture
// 100 to 400 ms behind the music's clock throughout, with a freeze at every seek.
//
// So small drift is taken out with SPEED, which is seamless: the clip runs a few percent fast or
// slow (pitch preserved) until it is back on the clock, then at its own speed again. The speed is
// changed as seldom as possible (once to start correcting, once to stop), because every change
// re-tunes the player's audio: a version that re-tuned on every check hovered 100 ms behind and
// never closed the gap. A seek is kept for a clip that is far off (it joined late, or was
// interrupted), and it aims AHEAD by what a seek costs on this device, a figure learned from how
// far behind the last one landed. Pure, tested.

/** How often the clip is checked against the clock. */
export const CLIP_SYNC_CHECK_MS = 250;
/** A clip playing at its own speed is left alone inside this (a frame of a 24 fps clip is 42). */
export const CLIP_SYNC_ENGAGE_MS = 60;
/** A clip being corrected goes back to its own speed once it is this close (or has crossed). */
export const CLIP_SYNC_RELEASE_MS = 15;
/** The speed of a clip that is behind, and of one that is ahead: not enough to look wrong. */
export const CLIP_RATE_CATCH_UP = 1.08;
export const CLIP_RATE_HOLD_BACK = 0.93;
/** Further off than this, speed alone would take too long: the clip is seeked. */
export const CLIP_SEEK_BEYOND_MS = 600;
/** Nothing is corrected for this long after the clip starts playing (it is still spinning up). */
export const CLIP_START_SETTLE_MS = 500;
/** ...or for this long after a seek (the player reports the target while it still decodes). */
export const CLIP_SEEK_SETTLE_MS = 1_200;
/** What a seek is assumed to cost before one has been measured. */
export const CLIP_SEEK_LEAD_MS = 250;
/** A seek never aims further ahead than this. */
export const CLIP_SEEK_LEAD_MAX_MS = 2_000;
/** A clip already this close to where it should start is played as it is, not seeked. */
export const CLIP_START_NEAR_MS = 50;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Is a clip at `rate` being corrected (not at its own speed)? */
const correcting = (rate: number) => Math.abs(rate - 1) > 0.004;

/**
 * The speed for a clip `driftMs` off the clock (+ = ahead) that is playing at `rate`. A clip at
 * its own speed starts being corrected only past CLIP_SYNC_ENGAGE_MS; one being corrected keeps
 * its corrected speed until the drift is inside CLIP_SYNC_RELEASE_MS or has changed sign. So a
 * correction is two changes of speed, however long it takes.
 */
export function clipRateFor(driftMs: number, rate = 1): number {
  if (!Number.isFinite(driftMs)) return 1;
  if (!correcting(rate)) {
    if (driftMs < -CLIP_SYNC_ENGAGE_MS) return CLIP_RATE_CATCH_UP;
    if (driftMs > CLIP_SYNC_ENGAGE_MS) return CLIP_RATE_HOLD_BACK;
    return 1;
  }
  if (rate > 1) return driftMs < -CLIP_SYNC_RELEASE_MS ? CLIP_RATE_CATCH_UP : 1;
  return driftMs > CLIP_SYNC_RELEASE_MS ? CLIP_RATE_HOLD_BACK : 1;
}

/** Is the clip too far off for speed (then it is seeked)? */
export const clipNeedsSeek = (driftMs: number): boolean => Math.abs(driftMs) > CLIP_SEEK_BEYOND_MS;

/**
 * What the next seek should aim ahead by, from the lead the last one used and the drift it
 * settled at (− = it landed behind: the seek cost more than the lead allowed for).
 */
export function nextSeekLeadMs(leadMs: number, settledDriftMs: number): number {
  if (!Number.isFinite(settledDriftMs)) return leadMs;
  return clamp(Math.round(leadMs - settledDriftMs), 0, CLIP_SEEK_LEAD_MAX_MS);
}

/**
 * Where to seek a clip to (seconds) so that it is on the clock once the seek has landed: where
 * the round will be `leadMs` from `now`, never past the clip's end.
 */
export function clipSeekTargetSec(
  startAt: number,
  now: number,
  leadMs: number,
  durationMs: number,
): number {
  const at = Math.max(0, now + leadMs - startAt);
  return (Number.isFinite(durationMs) && durationMs > 0 ? Math.min(at, durationMs) : at) / 1000;
}
