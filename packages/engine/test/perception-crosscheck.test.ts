import { describe, expect, it } from 'vitest';
import { crossCheck, phoneAgreementBps, sealSession, simulate, trackAgreementBps } from '../src/perception/index.js';
import { compareEvaluations, frameAgreement } from '../src/perception/crosscheck.js';
import { iouBps } from '../src/perception/geometry.js';
import type { EvalResult, QFrame, SessionTracks } from '../src/types.js';
import { cupTower, cupTowerCalibration, paperBall, paperBallCalibration } from './perception-fixtures.js';

const q = (x0: number, y0: number, x1: number, y1: number, conf = 90): QFrame => ({ x0, y0, x1, y1, conf, fill: 0, id_conf: 0, pose: 0 });

describe('frame agreement (§6.3 step 1)', () => {
  it('IoU_bps uses floor and the union; exactly IOU_AGREE_BPS agrees', () => {
    // A = [0,0,100,100], B = [0,0,200,100] → inter 10000, union 20000 → 5000.
    expect(iouBps(q(0, 0, 100, 100), q(0, 0, 200, 100))).toBe(5000);
    expect(frameAgreement(q(0, 0, 100, 100), q(0, 0, 200, 100))).toBe(true);
    // B = [0,0,201,100] → 10000*10000/20100 = 4975 → disagree.
    expect(frameAgreement(q(0, 0, 100, 100), q(0, 0, 201, 100))).toBe(false);
  });
  it('union 0 ⇒ agree', () => {
    expect(iouBps(q(5, 5, 5, 5), q(5, 5, 5, 9))).toBeNull();
    expect(frameAgreement(q(5, 5, 5, 5), q(5, 5, 5, 9))).toBe(true);
  });
  it('one side present: agrees only below DECISIVE_CONF_MIN', () => {
    expect(frameAgreement(q(0, 0, 10, 10, 49), null)).toBe(true);
    expect(frameAgreement(null, q(0, 0, 10, 10, 50))).toBe(false);
    // conf < PRESENCE_MIN counts as absent on that side.
    expect(frameAgreement(q(0, 0, 10, 10, 29), q(500, 500, 900, 900, 49))).toBe(true);
  });
  it('neither present ⇒ not considered', () => {
    expect(frameAgreement(null, q(0, 0, 1, 1, 29))).toBeNull();
  });
});

describe('track agreement bps', () => {
  it('floor(agree*10000/considered); no considered frames ⇒ 10000', () => {
    expect(trackAgreementBps([null, null], [null])).toBe(10000);
    const a = Array.from({ length: 10 }, () => q(0, 0, 100, 100));
    const b = a.map((r, i) => (i === 0 ? q(5000, 5000, 6000, 6000) : r));
    expect(trackAgreementBps(a, b)).toBe(9000); // exactly TRACK_AGREE_BPS
    const c = a.map((r, i) => (i < 2 ? null : r));
    expect(trackAgreementBps(a, c)).toBe(8000);
    expect(trackAgreementBps(a.slice(0, 3), a.slice(0, 3), new Set([0]))).toBe(10000);
  });
});

function shiftFrames(s: SessionTracks, entity: string, dx: number): SessionTracks {
  return {
    ...s,
    tracks: s.tracks.map((t) => (t.entity !== entity ? t : { ...t, frames: t.frames.map((r) => (r ? { ...r, x0: r.x0 + dx, x1: r.x1 + dx } : null)) })),
  };
}

function delay(s: SessionTracks, entity: string, by: number): SessionTracks {
  return {
    ...s,
    tracks: s.tracks.map((t) => {
      if (t.entity !== entity) return t;
      const frames = t.frames.map((_, f) => (f - by >= 0 ? t.frames[f - by]! : t.frames[0]!));
      return { ...t, frames };
    }),
  };
}

