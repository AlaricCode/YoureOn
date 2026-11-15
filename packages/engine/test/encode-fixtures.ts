/** Shared fixtures for the encode/hash tests (§15 worked examples). */
import bs58 from 'bs58';
import { sha256 } from '../src/hash/sha256.js';
import { utf8 } from '../src/hash/bytes.js';
import type { Calibration, Program, QFrame, TrackBufferData } from '../src/types.js';

export const pk = (seed: string): string => bs58.encode(sha256(utf8(seed)));
export const CREATOR = pk('creator');
export const FRIEND = pk('friend');
export const THIRD = pk('third');

/** §15.1 paper-ball shot. */
export function paperBall(): Program {
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

/** Rules program with a zone and a line region (two regions, out of declaration order in the calibration). */
export function zoneProgram(): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'ball', kind: 'object', phrase: 'ball' },
      { name: 'goal', kind: 'region', shape: 'zone' },
      { name: 'mark', kind: 'region', shape: 'line' },
    ],
    legs: [
      {
        id: 1,
        actor_bound: false,
        attempt_window_frames: 50,
        success: {
          op: 'and',
          args: [
            { op: 'enters', a: { e: 'ball' }, b: { e: 'goal' } },
            { op: 'crosses', a: { e: 'ball' }, b: { e: 'mark' } },
          ],
        },
        rule: { kind: 'exists' },
      },
    ],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 10000,
    time_limit_s: 60,
  };
}

export function zoneCalibration(): Calibration {
  return {
    version: 1,
    scene: { camera: { width_px: 1280, height_px: 720, orientation: 'landscape' }, entity_refs: [] },
    regions: [
      { entity: 'mark', shape: 'line', points: [[0, 5000], [10000, 5000]], behind_sign: -1 },
      { entity: 'goal', shape: 'zone', points: [[0, 0], [10000, 0], [10000, 10000], [0, 10000]] },
    ],
  };
}

export function aiJudged(): Program {
  return {
    version: 2,
    kind: 'ai_judged',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [],
    legs: [],
    question: 'Does the dog fetch the stick?',
    outcome: { if_true: 1, condition: { op: 'yes' }, else: 0 },
    stake_each: 20000,
    time_limit_s: 120,
  };
}

export function marketProgram(): Program {
  return {
    version: 2,
    kind: 'market',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [],
    legs: [
      {
        id: 1,
        actor_bound: false,
        attempt_window_frames: 0,
        market: { venue: 'gemini', event_id: 'EV1', contract_id: 'C1', side: 'yes', prob_bps: 6000 },
      },
      {
        id: 2,
        actor_bound: false,
        attempt_window_frames: 0,
        market: { venue: 'gemini', event_id: 'EV2', contract_id: 'C9', side: 'no', prob_bps: 3000 },
      },
    ],
    outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, else: 1 },
    stakes: [600000, 400000],
    time_limit_s: 86400,
  };
}

export const MODEL_HASH = 'ab'.repeat(32);

export function rec(over: Partial<QFrame> = {}): QFrame {
  return { x0: 100, y0: 200, x1: 300, y1: 400, conf: 90, fill: 50, id_conf: 0, pose: 0, ...over };
}

/** Track buffer for the paper-ball program: tracks shooter(0, p1), ball(1), can(2). */
export function paperBallTracks(): TrackBufferData {
  const row = (f: number): (QFrame | null)[] => [
    rec({ id_conf: 80, pose: 1, x0: f }),
    f % 3 === 0 ? null : rec({ x0: 10 + f }),
    rec({ conf: 100, fill: 100 }),
  ];
  return {
    flags: 0b10,
    model_hash: MODEL_HASH,
    tracks: [
      { entity_idx: 0, participant_idx: 1, ref_h: 3000 },
      { entity_idx: 1, participant_idx: null, ref_h: 0 },
      { entity_idx: 2, participant_idx: null, ref_h: 1200 },
    ],
    segments: [
      { frame_start: 0, frames: [0, 1, 2, 3].map(row) },
      { frame_start: 40, frames: [40, 41].map(row) },
    ],
  };
}
