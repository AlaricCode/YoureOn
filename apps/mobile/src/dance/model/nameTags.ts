// Live name tags on the recording phone's camera panel (DANCE-OFF §6.3), the pure geometry and
// smoothing: a small pill above each player's head ("Logan · 87"), placed from the live head
// keypoints through the same contain-fit math as the skeletons, smoothed with a short EMA, kept
// inside the panel and off the other tag, fading out when the tracker loses the player and back
// in where it finds them again. The tag follows the TRACKED player (A is always the tracker's A),
// and a re-found player's tag reappears at the new spot instead of sliding there, so it never
// glides across the picture onto the other person. Time is injected; tested in node.
import { headCircle, type Point, type Rect, type Size } from './overlay';

export const NAME_TAG = {
  /** Weight of the newest anchor in the smoothed position (short: ~3 frames at 15 Hz). */
  EMA_ALPHA: 0.45,
  /** Fade in / out time. */
  FADE_MS: 220,
  /** A player unseen this long starts fading (rides over a dropped frame or two). */
  LOST_HOLD_MS: 180,
  /** A visible tag whose anchor moves farther than this share of the panel width in one step
   *  blinks to the new spot (fade in there) instead of sliding. */
  JUMP_SHARE: 0.22,
  /** Pill geometry, in points. */
  HEIGHT: 24,
  PAD_X: 9,
  /** Width per character of the 13 pt label (tabular digits), a slight overestimate. */
  CHAR_W: 7.6,
  /** The face icon plus its gap. */
  ICON_W: 15,
  /** Gap between the head's top and the pill's bottom. */
  HEAD_GAP: 6,
  /** Inset from the panel edges and between two tags. */
  MARGIN: 4,
  /** A step longer than this (a stalled frame clock) counts as this long. */
  MAX_STEP_MS: 100,
} as const;
const N = NAME_TAG;

/** Where a tag points: the bottom-centre of the pill, just above the head (view points). */
export function tagAnchor(k: readonly number[], rect: Rect): Point | null {
  const head = headCircle(k, rect);
  if (!head) return null;
  return { x: head.x, y: head.y - head.r - N.HEAD_GAP };
}

/** The pill's width for a label (and the face icon). */
export function tagWidth(label: string, icon: boolean): number {
  return Math.ceil(2 * N.PAD_X + label.length * N.CHAR_W + (icon ? N.ICON_W : 0));
}

/** "Logan · 87" while the round scores, else the first name alone. */
export function tagLabel(first: string, meter: number | null): string {
  if (meter === null) return first;
  const v = Math.max(0, Math.min(100, Math.round(meter)));
  return `${first} · ${v}`;
}

/** A pill's top-left for an anchor (bottom-centre), kept inside the panel. */
export function placeTag(anchor: Point, width: number, panel: Size): Point {
  const maxX = Math.max(N.MARGIN, panel.width - width - N.MARGIN);
  const maxY = Math.max(N.MARGIN, panel.height - N.HEIGHT - N.MARGIN);
  return {
    x: Math.min(maxX, Math.max(N.MARGIN, anchor.x - width / 2)),
    y: Math.min(maxY, Math.max(N.MARGIN, anchor.y - N.HEIGHT)),
  };
}

/**
 * Two placed pills that overlap are pushed apart sideways (each half the overlap, A keeping its
 * side of B), then clamped again. Returns new top-lefts.
 */
export function separateTags(
  a: { at: Point; width: number },
  b: { at: Point; width: number },
  panel: Size,
): { a: Point; b: Point } {
  const overlapY = Math.abs(a.at.y - b.at.y) < N.HEIGHT;
  const aLeft = a.at.x + a.width / 2 <= b.at.x + b.width / 2;
  const [l, r] = aLeft ? [a, b] : [b, a];
  const overlapX = l.at.x + l.width + N.MARGIN - r.at.x;
  if (!overlapY || overlapX <= 0) return { a: a.at, b: b.at };
  const clampX = (x: number, w: number) =>
    Math.min(Math.max(N.MARGIN, panel.width - w - N.MARGIN), Math.max(N.MARGIN, x));
  const nl = { x: clampX(l.at.x - overlapX / 2, l.width), y: l.at.y };
  const nr = { x: clampX(r.at.x + overlapX / 2, r.width), y: r.at.y };
  return aLeft ? { a: nl, b: nr } : { a: nr, b: nl };
}

