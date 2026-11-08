/**
 * Worked examples (§15.1–§15.3) as canonical ASTs + calibrations, for the
 * perception tests.
 */
import bs58 from 'bs58';
import type { Calibration, Program } from '../src/types.js';

export const CREATOR = bs58.encode(new Uint8Array(32).fill(1));
export const FRIEND = bs58.encode(new Uint8Array(32).fill(2));

export function paperBall(attempts = 3): Program {
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
        rule: { kind: 'count', cmp: '>=', k: 1, attempts },
      },
    ],
    outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
    stake_each: 5000000,
    time_limit_s: 180,
  };
}

export const paperBallCalibration: Calibration = {
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

export function cupTower(): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'tower', kind: 'object', phrase: 'cup tower' },
      { name: 'fan', kind: 'object', phrase: 'fan' },
    ],
    legs: [
      {
        id: 1,
        actor_bound: false,
        attempt_window_frames: 50,
        success: { op: 'intact', a: { e: 'tower' } },
        rule: { kind: 'holds', frames: 100 },
      },
    ],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 2000000,
    time_limit_s: 30,
  };
}

export const cupTowerCalibration: Calibration = {
  version: 1,
  scene: {
    camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' },
    entity_refs: [
      { entity: 'tower', label: 'Cup tower', bbox: [4000, 3000, 5500, 9000] },
      { entity: 'fan', label: 'Fan', bbox: [7000, 5000, 9000, 9000] },
    ],
  },
  regions: [],
};

export function pushUps(target = 20, deadlineFrames = 600, timeLimitS = 90): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [{ name: 'me', kind: 'person', participant: 0 }],
    legs: [
      {
        id: 1,
        actor_bound: true,
        attempt_window_frames: 50,
        success: { op: 'rep_count', a: { e: 'me' }, cmp: '>=', value: target },
        rule: { kind: 'before', frames: deadlineFrames },
      },
    ],
    outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
    stake_each: 10000000,
    time_limit_s: timeLimitS,
  };
}

export const pushUpsCalibration: Calibration = {
  version: 1,
  scene: {
    camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' },
    entity_refs: [{ entity: 'me', label: 'Sam', bbox: [2000, 6000, 8000, 9000] }],
  },
  regions: [],
};

export const EXAMPLES = [
  { name: 'paper_ball', program: paperBall(), calibration: paperBallCalibration },
  { name: 'cup_tower', program: cupTower(), calibration: cupTowerCalibration },
  { name: 'push_ups', program: pushUps(), calibration: pushUpsCalibration },
] as const;