describe('crossCheck (§6.3)', () => {
  it('passes for host B = host A ± 1 px jitter and reports per-entity agreement by name', () => {
    const p = paperBall();
    const { a, b } = simulate(p, paperBallCalibration, 'pass', 7);
    const r = crossCheck(a, b, p, paperBallCalibration);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.entity_agreement_bps).sort()).toEqual(['ball', 'can', 'shooter']);
    expect(r.event_mismatches).toEqual([]);
    expect(r.phone_agreement_bps).toBeUndefined();
  });

  it('only referenced entities are checked (the unused fan may disagree)', () => {
    const p = cupTower();
    const { a } = simulate(p, cupTowerCalibration, 'pass', 1);
    const b = shiftFrames(a, 'fan', 3000);
    const r = crossCheck(a, b, p, cupTowerCalibration);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.entity_agreement_bps)).toEqual(['tower']);
  });

  it('fails when an entity agrees on < 90 % of frames', () => {
    const p = cupTower();
    const { a, b } = simulate(p, cupTowerCalibration, 'cross_fail', 1);
    const r = crossCheck(a, b, p, cupTowerCalibration);
    expect(r.ok).toBe(false);
    expect(r.entity_agreement_bps.tower).toBeLessThan(9000);
  });

  it('event timing within ±3 frames passes; 4 frames fails', () => {
    const p = cupTower();
    const { a } = simulate(p, cupTowerCalibration, 'fail', 1);
    const ok = crossCheck(a, delay(a, 'tower', 3), p, cupTowerCalibration);
    expect(ok.event_mismatches).toEqual([]);
    const bad = crossCheck(a, delay(a, 'tower', 4), p, cupTowerCalibration);
    expect(bad.ok).toBe(false);
    expect(bad.event_mismatches.join(' ')).toMatch(/decisive frames/);
  });

  it('leg value mismatch fails even with perfect box agreement elsewhere', () => {
    const p = cupTower();
    const pass = simulate(p, cupTowerCalibration, 'pass', 1).a;
    const fail = simulate(p, cupTowerCalibration, 'fail', 1).a;
    const r = crossCheck(pass, fail, p, cupTowerCalibration);
    expect(r.ok).toBe(false);
    expect(r.event_mismatches.some((m) => m.startsWith('leg 1: value'))).toBe(true);
  });

  it('compareEvaluations checks attempt counts, frames and success frames', () => {
    const p = paperBall();
    const base: EvalResult = {
      status: 'ok', reason: 0, preruling: 1, winner_mask: 2, leg_results: [1], leg_causes: [[]], decisive_frames: [[10, 20]],
      attempts: [{ leg: 0, frame: 10, success_frame: 20 }], checkpoints: [], n_checkpoints: 0, cost: 0,
    };
    expect(compareEvaluations(p, base, { ...base, attempts: [{ leg: 0, frame: 13, success_frame: 17 }], decisive_frames: [[13, 17]] })).toEqual([]);
    expect(compareEvaluations(p, base, { ...base, attempts: [{ leg: 0, frame: 10, success_frame: null }] })).toEqual(['leg 1 attempt 1: success 20 vs null']);
    expect(compareEvaluations(p, base, { ...base, attempts: [] })).toEqual(['leg 1: attempts 1 vs 0']);
    expect(compareEvaluations(p, base, { ...base, decisive_frames: [[10]] })).toHaveLength(1);
  });

  it('evaluates even when the job flags lack cross_check_ok, and motion stays symmetric', () => {
    const p = paperBall();
    const { a, b } = simulate(p, paperBallCalibration, 'motion', 2);
    expect(a.flags & 1).toBe(1);
    expect(crossCheck(a, b, p, paperBallCalibration).ok).toBe(true);
  });
});

describe('phone agreement (§6.3 step 4, advisory)', () => {
  it('compares only reported frames, matches labels, and seals bit4 without changing ok', () => {
    const p = cupTower();
    const { a, b } = simulate(p, cupTowerCalibration, 'pass', 1);
    const t = a.tracks[0]!.frames[0]!;
    const good = { frames: [{ t_ms: 0, boxes: [['Cup tower', t.x0, t.y0, t.x1, t.y1, 80] as [string, number, number, number, number, number]] }] };
    expect(phoneAgreementBps(a, good, p, cupTowerCalibration)).toEqual({ tower: 10000 });
    const bad = { frames: [{ t_ms: 50, boxes: [['cup tower', 0, 0, 100, 100, 90] as [string, number, number, number, number, number]] }] };
    const r = crossCheck(a, b, p, cupTowerCalibration, [good, bad]);
    expect(r.ok).toBe(true);
    expect(r.phone_agreement_bps).toEqual({ tower: 0 });
    const sealed = sealSession(a, r);
    expect(sealed.flags & 0b10).toBe(0b10);
    expect(sealed.flags & 0x10).toBe(0x10);
    const failed = sealSession({ ...a, flags: 0b11 }, { ...r, ok: false, phone_agreement_bps: { tower: 10000 } });
    expect(failed.flags).toBe(0b01);
  });
});
