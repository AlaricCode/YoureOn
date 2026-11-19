// Pure helpers for the DancePose payloads. No React Native imports, so node tests can load it.
import type {
  DanceSnapshot,
  PoseFrameEvent,
  StatusEvent,
  StillResult,
  StopRoundResult,
} from './types';

/** The contract's joint order (DANCE-OFF.md §2), indices 0..18, as in ios/PoseExtraction.swift. */
export const JOINT_ORDER = [
  'nose',
  'leftEye',
  'rightEye',
  'leftEar',
  'rightEar',
  'neck',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'root',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee',
  'leftAnkle',
  'rightAnkle',
] as const;

export type JointName = (typeof JOINT_ORDER)[number];

/** Numbers per raw person: [x, y, c] × 19. */
export const KEYPOINT_COUNT = JOINT_ORDER.length * 3;

export const DEFAULT_MAX_FPS = 30;
export const MIN_MAX_FPS = 1;
export const MAX_MAX_FPS = 60;

/** Snapshot limits the native side enforces (DANCE-OFF.md §5 upload: frame JPEGs <= 200 KB). */
export const SNAPSHOT_MAX_LONG_SIDE = 512;
export const SNAPSHOT_MAX_BYTES = 200_000;

const STATES: readonly StatusEvent['state'][] = [
  'starting',
  'running',
  'recording',
  'error',
  'no_camera',
];

const HEX64 = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The maxFps the native view will use for a prop value (it clamps the same way). */
export function clampMaxFps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_FPS;
  return Math.min(MAX_MAX_FPS, Math.max(MIN_MAX_FPS, value));
}

/** The joint's [x, y, c] in a raw person, or null when the joint is missing (c = 0). */
export function joint(k: readonly number[], name: JointName): [number, number, number] | null {
  const i = JOINT_ORDER.indexOf(name) * 3;
  const x = k[i];
  const y = k[i + 1];
  const c = k[i + 2];
  if (x === undefined || y === undefined || c === undefined || c <= 0) return null;
  return [x, y, c];
}

/** A raw person's 57 numbers, or null if it is not one. Values are clamped to [0, 1]. */
export function toKeypoints(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== KEYPOINT_COUNT) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (!isNum(v)) return null;
    out.push(clamp01(v));
  }
  return out;
}

/**
 * Validates an onPoses payload (from the native view, or a saved debug session) and returns a
 * clean copy, or null when the frame itself is malformed. Malformed people are dropped.
 */
export function toPoseFrame(raw: unknown): PoseFrameEvent | null {
  if (!isObject(raw)) return null;
  const { t, ts, w, h, fps, people } = raw;
  if (!isNum(t) || !isNum(w) || !isNum(h) || w <= 0 || h <= 0) return null;
  if (!Array.isArray(people)) return null;
  const clean: { k: number[] }[] = [];
  for (const p of people) {
    const k = isObject(p) ? toKeypoints(p.k) : null;
    if (k) clean.push({ k });
  }
  const frame: PoseFrameEvent = { t, w, h, fps: isNum(fps) && fps >= 0 ? fps : 0, people: clean };
  if (isNum(ts)) frame.ts = ts;
  return frame;
}

export function toStatusEvent(raw: unknown): StatusEvent | null {
  if (!isObject(raw)) return null;
  const state = STATES.find((s) => s === raw.state);
  if (!state) return null;
  return typeof raw.message === 'string' ? { state, message: raw.message } : { state };
}

export function emptyStopResult(): StopRoundResult {
  return { clipUri: null, clipSha256: null, snapshots: [] };
}

function toSnapshot(raw: unknown): DanceSnapshot | null {
  if (!isObject(raw)) return null;
  const { t_ms, uri, width, height, bytes, sha256 } = raw;
  if (!isNum(t_ms) || !isNum(width) || !isNum(height) || !isNum(bytes)) return null;
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
  if (Math.max(width, height) > SNAPSHOT_MAX_LONG_SIDE || bytes > SNAPSHOT_MAX_BYTES) return null;
  return { t_ms: Math.round(t_ms), uri, width, height, bytes, sha256 };
}

/**
 * Validates a stopRound result. A clip without a valid hash (or vice versa) is reported as no
 * clip; snapshots that break the limits are dropped, and the rest are sorted by time.
 */
export function toStopRoundResult(raw: unknown): StopRoundResult {
  if (!isObject(raw)) return emptyStopResult();
  const { clipUri, clipSha256 } = raw;
  const snapshots = (Array.isArray(raw.snapshots) ? (raw.snapshots as unknown[]) : [])
    .map(toSnapshot)
    .filter((s): s is DanceSnapshot => s !== null)
    .sort((a, b) => a.t_ms - b.t_ms);
  if (
    typeof clipUri === 'string' &&
    clipUri.startsWith('file://') &&
    typeof clipSha256 === 'string' &&
    HEX64.test(clipSha256)
  ) {
    return { clipUri, clipSha256, snapshots };
  }
  return { clipUri: null, clipSha256: null, snapshots };
}

/** The face still's limits (ios SnapshotEncoder.still*): the whole upright frame. */
export const STILL_MAX_LONG_SIDE = 1280;

/** Validates a captureStill result; anything malformed is `{ok: false}`. */
export function toStillResult(raw: unknown): StillResult {
  if (!isObject(raw) || raw.ok !== true) {
    const message = isObject(raw) && typeof raw.message === 'string' ? raw.message : undefined;
    return message === undefined ? { ok: false } : { ok: false, message };
  }
  const { uri, width, height, ts } = raw;
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return { ok: false };
  if (!isNum(width) || !isNum(height) || !isNum(ts) || width <= 0 || height <= 0)
    return { ok: false };
  if (Math.max(width, height) > STILL_MAX_LONG_SIDE) return { ok: false };
  return { ok: true, uri, width, height, ts };
}
