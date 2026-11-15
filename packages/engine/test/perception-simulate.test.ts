import { describe, expect, it } from 'vitest';
import { MOCK_MODEL_HASH, simulate, simulatePipeline } from '../src/perception/index.js';
import { recognize } from '../src/perception/simulate/templates.js';
import { Prng } from '../src/perception/simulate/prng.js';
import { MOCK_SCENARIOS } from '../src/constants.js';
import type { Calibration, LegCause, MockScenario, Program } from '../src/types.js';
import { EXAMPLES, cupTower, cupTowerCalibration, paperBall, paperBallCalibration, pushUps, pushUpsCalibration } from './perception-fixtures.js';

interface Expect {
  cross: boolean;
  reason: 0 | 10 | 12 | 13;
  legs: (0 | 1 | 2)[];
  causes: LegCause[][];
  winner: number;
  window_unavailable?: boolean;
}

// Winner masks: paper ball if_true = side 1 (friend, mask 2), else creator (mask 1);
// cup tower / push-ups if_true = side 0 (mask 1), else mask 2.
const TABLE: Record<string, Record<MockScenario, Expect>> = {
  paper_ball: {
    pass: { cross: true, reason: 0, legs: [1], causes: [[]], winner: 2 },
    fail: { cross: true, reason: 0, legs: [0], causes: [[]], winner: 1 },
    cross_fail: { cross: false, reason: 12, legs: [2], causes: [[]], winner: 0 },
    motion: { cross: true, reason: 10, legs: [2], causes: [['MOTION']], winner: 0 },
    low_conf: { cross: true, reason: 10, legs: [2], causes: [['CONF']], winner: 0 },
    no_identity: { cross: true, reason: 10, legs: [2], causes: [['IDENTITY']], winner: 0 },
    oversize: { cross: true, reason: 13, legs: [2], causes: [[]], winner: 0, window_unavailable: true },
    occlusion: { cross: true, reason: 0, legs: [1], causes: [[]], winner: 2 },
  },
  cup_tower: {
    pass: { cross: true, reason: 0, legs: [1], causes: [[]], winner: 1 },
    fail: { cross: true, reason: 0, legs: [0], causes: [[]], winner: 2 },
    cross_fail: { cross: false, reason: 12, legs: [2], causes: [[]], winner: 0 },
    motion: { cross: true, reason: 10, legs: [2], causes: [['MOTION']], winner: 0 },
    low_conf: { cross: true, reason: 10, legs: [2], causes: [['CONF']], winner: 0 },
    no_identity: { cross: true, reason: 0, legs: [1], causes: [[]], winner: 1 },
    oversize: { cross: true, reason: 13, legs: [2], causes: [[]], winner: 0, window_unavailable: true },
    occlusion: { cross: true, reason: 10, legs: [2], causes: [['OCCLUSION']], winner: 0 },
  },
  push_ups: {
    pass: { cross: true, reason: 0, legs: [1], causes: [[]], winner: 1 },
    fail: { cross: true, reason: 0, legs: [0], causes: [[]], winner: 2 },
    cross_fail: { cross: false, reason: 12, legs: [2], causes: [[]], winner: 0 },
    motion: { cross: true, reason: 10, legs: [2], causes: [['MOTION']], winner: 0 },
    low_conf: { cross: true, reason: 10, legs: [2], causes: [['CONF']], winner: 0 },
    no_identity: { cross: true, reason: 10, legs: [2], causes: [['IDENTITY']], winner: 0 },
    oversize: { cross: true, reason: 13, legs: [2], causes: [[]], winner: 0, window_unavailable: true },
    occlusion: { cross: true, reason: 0, legs: [1], causes: [[]], winner: 1 },
  },
};

function expectScenario(p: Program, c: Calibration, sc: MockScenario, seed: number, e: Expect): void {
  const r = simulatePipeline(p, c, sc, seed);
  expect(r.cross.ok).toBe(e.cross);
  expect(r.result.reason).toBe(e.reason);
  expect(r.result.status).toBe(e.reason === 0 ? 'ok' : 'needs_panel');
  expect(r.result.leg_results).toEqual(e.legs);
  expect(r.result.leg_causes).toEqual(e.causes);
  expect(r.result.winner_mask).toBe(e.winner);
  expect(r.window_unavailable).toBe(e.window_unavailable ?? false);
}

