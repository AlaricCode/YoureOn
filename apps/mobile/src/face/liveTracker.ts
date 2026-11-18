// Follows faces across live detector frames for the rivalry scan (pure, no React Native).
//
//   detector frames (10-15 Hz, view coordinates)
//     -> updateTracks: one Track per face. The key is the detector's trackingId (`t<id>`) when it
//        gives one, else a greedy IoU match (>= IOU_MIN) against the live tracks, else a fresh
//        `i<n>`. Boxes are smoothed (EMA); a track not seen for LOST_GRACE_MS is dropped.
//     -> eligible: big enough, facing the camera, seen a few times and holding still, so a photo
//        taken now will show the same face where the track says it is.
//     -> pickFocus: the face being pointed at, by pickProbeFace's rule (of the faces at least
//        half the largest one's area, the one nearest the centre), with hysteresis so the card
//        does not flicker between two people standing side by side.
//
// A track's `status` (what the engine knows about who it is) is carried along untouched; the
// engine (src/app/liveScan.ts) owns it.
import type { RawDetection, Size, Track } from '../rivalry/types';
import { RIVAL_FACE_AREA_SHARE, type Box } from './pipeline';

/** A face must be this share of the VIEW's width to be matched. On a 960x1280 still that the
 *  view aspect-fills (393x852), this is MIN_SCAN_FACE_SHARE (0.08) of the still's width. */
export const LIVE_MIN_FACE_WIDTH_SHARE = 0.13;
/** Head turned further than this: the embedding is poor, so wait. */
export const LIVE_MAX_YAW_DEG = 30;
/** The centre must hold within STABLE_DRIFT x width for this long. */
export const STABLE_MS = 300;
export const STABLE_DRIFT = 0.2;
/** Detections a track needs before it is matched (filters one-frame false faces). */
export const MIN_HITS = 3;
/** A track not seen for this long is gone. */
export const LOST_GRACE_MS = 600;
/** Weight of the new box in the smoothed box. */
export const EMA_ALPHA = 0.5;
/** Another face takes the focus only when nearer the centre by this share of the view width. */
export const FOCUS_SWITCH_MARGIN = 0.12;
/** The focused face keeps the focus through a dropout this short. */
export const FOCUS_LOST_MS = 300;
/** IoU needed to continue a track when the detector gives no trackingId. */
export const IOU_MIN = 0.3;
/** A track counts as "in view now" (for matching) if seen within this. */
export const SEEN_NOW_MS = 200;

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

const ema = (prev: Box, next: Box, a = EMA_ALPHA): Box => ({
  x: a * next.x + (1 - a) * prev.x,
  y: a * next.y + (1 - a) * prev.y,
  width: a * next.width + (1 - a) * prev.width,
  height: a * next.height + (1 - a) * prev.height,
});

/** Source of fresh `i<n>` keys. The engine keeps one so a key is never reused in a session. */
export interface TrackKeySeq {
  next: number;
}

const nextFromTracks = (tracks: readonly Track[]): number =>
  tracks.reduce((n, t) => {
    const m = /^i(\d+)$/.exec(t.key);
    return m ? Math.max(n, Number(m[1]) + 1) : n;
  }, 0);

function continueTrack(t: Track, d: RawDetection, atMs: number): Track {
  const box = ema(t.box, d.bounds);
  const c = centre(box);
  const anchor = t.anchor ?? centre(t.box);
  const drift = Math.hypot(c.x - anchor.x, c.y - anchor.y);
  const steady = t.stableSinceMs !== null && drift <= STABLE_DRIFT * box.width;
  return {
    ...t,
    box,
    yawAngle: d.yawAngle,
    lastSeenMs: atMs,
    hits: t.hits + 1,
    stableSinceMs: steady ? t.stableSinceMs : atMs,
    anchor: steady ? anchor : c,
  };
}

function newTrack(key: string, d: RawDetection, atMs: number): Track {
  return {
    key,
    box: d.bounds,
    yawAngle: d.yawAngle,
    firstSeenMs: atMs,
    lastSeenMs: atMs,
    hits: 1,
    stableSinceMs: atMs,
    anchor: centre(d.bounds),
    status: { kind: 'pending' },
  };
}

/**
 * One detector frame. Returns the new track list: continued tracks (same key, same status),
 * new ones (status pending), and unseen ones still inside LOST_GRACE_MS (box frozen).
 * `seq` supplies fresh `i<n>` keys; without one, keys continue from the largest in `prev`.
 */
