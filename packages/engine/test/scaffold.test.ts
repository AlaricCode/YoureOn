import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.js';
import {
  BET_ACCOUNT_BYTES,
  CONSTANTS,
  ERROR_CODES,
  ERROR_CODE_BASE,
  EVENT_NAMES,
  INSTRUCTION_NAMES,
  LEAF_CODE,
  MAX_BUFFER_PAYLOAD,
  RESERVED_WORDS,
  TRACK_BUFFER_HEADER_BYTES,
  ANCHOR_DISCRIMINATOR_BYTES,
  MAX_ACCOUNT_DATA_BYTES,
  BEACON_PREAMBLE,
  BEACON_SYMBOLS,
  BEACON_PAYLOAD_BYTES,
  BEACON_SYMBOL_SAMPLES,
  BEACON_SAMPLE_RATE,
  BEACON_SYMBOL_MS,
  ED25519_PANEL_IX_BYTES,
  PANEL_MESSAGE_BYTES,
  TAG_PANEL,
  TAIL_FRAMES,
  TAIL_MS,
  FPS,
  ENTITY_NAME_RE,
  PERSON_ENTITY_RE,
  OBJECT_PHRASE_RE,
  CITATION_RE,
  SP1_PUBLIC_VALUES_BYTES,
} from '../src/constants.js';
import type {
  BetAccount,
  Calibration,
  ErrorCode,
  EvalResult,
  Program,
  TrackBufferData,
  VerdictEvent,
} from '../src/types.js';

/** §15.1 paper-ball program, typed against the AST (compile-time check). */
const paperBall: Program = {
  version: 2,
  kind: 'rules',
  participants: ['11111111111111111111111111111112', '11111111111111111111111111111113'],
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

const paperBallCalibration: Calibration = {
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

describe('engine scaffold', () => {
  it('exposes CONSTANTS through the public entry point', () => {
    expect(engine.CONSTANTS).toBe(CONSTANTS);
    expect(engine.CONSTANTS.FPS).toBe(10);
    expect(Object.keys(CONSTANTS)).toHaveLength(84);
  });

  it('keeps §0.5 invariants', () => {
    expect(ANCHOR_DISCRIMINATOR_BYTES + TRACK_BUFFER_HEADER_BYTES + MAX_BUFFER_PAYLOAD).toBeLessThanOrEqual(
      MAX_ACCOUNT_DATA_BYTES,
    );
    expect(TAIL_FRAMES).toBe((TAIL_MS * FPS) / 1000);
    expect(CONSTANTS.REBIND_DELAY_FRAMES).toBeGreaterThan(CONSTANTS.DISAPPEAR_FRAMES);
    expect(BET_ACCOUNT_BYTES).toBe(1580);
  });

  it('numbers §9.6 errors from 6000 in order', () => {
    expect(ERROR_CODES).toHaveLength(45);
    expect(ERROR_CODE_BASE + ERROR_CODES.indexOf('InvalidState')).toBe(6000);
    expect(ERROR_CODE_BASE + ERROR_CODES.indexOf('MalformedProgram')).toBe(6023);
    expect(ERROR_CODE_BASE + ERROR_CODES.indexOf('MalformedTracks')).toBe(6025);
    expect(ERROR_CODE_BASE + ERROR_CODES.indexOf('BadFlags')).toBe(6044);
    const e: ErrorCode = 'MalformedCalibration';
    expect(ERROR_CODES).toContain(e);
  });

  it('lists 15 instructions and 14 events', () => {
    expect(INSTRUCTION_NAMES).toHaveLength(15);
    expect(EVENT_NAMES).toHaveLength(14);
  });

  it('has unique leaf codes and the §2.5.4 reserved list', () => {
    const codes = Object.values(LEAF_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(21);
    expect(RESERVED_WORDS).toHaveLength(56);
    expect(new Set(RESERVED_WORDS).size).toBe(RESERVED_WORDS.length);
  });

  it('matches beacon and panel layout sizes', () => {
    expect(BEACON_PREAMBLE.length + BEACON_PAYLOAD_BYTES * 2).toBe(BEACON_SYMBOLS);
    expect((BEACON_SAMPLE_RATE * BEACON_SYMBOL_MS) / 1000).toBe(BEACON_SYMBOL_SAMPLES);
    expect(TAG_PANEL.length + 32 + 32 + 1 + 32 + 32).toBe(PANEL_MESSAGE_BYTES);
    expect(222 + PANEL_MESSAGE_BYTES).toBe(ED25519_PANEL_IX_BYTES);
    expect(SP1_PUBLIC_VALUES_BYTES).toBe(171);
  });

  it('compiles the lexical patterns', () => {
    expect(ENTITY_NAME_RE.test('shooter')).toBe(true);
    expect(ENTITY_NAME_RE.test('Shooter')).toBe(false);
    expect(PERSON_ENTITY_RE.exec('person(p1)')?.[1]).toBe('p1');
    expect(PERSON_ENTITY_RE.test('person("Maya")')).toBe(true);
    expect(OBJECT_PHRASE_RE.test('crumpled paper ball')).toBe(true);
    expect(CITATION_RE.test('cam1@12.4s')).toBe(true);
    expect(CITATION_RE.test('cam9@12.4s')).toBe(false);
  });

  it('types the worked example, calibration and results', () => {
    expect(paperBall.legs[0]?.rule).toEqual({ kind: 'count', cmp: '>=', k: 1, attempts: 3 });
    expect(paperBallCalibration.regions[0]?.shape).toBe('line');
    const buffer: TrackBufferData = {
      flags: 0b10,
      model_hash: '00'.repeat(32),
      tracks: [{ entity_idx: 0, participant_idx: 1, ref_h: 8300 }],
      segments: [{ frame_start: 0, frames: [[null]] }],
    };
    expect(buffer.segments[0]?.frames).toHaveLength(1);
    const result: EvalResult = {
      status: 'ok',
      reason: 0,
      preruling: 1,
      winner_mask: 2,
      leg_results: [1],
      leg_causes: [[]],
      decisive_frames: [[41, 58]],
      attempts: [{ leg: 0, frame: 41, success_frame: 58 }],
      checkpoints: [{ participant: 1, frame: 41 }],
      n_checkpoints: 1,
      cost: 0,
    };
    expect(result.winner_mask).toBe(2);
    const ev: VerdictEvent = { name: 'BetCancelled', data: { bet: paperBall.participants[0]! } };
    expect(ev.name).toBe('BetCancelled');
    const partial: Pick<BetAccount, 'state' | 'stake_each'> = { state: 0, stake_each: 5_000_000n };
    expect(partial.stake_each).toBe(5_000_000n);
  });
});