describe('simulate: every MOCK_SCENARIO × the three worked examples (§13)', () => {
  it('covers exactly the contract scenarios', () => {
    expect([...MOCK_SCENARIOS].sort()).toEqual(Object.keys(TABLE.paper_ball!).sort());
  });
  for (const ex of EXAMPLES) {
    for (const sc of MOCK_SCENARIOS) {
      it(`${ex.name} / ${sc}`, () => {
        for (const seed of [0, 1, 2, 3, 4, 99, 12345]) expectScenario(ex.program, ex.calibration, sc, seed, TABLE[ex.name]![sc]);
      });
    }
  }

  it('pass results carry the identity checkpoint of §15.1 / §15.3', () => {
    const pb = simulatePipeline(paperBall(), paperBallCalibration, 'pass', 1).result;
    expect(pb.checkpoints).toHaveLength(1);
    expect(pb.checkpoints[0]!.participant).toBe(1);
    expect(pb.checkpoints[0]!.frame).toBe(pb.attempts.find((a) => a.success_frame !== null)!.frame);
    const pu = simulatePipeline(pushUps(), pushUpsCalibration, 'pass', 1).result;
    expect(pu.checkpoints).toEqual([{ participant: 0, frame: pu.decisive_frames[0]![0]! }]);
    expect(simulatePipeline(cupTower(), cupTowerCalibration, 'pass', 1).result.checkpoints).toEqual([]);
  });

  it('the fail variant of §15.1 uses every attempt', () => {
    const r = simulatePipeline(paperBall(), paperBallCalibration, 'fail', 1).result;
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts.every((a) => a.success_frame === null)).toBe(true);
  });
});

describe('simulate: compiler variants of the templates', () => {
  it('paper ball with 1 and 5 attempts', () => {
    for (const n of [1, 5]) {
      expectScenario(paperBall(n), paperBallCalibration, 'pass', 1, TABLE.paper_ball!.pass);
      expectScenario(paperBall(n), paperBallCalibration, 'fail', 1, TABLE.paper_ball!.fail);
    }
  });
  it('push-ups: 10 in 30 s (limit 60 s) and 20 with `>`', () => {
    expectScenario(pushUps(10, 300, 60), pushUpsCalibration, 'pass', 1, TABLE.push_ups!.pass);
    expectScenario(pushUps(10, 300, 60), pushUpsCalibration, 'fail', 1, TABLE.push_ups!.fail);
    const gt = pushUps(20);
    gt.legs[0]!.success = { op: 'rep_count', a: { e: 'me' }, cmp: '>', value: 20 };
    expectScenario(gt, pushUpsCalibration, 'pass', 1, TABLE.push_ups!.pass);
  });
  it('works without calibration bboxes (fallback layout) for the holds template', () => {
    const c: Calibration = { ...cupTowerCalibration, scene: { ...cupTowerCalibration.scene, entity_refs: [] } };
    expectScenario(cupTower(), c, 'pass', 1, TABLE.cup_tower!.pass);
    expectScenario(cupTower(), c, 'fail', 1, TABLE.cup_tower!.fail);
  });
  it('throws when the time limit cannot hold the scene', () => {
    expect(() => simulate({ ...paperBall(), time_limit_s: 3 }, paperBallCalibration, 'pass', 1)).toThrow(/too short/);
    expect(() => simulate(pushUps(20, 30, 3), pushUpsCalibration, 'pass', 1)).toThrow(/cannot fit/);
  });
  it('rejects unknown scenarios', () => {
    expect(() => simulate(cupTower(), cupTowerCalibration, 'nope' as MockScenario, 1)).toThrow(/unknown scenario/);
  });
});