export function updateTracks(
  prev: readonly Track[],
  dets: readonly RawDetection[],
  atMs: number,
  _view: Size,
  seq: TrackKeySeq = { next: nextFromTracks(prev) },
): Track[] {
  const byKey = new Map(prev.map((t) => [t.key, t]));
  const used = new Set<string>();
  const out: Track[] = [];

  // 1. Detector ids: the key is the id.
  const anonymous: RawDetection[] = [];
  for (const d of dets) {
    if (d.trackingId === undefined || d.trackingId === null) {
      anonymous.push(d);
      continue;
    }
    const key = `t${d.trackingId}`;
    if (used.has(key)) continue; // the same id twice in a frame: keep the first
    used.add(key);
    const t = byKey.get(key);
    out.push(t ? continueTrack(t, d, atMs) : newTrack(key, d, atMs));
  }

  // 2. No id: greedy IoU against the tracks not yet continued, best pairs first.
  const pairs: { d: number; t: Track; v: number }[] = [];
  anonymous.forEach((d, i) => {
    for (const t of prev) {
      if (used.has(t.key)) continue;
      const v = iou(t.box, d.bounds);
      if (v >= IOU_MIN) pairs.push({ d: i, t, v });
    }
  });
  pairs.sort((a, b) => b.v - a.v);
  const taken = new Set<number>();
  for (const p of pairs) {
    if (taken.has(p.d) || used.has(p.t.key)) continue;
    taken.add(p.d);
    used.add(p.t.key);
    out.push(continueTrack(p.t, anonymous[p.d] as RawDetection, atMs));
  }
  anonymous.forEach((d, i) => {
    if (taken.has(i)) return;
    let key = `i${seq.next++}`;
    while (byKey.has(key) || used.has(key)) key = `i${seq.next++}`;
    used.add(key);
    out.push(newTrack(key, d, atMs));
  });

  // 3. Unseen this frame: kept through the grace period.
  for (const t of prev) {
    if (used.has(t.key)) continue;
    if (atMs - t.lastSeenMs <= LOST_GRACE_MS) out.push(t);
  }
  return out;
}

/** Big enough to match (view coordinates). */
export const bigEnough = (t: Pick<Track, 'box'>, view: Size): boolean =>
  t.box.width >= LIVE_MIN_FACE_WIDTH_SHARE * view.width;

/** Worth a photo now: in view, big enough, facing us, seen a few times, holding still. */
export function eligible(t: Track, view: Size, atMs: number): boolean {
  return (
    atMs - t.lastSeenMs <= SEEN_NOW_MS &&
    bigEnough(t, view) &&
    Math.abs(t.yawAngle) <= LIVE_MAX_YAW_DEG &&
    t.hits >= MIN_HITS &&
    t.stableSinceMs !== null &&
    atMs - t.stableSinceMs >= STABLE_MS
  );
}

/**
 * The face being pointed at: pickProbeFace's rule in view space (of the faces at least
 * RIVAL_FACE_AREA_SHARE of the largest one's area, the one nearest the centre), with
 * hysteresis: the focus stays on `prevKey` until it has been gone FOCUS_LOST_MS, stops being a
 * contender, or another contender is nearer the centre by FOCUS_SWITCH_MARGIN x view width.
 */
export function pickFocus(
  tracks: readonly Track[],
  prevKey: string | null,
  view: Size,
  atMs: number,
): string | null {
  const present = tracks.filter((t) => atMs - t.lastSeenMs <= FOCUS_LOST_MS);
  if (present.length === 0) return null;
  const area = (t: Track) => t.box.width * t.box.height;
  const largest = Math.max(...present.map(area));
  const contenders = present.filter((t) => area(t) >= RIVAL_FACE_AREA_SHARE * largest);
  const cx = view.width / 2;
  const cy = view.height / 2;
  const dist = (t: Track) => {
    const c = centre(t.box);
    return Math.hypot(c.x - cx, c.y - cy);
  };
  const best = contenders.reduce((a, t) => (dist(t) < dist(a) ? t : a));
  const prev = prevKey === null ? undefined : contenders.find((t) => t.key === prevKey);
  if (!prev) return best.key;
  return dist(best) + FOCUS_SWITCH_MARGIN * view.width < dist(prev) ? best.key : prev.key;
}
