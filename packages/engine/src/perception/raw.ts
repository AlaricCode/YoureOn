/**
 * §6.2 first stage: raw per-frame detections → quantized per-track samples.
 *
 * - `f = floor(t_ms / 100)`; per (label, track) the sample with the smallest
 *   `t_ms` wins; samples at or after `n_frames` are dropped.
 * - Coordinates: `clamp(floor(x_px*10000/width_px), 0, 10000)`.
 * - `conf = clamp(floor(confidence*100), 0, 100)`; conf 0 ⇒ no sample (absent).
 * - `fill = min(100, mask_area_norm*100 / area(bbox))` (0 if area 0), with
 *   `mask_area_norm = floor(mask_area_px * 10^8 / (width_px*height_px))`.
 * - Pose bits only for person tracks (object tracks MUST carry pose 0, §5.4).
 */
import { COORD_MAX, ELBOW_HIGH_DEG, ELBOW_LOW_DEG, FRAME_MS, POSE_REP_HIGH, POSE_REP_LOW, POSE_STANDING } from '../constants.js';
import type { QFrame, RawDetection } from '../types.js';
import { area } from './geometry.js';

/** Quantized samples of one raw track, keyed by frame. */
export interface RawTrack {
  label: string;
  track_id: number;
  /** frame → quantized record (conf ≥ 1) */
  samples: Map<number, QFrame>;
  first: number;
  last: number;
}

export interface QuantizeGeometry {
  width_px: number;
  height_px: number;
  n_frames: number;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function normCoord(px: number, size: number): number {
  return clampInt(Math.floor((px * COORD_MAX) / size), 0, COORD_MAX);
}

/** Pose bits of §6.2 (person tracks only). */
export function poseBits(pose: RawDetection['pose']): number {
  if (!pose) return 0;
  let bits = 0;
  if (pose.standing) bits |= POSE_STANDING;
  const e = pose.elbow_deg;
  if (typeof e === 'number' && Number.isFinite(e)) {
    if (e < ELBOW_LOW_DEG) bits |= POSE_REP_LOW;
    else if (e > ELBOW_HIGH_DEG) bits |= POSE_REP_HIGH;
  }
  return bits;
}

/**
 * Quantize one detection. Returns null for a detection that maps to an absent
 * record (conf 0) or carries non-finite numbers.
 */
export function quantizeDetection(d: RawDetection, g: QuantizeGeometry, withPose: boolean): QFrame | null {
  const nums = [...d.bbox_px, d.mask_area_px, d.confidence];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const conf = clampInt(Math.floor(d.confidence * 100), 0, 100);
  if (conf === 0) return null;
  const xa = normCoord(d.bbox_px[0], g.width_px);
  const ya = normCoord(d.bbox_px[1], g.height_px);
  const xb = normCoord(d.bbox_px[2], g.width_px);
  const yb = normCoord(d.bbox_px[3], g.height_px);
  const box = { x0: Math.min(xa, xb), y0: Math.min(ya, yb), x1: Math.max(xa, xb), y1: Math.max(ya, yb) };
  const maskNorm = Math.max(0, Math.floor((d.mask_area_px * 1e8) / (g.width_px * g.height_px)));
  const a = area(box);
  const fill = a === 0 ? 0 : Math.min(100, Math.floor((maskNorm * 100) / a));
  return { ...box, conf, fill, id_conf: 0, pose: withPose ? poseBits(d.pose) : 0 };
}

/**
 * Group raw detections into quantized tracks, keyed by `label#track_id`.
 * `isPersonLabel(label)` decides whether pose bits are kept.
 */
export function groupRawTracks(
  raw: readonly RawDetection[],
  g: QuantizeGeometry,
  isPersonLabel: (label: string) => boolean,
): Map<string, RawTrack> {
  if (!(g.width_px > 0) || !(g.height_px > 0)) throw new Error('quantizeSession: width_px and height_px must be positive');
  // Pick the smallest t_ms per (label, track, frame); ties keep the earliest line.
  const best = new Map<string, { t: number; d: RawDetection }>();
  for (const d of raw) {
    if (typeof d.t_ms !== 'number' || !Number.isFinite(d.t_ms) || d.t_ms < 0) continue;
    const f = Math.floor(d.t_ms / FRAME_MS);
    if (f >= g.n_frames) continue;
    const key = `${d.entity}#${d.track_id}#${f}`;
    const cur = best.get(key);
    if (!cur || d.t_ms < cur.t) best.set(key, { t: d.t_ms, d });
  }
  const tracks = new Map<string, RawTrack>();
  for (const { t, d } of best.values()) {
    const f = Math.floor(t / FRAME_MS);
    const q = quantizeDetection(d, g, isPersonLabel(d.entity));
    if (!q) continue;
    const tk = `${d.entity}#${d.track_id}`;
    let tr = tracks.get(tk);
    if (!tr) tracks.set(tk, (tr = { label: d.entity, track_id: d.track_id, samples: new Map(), first: f, last: f }));
    tr.samples.set(f, q);
    if (f < tr.first) tr.first = f;
    if (f > tr.last) tr.last = f;
  }
  return tracks;
}

/** Tracks of a given label, ascending track_id. */
export function tracksWithLabel(all: Map<string, RawTrack>, label: string): RawTrack[] {
  return [...all.values()].filter((t) => t.label === label).sort((a, b) => a.track_id - b.track_id);
}