describe('simulate: output shape and determinism', () => {
  it('template recognition', () => {
    expect(recognize(paperBall())).toMatchObject({ kind: 'throw', ball: 'ball', actor: 'shooter', container: 'can', line: 'line', attempts: 3, need: 1 });
    expect(recognize(cupTower())).toMatchObject({ kind: 'holds', object: 'tower', frames: 100 });
    expect(recognize(pushUps())).toMatchObject({ kind: 'reps', person: 'me', target: 20, deadline: 600 });
  });

  it('same seed ⇒ identical sessions; host B differs from A by at most 1 px per coordinate', () => {
    for (const ex of EXAMPLES) {
      const x = simulate(ex.program, ex.calibration, 'pass', 42);
      const y = simulate(ex.program, ex.calibration, 'pass', 42);
      expect(JSON.stringify(x)).toBe(JSON.stringify(y));
      const ux = Math.floor(10000 / ex.calibration.scene.camera.width_px);
      const uy = Math.floor(10000 / ex.calibration.scene.camera.height_px);
      let changed = 0;
      x.a.tracks.forEach((t, i) => {
        t.frames.forEach((r, f) => {
          const s = x.b.tracks[i]!.frames[f];
          expect(r === null).toBe(s === null);
          if (!r || !s) return;
          expect(Math.abs(r.x0 - s.x0)).toBeLessThanOrEqual(ux);
          expect(Math.abs(r.x1 - s.x1)).toBeLessThanOrEqual(ux);
          expect(Math.abs(r.y0 - s.y0)).toBeLessThanOrEqual(uy);
          expect(Math.abs(r.y1 - s.y1)).toBeLessThanOrEqual(uy);
          expect({ ...s, x0: 0, x1: 0, y0: 0, y1: 0 }).toEqual({ ...r, x0: 0, x1: 0, y0: 0, y1: 0 });
          if (r.x0 !== s.x0 || r.y1 !== s.y1) changed++;
        });
      });
      expect(changed).toBeGreaterThan(0);
      const z = simulate(ex.program, ex.calibration, 'pass', 43);
      expect(JSON.stringify(z.b)).not.toBe(JSON.stringify(x.b));
    }
  });

  it('sessions cover every non-region entity in entity order, within LIMIT + TAIL_FRAMES, valid records', () => {
    for (const ex of EXAMPLES) {
      for (const sc of MOCK_SCENARIOS) {
        const { a, b } = simulate(ex.program, ex.calibration, sc, 5);
        for (const s of [a, b]) {
          expect(s.fps).toBe(10);
          expect(s.model_hash).toBe(MOCK_MODEL_HASH);
          const names = ex.program.entities.filter((e) => e.kind !== 'region').map((e) => e.name);
          expect(s.tracks.map((t) => t.entity)).toEqual(names);
          expect(s.n_frames).toBeLessThanOrEqual(ex.program.time_limit_s * 10 + 20);
          for (const t of s.tracks) {
            expect(t.frames).toHaveLength(s.n_frames);
            const ent = ex.program.entities[t.entity_idx]!;
            for (const r of t.frames) {
              if (!r) continue;
              expect(r.x0).toBeLessThanOrEqual(r.x1);
              expect(r.y0).toBeLessThanOrEqual(r.y1);
              expect(r.x1).toBeLessThanOrEqual(10000);
              expect(r.y1).toBeLessThanOrEqual(10000);
              expect(r.conf).toBeGreaterThan(0);
              if (ent.kind !== 'person') expect(r.id_conf).toBe(0);
              if (ent.kind === 'object') expect(r.pose).toBe(0);
              expect(r.pose & 0b110).not.toBe(0b110);
            }
          }
        }
        expect(a.flags & 1).toBe(sc === 'motion' ? 1 : 0);
      }
    }
  });

  it('unreferenced persons stay all-null; generic fallback scene for other programs', () => {
    const p: Program = { ...cupTower(), entities: [...cupTower().entities, { name: 'sam', kind: 'person', participant: 1 }] };
    const { a } = simulate(p, cupTowerCalibration, 'pass', 1);
    expect(a.tracks.find((t) => t.entity === 'sam')!.frames.every((r) => r === null)).toBe(true);

    const generic: Program = {
      ...cupTower(),
      legs: [{ id: 1, actor_bound: false, attempt_window_frames: 50, success: { op: 'near', a: { e: 'fan' }, b: { e: 'tower' }, dist: 2000 }, rule: { kind: 'exists' } }],
    };
    expect(recognize(generic)).toBeNull();
    const pass = simulatePipeline(generic, cupTowerCalibration, 'pass', 1);
    expect(pass.result.leg_results).toEqual([1]);
    expect(simulatePipeline(generic, cupTowerCalibration, 'motion', 1).result.leg_causes).toEqual([['MOTION']]);
    expect(simulatePipeline(generic, cupTowerCalibration, 'cross_fail', 1).result.reason).toBe(12);
    expect(simulatePipeline(generic, cupTowerCalibration, 'oversize', 1).result.reason).toBe(13);
  });

  it('Prng is deterministic and in range', () => {
    const a = new Prng(7);
    const b = new Prng(7);
    const xs = Array.from({ length: 50 }, () => a.int(-3, 3));
    expect(xs).toEqual(Array.from({ length: 50 }, () => b.int(-3, 3)));
    expect(xs.every((x) => x >= -3 && x <= 3)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(3);
    expect(() => a.int(2, 1)).toThrow();
  });
});
