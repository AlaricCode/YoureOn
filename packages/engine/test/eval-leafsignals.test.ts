import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATOR, FRIEND, paperBallCalibration, paperBallProgram, paperBallScene, q } from './eval-fixtures.js';
import { leafSignals, evaluateProgram } from '../src/eval/index.js';
import type { Calibration, Program, SessionTracks, TrackBufferData } from '../src/types.js';

function session(cols: ReturnType<typeof paperBallScene>): SessionTracks {
  const n = cols[0]!.length;
  return {
    fps: 10,
    n_frames: n,
    model_hash: '00'.repeat(32),
    flags: 0b10,
    tracks: [
      { entity: 'shooter', entity_idx: 0, participant_idx: 1, ref_h: 6000, frames: cols[0]! },
      { entity: 'ball', entity_idx: 1, participant_idx: null, ref_h: 200, frames: cols[1]! },
      { entity: 'can', entity_idx: 2, participant_idx: null, ref_h: 3200, frames: cols[2]! },
    ],
  };
}

describe('leafSignals', () => {
  const p = paperBallProgram();
  const c = paperBallCalibration();

  it('one row per leaf with path, label and signal', () => {
    const rows = leafSignals(p, c, session(paperBallScene(30, [{ t: 0, make: true }])));
    expect(rows.map((r) => [r.leg, r.field, r.path, r.label])).toEqual([
      [1, 'valid_attempt', '0', 'Paper ball released'],
      [1, 'valid_attempt', '1', 'Behind line'],
      [1, 'success', '0', 'Into Trash can'],
      [1, 'success', '1.0', 'In Trash can'],
      [1, 'success', '1.1', 'Paper ball still'],
    ]);
    const released = rows[0]!.signal;
    expect(released).toHaveLength(30);
    expect(released.indexOf(true)).toBe(3);
    expect(rows[1]!.signal.every(Boolean)).toBe(true);
    expect(rows[2]!.signal.indexOf(true)).toBe(7);
  });

  it('labels over 3 words fall back to the label\'s last word', () => {
    const c2: Calibration = { ...c, scene: { ...c.scene, entity_refs: [{ entity: 'can', label: 'Big Trash Can', bbox: [0, 0, 1, 1] }] } };
    const rows = leafSignals(p, c2, session(paperBallScene(5, [])));
    expect(rows.find((r) => r.path === '1.0')!.label).toBe('In Can');
  });

  it('structurally equal atoms share a row (first path wins)', () => {
    const p2: Program = {
      ...p,
      legs: [{ ...p.legs[0]!, success: { op: 'or', args: [{ op: 'inside', a: { e: 'ball' }, b: { e: 'can' } }, { op: 'not', arg: { op: 'inside', a: { e: 'ball' }, b: { e: 'can' } } }] } }],
    };
    const rows = leafSignals(p2, c, session(paperBallScene(5, [])));
    expect(rows.filter((r) => r.field === 'success').map((r) => r.path)).toEqual(['0']);
  });

  it('unplaced regions give all-false signals', () => {
    const rows = leafSignals(p, null, session(paperBallScene(10, [])));
    expect(rows.find((r) => r.label === 'Behind line')!.signal.some(Boolean)).toBe(false);
  });

  it('a root leaf has the empty path', () => {
    const p3: Program = {
      version: 2,
      kind: 'rules',
      participants: [CREATOR, FRIEND],
      sides: [0, 1],
      entities: [{ name: 'tower', kind: 'object', phrase: 'cup tower' }],
      legs: [{ id: 1, actor_bound: false, attempt_window_frames: 50, success: { op: 'intact', a: { e: 'tower' } }, rule: { kind: 'holds', frames: 10 } }],
      outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
      stake_each: 10000,
      time_limit_s: 30,
    };
    const s: SessionTracks = {
      fps: 10,
      n_frames: 3,
      model_hash: '00'.repeat(32),
      flags: 2,
      tracks: [{ entity: 'tower', entity_idx: 0, participant_idx: null, ref_h: 100, frames: [q(0, 0, 10, 100), q(0, 0, 10, 50), null] }],
    };
    expect(leafSignals(p3, null, s)).toEqual([{ leg: 1, field: 'success', path: '', label: 'cup tower standing', signal: [true, false, false] }]);
  });
});

describe('combinators through program_bin', () => {
  const CAL: Calibration = { version: 1, scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs: [] }, regions: [] };
  const BOX = q(1000, 1000, 2000, 2000);
  function prog(success: Program['legs'][0]['success']): Program {
    return {
      version: 2,
      kind: 'rules',
      participants: [CREATOR, FRIEND],
      sides: [0, 1],
      entities: [
        { name: 'a', kind: 'object', phrase: 'a' },
        { name: 'b', kind: 'object', phrase: 'b' },
      ],
      legs: [{ id: 1, actor_bound: false, attempt_window_frames: 50, success, rule: { kind: 'exists' } }],
      outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
      stake_each: 10000,
      time_limit_s: 60,
    };
  }
  function buf(a: string, b: string): TrackBufferData {
    return {
      flags: 2,
      model_hash: '00'.repeat(32),
      tracks: [
        { entity_idx: 0, participant_idx: null, ref_h: 0 },
        { entity_idx: 1, participant_idx: null, ref_h: 0 },
      ],
      segments: [{ frame_start: 0, frames: a.split('').map((x, i) => [x === '1' ? BOX : null, b[i] === '1' ? BOX : null]) }],
    };
  }
  const pa = { op: 'present' as const, a: { e: 'a' } };
  const pb = { op: 'present' as const, a: { e: 'b' } };

  it('then_within', () => {
    const p = prog({ op: 'then_within', frames: 2, first: pa, then: pb });
    expect(evaluateProgram(p, CAL, buf('1000', '0001'), []).leg_results).toEqual([0]);
    expect(evaluateProgram(p, CAL, buf('1000', '0010'), [])).toMatchObject({ leg_results: [1], decisive_frames: [[2]] });
  });

  it('for_duration and before', () => {
    const fd = prog({ op: 'and', args: [{ op: 'for_duration', frames: 3, arg: pa }, { op: 'not', arg: pb }] });
    expect(evaluateProgram(fd, CAL, buf('110110', '000000'), []).leg_results).toEqual([0]);
    expect(evaluateProgram(fd, CAL, buf('111000', '000000'), [])).toMatchObject({ leg_results: [1], decisive_frames: [[2]] });
    const bf = prog({ op: 'and', args: [{ op: 'before', frames: 3, arg: pa }, pb] });
    expect(evaluateProgram(bf, CAL, buf('111111', '000111'), []).leg_results).toEqual([0]);
    expect(evaluateProgram(bf, CAL, buf('111111', '001111'), []).leg_results).toEqual([1]);
  });

  it('not over an absent primitive is true (§2.5.2)', () => {
    const p = prog({ op: 'and', args: [pb, { op: 'not', arg: pa }] });
    expect(evaluateProgram(p, CAL, buf('0', '1'), []).leg_results).toEqual([1]);
  });
});

describe('integer-only source (§0.4)', () => {
  it('src/eval uses no float math or bare division', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/eval');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/Math\.(sqrt|round|floor|ceil|pow|trunc)/);
      const divisions = src.split('\n').filter((l) => / \/=? /.test(l) && !l.includes('eslint-disable'));
      // the only division is inside idiv (math.ts), on an exact multiple
      expect(divisions.length, `${f}: ${divisions.join(' | ')}`).toBe(f === 'math.ts' ? 1 : 0);
    }
  });
});
