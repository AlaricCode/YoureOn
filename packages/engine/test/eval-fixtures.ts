/**
 * Shared fixtures for the eval*.test.ts suites (not a test file itself).
 */
import bs58 from 'bs58';
import type {
  Calibration,
  DecodedRegion,
  EntityKindCode,
  Program,
  QFrame,
  TrackBufferData,
  TrackSegment,
} from '../src/types.js';
import { buildCtx, type EvalCtx } from '../src/eval/frames.js';

export const CREATOR = bs58.encode(new Uint8Array(32).fill(1));
export const FRIEND = bs58.encode(new Uint8Array(32).fill(2));
export const THIRD = bs58.encode(new Uint8Array(32).fill(3));

/** A present record. */
export function q(x0: number, y0: number, x1: number, y1: number, extra: Partial<QFrame> = {}): QFrame {
  return { x0, y0, x1, y1, conf: 90, fill: 0, id_conf: 0, pose: 0, ...extra };
}

/** A record centered at (cx, cy) with half-size h. */
export function at(cx: number, cy: number, h = 50, extra: Partial<QFrame> = {}): QFrame {
  return q(cx - h, cy - h, cx + h, cy + h, extra);
}

export type Col = (QFrame | null)[];

/**
 * Build a context. `cols[t]` is the column (over all positions in F order) of
 * track t, which belongs to entity `trackEntities[t]`. `segs` lists
 * `[frame_start, n_frames]`.
 */
export function mkCtx(opts: {
  entities: EntityKindCode[];
  params?: number[];
  regions?: DecodedRegion[];
  trackEntities: number[];
  refH?: number[];
  cols: Col[];
  segs?: [number, number][];
  timeLimitS?: number;
}): EvalCtx {
  const n = Math.max(0, ...opts.cols.map((c) => c.length));
  const segs = opts.segs ?? [[0, n]];
  const segments: TrackSegment[] = [];
  let pos = 0;
  for (const [start, len] of segs) {
    const frames: (QFrame | null)[][] = [];
    for (let i = 0; i < len; i++, pos++) frames.push(opts.cols.map((c) => c[pos] ?? null));
    segments.push({ frame_start: start, frames });
  }
  return buildCtx(
    opts.entities.map((kind, i) => ({ kind, param: opts.params?.[i] ?? 0 })),
    opts.regions ?? [],
    opts.trackEntities.map((entity_idx, i) => ({ entity_idx, ref_h: opts.refH?.[i] ?? 0 })),
    segments,
    opts.timeLimitS ?? 3600,
  );
}

export function bits(sig: Uint8Array): string {
  return Array.from(sig).join('');
}

export function fromBits(s: string): Uint8Array {
  return Uint8Array.from(s.split('').map((c) => (c === '1' ? 1 : 0)));
}

/** Paper-ball shot program (§15.1). */
export function paperBallProgram(): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'shooter', kind: 'person', participant: 1 },
      { name: 'ball', kind: 'object', phrase: 'crumpled paper ball' },
      { name: 'can', kind: 'object', phrase: 'trash can' },
      { name: 'line', kind: 'region', shape: 'line' },
    ],
    legs: [
      {
        id: 1,
        actor_bound: true,
        attempt_window_frames: 50,
        valid_attempt: {
          op: 'and',
          args: [
            { op: 'released_by', a: { e: 'ball' }, b: { e: 'shooter' } },
            { op: 'behind', a: { e: 'shooter' }, b: { e: 'line' } },
          ],
        },
        success: {
          op: 'or',
          args: [
            { op: 'disappears_into', a: { e: 'ball' }, b: { e: 'can', sub: 'opening' } },
            {
              op: 'and',
              args: [
                { op: 'inside', a: { e: 'ball' }, b: { e: 'can' } },
                { op: 'at_rest', a: { e: 'ball' }, frames: 10 },
              ],
            },
          ],
        },
        rule: { kind: 'count', cmp: '>=', k: 1, attempts: 3 },
      },
    ],
    outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
    stake_each: 5000000,
    time_limit_s: 180,
  };
}

export function paperBallCalibration(): Calibration {
  return {
    version: 1,
    scene: {
      camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' },
      entity_refs: [
        { entity: 'ball', label: 'Paper ball', bbox: [1200, 7000, 1500, 7500] },
        { entity: 'can', label: 'Trash can', bbox: [7600, 6200, 8800, 9400] },
        { entity: 'shooter', label: 'Maya', bbox: [500, 1500, 2500, 9800] },
      ],
    },
    regions: [{ entity: 'line', shape: 'line', points: [[3000, 6000], [3000, 10000]], behind_sign: 1 }],
  };
}

export const CAN_BOX = q(7600, 6200, 8800, 9400);

/**
 * Per-frame scene for one paper-ball throw:
 * shooter stands at x≈1000 (behind the line) the whole time, holds the ball
 * for frames [t, t+3), releases at t+3, ball flies to the can rim, drops in
 * and disappears. Returns columns [shooter, ball, can] of length n.
 */
export function paperBallScene(n: number, throws: { t: number; make: boolean }[], shooterIdConf = 90): Col[] {
  const shooter: Col = [];
  const ball: Col = [];
  const can: Col = [];
  for (let f = 0; f < n; f++) {
    shooter.push(q(500, 3000, 1500, 9000, { id_conf: shooterIdConf, pose: 1 }));
    can.push(CAN_BOX);
    ball.push(null);
  }
  for (const { t, make } of throws) {
    // held: ball center inside the shooter's box
    for (let f = t; f < t + 3 && f < n; f++) ball[f] = at(1000, 5000, 100);
    if (make) {
      // flight towards the can (ball clearly outside the expanded shooter box)
      const path: [number, number][] = [
        [3000, 4000],
        [5000, 3500],
        [7000, 4500],
        [8200, 5800],
        [8200, 6300],
      ];
      path.forEach(([x, y], i) => {
        if (t + 3 + i < n) ball[t + 3 + i] = at(x, y, 100);
      });
      // then gone (inside the can) for 12+ frames
    } else {
      const path: [number, number][] = [
        [3000, 4000],
        [5000, 3500],
        [6500, 6000],
        [6500, 9000],
      ];
      path.forEach(([x, y], i) => {
        if (t + 3 + i < n) ball[t + 3 + i] = at(x, y, 100);
      });
      for (let f = t + 7; f < t + 20 && f < n; f++) ball[f] = at(6500, 9000, 100);
    }
  }
  return [shooter, ball, can];
}

/** TrackBufferData for the paper-ball program from columns (one or more segments). */
export function paperBallBuffer(cols: Col[], segs?: [number, number][], flags = 0b10): TrackBufferData {
  const n = cols[0]!.length;
  const s = segs ?? [[0, n]];
  const segments: TrackSegment[] = s.map(([start, len]) => {
    const frames: (QFrame | null)[][] = [];
    for (let f = start; f < start + len; f++) frames.push(cols.map((c) => c[f] ?? null));
    return { frame_start: start, frames };
  });
  return {
    flags,
    model_hash: '00'.repeat(32),
    tracks: [
      { entity_idx: 0, participant_idx: 1, ref_h: 6000 },
      { entity_idx: 1, participant_idx: null, ref_h: 200 },
      { entity_idx: 2, participant_idx: null, ref_h: 3200 },
    ],
    segments,
  };
}
