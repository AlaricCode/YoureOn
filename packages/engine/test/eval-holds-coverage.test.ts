/**
 * holds(D) without full coverage (§3.7, §3.8, §3.9): the raw value is False
 * (a missing frame counts as "not satisfied"), so an actor-bound holds leg
 * yields no checkpoint; the leg is Unknown (COVERAGE). Matches
 * crates/verdict-rules (CONTRACTS-ERRATA "[verdict-rules] 4").
 */
import { describe, expect, it } from 'vitest';
import { evaluateProgram } from '../src/eval/index.js';
import type { Calibration, Program, QFrame, TrackBufferData } from '../src/types.js';
import { CREATOR, FRIEND } from './eval-fixtures.js';

const program: Program = {
  version: 2,
  kind: 'rules',
  participants: [CREATOR, FRIEND],
  sides: [0, 1],
  entities: [{ name: 'me', kind: 'person', participant: 0 }],
  legs: [{ id: 1, actor_bound: true, attempt_window_frames: 50, success: { op: 'standing', a: { e: 'me' } }, rule: { kind: 'holds', frames: 20 } }],
  outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
  stake_each: 1_000_000,
  time_limit_s: 10,
};
const CAL: Calibration = { version: 1, scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs: [] }, regions: [] };
const standing: QFrame = { x0: 1000, y0: 1000, x1: 3000, y1: 9000, conf: 90, fill: 0, id_conf: 90, pose: 1 };

function buf(segs: [number, number][]): TrackBufferData {
  return {
    flags: 2,
    model_hash: '00'.repeat(32),
    tracks: [{ entity_idx: 0, participant_idx: 0, ref_h: 8000 }],
    segments: segs.map(([frame_start, n]) => ({ frame_start, frames: Array.from({ length: n }, () => [{ ...standing }]) })),
  };
}

describe('actor-bound holds and coverage', () => {
  it('full coverage: True with the checkpoint (0, D-1)', () => {
    const r = evaluateProgram(program, CAL, buf([[0, 20]]), [{ participant: 0, frame: 19 }]);
    expect(r).toMatchObject({ status: 'ok', leg_results: [1], checkpoints: [{ participant: 0, frame: 19 }], n_checkpoints: 1 });
  });

  it('a gap inside [0, D): Unknown (COVERAGE), raw False ⇒ no checkpoint, no decisive frame', () => {
    for (const segs of [[[0, 10], [12, 8]], [[0, 15]], [[3, 17]]] as [number, number][][]) {
      const r = evaluateProgram(program, CAL, buf(segs), [{ participant: 0, frame: 19 }]);
      expect(r).toMatchObject({ status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['COVERAGE']], checkpoints: [], n_checkpoints: 0 });
      expect(r.decisive_frames).toEqual([[]]);
    }
  });

  it('a gap and a failing frame: COVERAGE wins over OCCLUSION; the failing frame is decisive', () => {
    const b = buf([[0, 10], [12, 8]]);
    b.segments[1]!.frames[2] = [{ ...standing, pose: 0 }]; // frame 14 not standing
    const r = evaluateProgram(program, CAL, b, []);
    expect(r).toMatchObject({ leg_results: [2], leg_causes: [['COVERAGE']], decisive_frames: [[14]], n_checkpoints: 0 });
  });
});