/** One tag's smoothed state. */
export interface TagState {
  /** Smoothed anchor (bottom-centre), view points; null before the player was ever seen. */
  pos: Point | null;
  /** 0..1. */
  opacity: number;
  /** The player is in the current frame. */
  seen: boolean;
  /** When the player was last seen. */
  lastSeenAt: number | null;
}

export const emptyTag = (): TagState => ({ pos: null, opacity: 0, seen: false, lastSeenAt: null });

/**
 * One step of one tag: `anchor` is this frame's raw anchor (null: the player is not seen),
 * `dt` the time since the last step. Seen: the EMA follows the anchor and the tag fades in.
 * Seen again after it had faded out, or after a jump: the tag reappears at the anchor (from 0).
 * Unseen: it holds its place, and fades out once unseen for LOST_HOLD_MS.
 */
export function stepTag(
  prev: TagState,
  anchor: Point | null,
  now: number,
  dt: number,
  panel: Size,
): TagState {
  const step = Math.min(N.MAX_STEP_MS, Math.max(0, dt)) / N.FADE_MS;
  if (anchor) {
    const jump =
      prev.pos !== null &&
      Math.hypot(anchor.x - prev.pos.x, anchor.y - prev.pos.y) > N.JUMP_SHARE * panel.width;
    if (prev.pos === null || (!prev.seen && prev.opacity <= 0) || jump) {
      return { pos: anchor, opacity: Math.min(1, step), seen: true, lastSeenAt: now };
    }
    const a = N.EMA_ALPHA;
    return {
      pos: {
        x: prev.pos.x + a * (anchor.x - prev.pos.x),
        y: prev.pos.y + a * (anchor.y - prev.pos.y),
      },
      opacity: Math.min(1, prev.opacity + step),
      seen: true,
      lastSeenAt: now,
    };
  }
  const lost = prev.lastSeenAt === null || now - prev.lastSeenAt >= N.LOST_HOLD_MS;
  return {
    pos: prev.pos,
    opacity: lost ? Math.max(0, prev.opacity - step) : prev.opacity,
    seen: false,
    lastSeenAt: prev.lastSeenAt,
  };
}

export interface TagInput {
  /** The player's keypoints in this frame, null when not tracked. */
  k: readonly number[] | null;
  label: string;
  icon: boolean;
}

export interface PlacedTag {
  /** Top-left in view points. */
  x: number;
  y: number;
  width: number;
  opacity: number;
  label: string;
  icon: boolean;
}

/**
 * Both tags, step by step. `step(version, …)` is idempotent per `version` (the live store's change
 * token), so a re-render of the same frame never advances the smoothing twice.
 */
export function createTagSmoother() {
  let a = emptyTag();
  let b = emptyTag();
  let lastNow: number | null = null;
  let lastVersion: number | null = null;
  let out: { A: PlacedTag | null; B: PlacedTag | null } = { A: null, B: null };

  const place = (s: TagState, input: TagInput, panel: Size): PlacedTag | null => {
    if (!s.pos || s.opacity <= 0) return null;
    const width = tagWidth(input.label, input.icon);
    const at = placeTag(s.pos, width, panel);
    return { ...at, width, opacity: s.opacity, label: input.label, icon: input.icon };
  };

  return {
    step(
      version: number,
      now: number,
      rect: Rect,
      panel: Size,
      inputs: { A: TagInput; B: TagInput },
    ): { A: PlacedTag | null; B: PlacedTag | null } {
      if (version === lastVersion) return out;
      lastVersion = version;
      const dt = lastNow === null ? 0 : now - lastNow;
      lastNow = now;
      a = stepTag(a, inputs.A.k ? tagAnchor(inputs.A.k, rect) : null, now, dt, panel);
      b = stepTag(b, inputs.B.k ? tagAnchor(inputs.B.k, rect) : null, now, dt, panel);
      let pa = place(a, inputs.A, panel);
      let pb = place(b, inputs.B, panel);
      if (pa && pb) {
        const s = separateTags({ at: pa, width: pa.width }, { at: pb, width: pb.width }, panel);
        pa = { ...pa, ...s.a };
        pb = { ...pb, ...s.b };
      }
      out = { A: pa, B: pb };
      return out;
    },
    reset() {
      a = emptyTag();
      b = emptyTag();
      lastNow = null;
      lastVersion = null;
      out = { A: null, B: null };
    },
  };
}

export type TagSmoother = ReturnType<typeof createTagSmoother>;
