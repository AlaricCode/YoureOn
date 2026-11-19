// DANCE-OFF §3: framing check and identity tracking.
import { describe, expect, it } from 'vitest';
import {
  createTracker,
  DANCE_TRACKING,
  dequantizePerson,
  framingCheck,
  hipCenter,
  JOINT,
  quantizePerson,
  ROUTINES,
  seriesChecks,
  type PoseSeries,
} from '../src';
import { gauss, lcg } from './dance-helpers';

/** A small full-body person centred at image x = cx (normalized), from the routine's first pose. */
function person(cx: number, scale = 0.35): number[] {
  const k = dequantizePerson(ROUTINES[0]!.frames[0]!.k);
  const hx = (k[JOINT.leftHip * 3]! + k[JOINT.rightHip * 3]!) / 2;
  const hy = (k[JOINT.leftHip * 3 + 1]! + k[JOINT.rightHip * 3 + 1]!) / 2;
  const out = [...k];
  for (let j = 0; j < 19; j++) {
    out[j * 3] = cx + (k[j * 3]! - hx) * scale;
    out[j * 3 + 1] = 0.6 + (k[j * 3 + 1]! - hy) * scale;
  }
  return out;
}

const drop = (k: number[], joints: number[]): number[] => {
  const out = [...k];
  for (const j of joints) out[j * 3 + 2] = 0;
  return out;
};

const jittered = (k: number[], rng: () => number, s = 0.004): number[] =>
  k.map((v, i) => (i % 3 === 2 ? v : v + s * gauss(rng)));

describe('framingCheck (§3)', () => {
  const L = person(0.27);
  const R = person(0.73);
  it('passes two full bodies on opposite sides; A is the left one', () => {
    expect(framingCheck([L, R], 720, 1280)).toEqual({ ok: true, reason: 'ok', a: 0, b: 1 });
    expect(framingCheck([R, L], 720, 1280)).toEqual({ ok: true, reason: 'ok', a: 1, b: 0 });
  });
  it('counts people', () => {
    expect(framingCheck([], 720, 1280).reason).toBe('need_two');
    expect(framingCheck([L], 720, 1280).reason).toBe('need_two');
    expect(framingCheck([L, R, person(0.5)], 720, 1280).reason).toBe('too_many');
  });
  it('needs a head, both hips and both ankles', () => {
    expect(framingCheck([drop(L, [JOINT.nose, JOINT.neck]), R], 720, 1280).reason).toBe('head');
    expect(framingCheck([drop(L, [JOINT.nose]), R], 720, 1280).ok).toBe(true);
    expect(framingCheck([L, drop(R, [JOINT.leftAnkle])], 720, 1280).reason).toBe('feet');
    expect(framingCheck([L, drop(R, [JOINT.rightHip])], 720, 1280).reason).toBe('feet');
  });
  it('needs one each side of centre, with a gap', () => {
    expect(framingCheck([person(0.2), person(0.4)], 720, 1280).reason).toBe('same_side');
    expect(framingCheck([person(0.45), person(0.55)], 720, 1280).reason).toBe('too_close');
  });
});

describe('createTracker (§3)', () => {
  it('assigns A = left at round start; keeps identities under jitter and reordering', () => {
    const rng = lcg(1);
    const tr = createTracker({ w: 720, h: 1280 });
    const L = person(0.3);
    const R = person(0.7);
    for (let t = 0; t < 5000; t += 50) {
      const a = jittered(L, rng);
      const b = jittered(R, rng);
      const people = rng() < 0.5 ? [a, b] : [b, a];
      const f = tr.push(t, people);
      expect(f.a).toBe(a);
      expect(f.b).toBe(b);
      expect(f.n).toBe(2);
    }
    expect(tr.started()).toBe(true);
    expect(tr.stats()).toMatchObject({ max_people: 2, frames_over_two: 0, side_swaps: 0 });
  });

  it('counts a third person and never makes them A or B', () => {
    const rng = lcg(2);
    const tr = createTracker({ w: 720, h: 1280 });
    for (let t = 0; t < 3000; t += 50) {
      const a = jittered(person(0.25), rng);
      const b = jittered(person(0.75), rng);
      const c = jittered(person(0.5), rng);
      const people = t >= 1000 && t < 2000 ? [c, b, a] : [a, b];
      const f = tr.push(t, people);
      expect(f.a).toBe(a);
      expect(f.b).toBe(b);
    }
    const s = tr.stats();
    expect(s.max_people).toBe(3);
    expect(s.frames_over_two).toBe(20);
  });

  it('follows players who cross, and counts a sustained side swap once', () => {
    const rng = lcg(3);
    const tr = createTracker({ w: 720, h: 1280 });
    // A walks 0.3 -> 0.7 and B 0.7 -> 0.3 over 1 s, then they stay swapped for 2 s.
    for (let t = 0; t <= 4000; t += 50) {
      const u = Math.min(1, Math.max(0, (t - 1000) / 1000));
      const a = jittered(person(0.3 + 0.4 * u), rng, 0.002);
      const b = jittered(person(0.7 - 0.4 * u), rng, 0.002);
      const f = tr.push(t, rng() < 0.5 ? [a, b] : [b, a]);
      expect(f.a).toBe(a);
      expect(f.b).toBe(b);
    }
    expect(tr.stats().side_swaps).toBe(1);
  });

  it('a brief crossing (< SWAP_MIN_MS) is not a side swap', () => {
    const tr = createTracker({ w: 720, h: 1280 });
    for (let t = 0; t <= 3000; t += 50) {
      const swapped = t >= 1000 && t < 1000 + DANCE_TRACKING.SWAP_MIN_MS - 200;
      const a = person(swapped ? 0.56 : 0.44);
      const b = person(swapped ? 0.44 : 0.56);
      tr.push(t, [a, b]);
    }
    expect(tr.stats().side_swaps).toBe(0);
  });

  it('a player out of frame comes back as the same player', () => {
    const tr = createTracker({ w: 720, h: 1280 });
    const L = person(0.3);
    const R = person(0.7);
    tr.push(0, [L, R]);
    expect(tr.push(50, [R]).b).toBe(R);
    expect(tr.push(100, [R]).a).toBeNull();
    const back = tr.push(1500, [person(0.32), R]);
    expect(back.a).not.toBeNull();
    expect(back.b).toBe(R);
  });

  it('starts from an explicit assignment: A on the right, kept under jitter and reordering', () => {
    const rng = lcg(4);
    const L = person(0.3);
    const R = person(0.7);
    // A was identified standing on the right (face assignment), B on the left.
    const tr = createTracker({ w: 720, h: 1280, start: { a: [0.69, 0.6], b: [0.31, 0.6] } });
    expect(tr.aStartedRight()).toBeNull();
    for (let t = 0; t < 4000; t += 50) {
      const a = jittered(R, rng);
      const b = jittered(L, rng);
      const f = tr.push(t, rng() < 0.5 ? [a, b] : [b, a]);
      expect(f.a).toBe(a);
      expect(f.b).toBe(b);
    }
    expect(tr.aStartedRight()).toBe(true);
    // Standing on their own starting sides the whole time is not a side swap.
    expect(tr.stats().side_swaps).toBe(0);
    const last = tr.last();
    expect(last.a![0]).toBeGreaterThan(0.6);
    expect(last.b![0]).toBeLessThan(0.4);
  });

  it('counts side swaps relative to the starting sides (A started right)', () => {
    const rng = lcg(3);
    const tr = createTracker({ w: 720, h: 1280, start: { a: [0.7, 0.6], b: [0.3, 0.6] } });
    // A walks 0.7 -> 0.3 and B 0.3 -> 0.7 over 1 s, then they stay swapped for 2 s.
    for (let t = 0; t <= 4000; t += 50) {
      const u = Math.min(1, Math.max(0, (t - 1000) / 1000));
      const a = jittered(person(0.7 - 0.4 * u), rng, 0.002);
      const b = jittered(person(0.3 + 0.4 * u), rng, 0.002);
      const f = tr.push(t, rng() < 0.5 ? [a, b] : [b, a]);
      expect(f.a).toBe(a);
      expect(f.b).toBe(b);
    }
    expect(tr.stats().side_swaps).toBe(1);
  });

  it('the start spots pick the nearest pair, wherever the players stood', () => {
    // Identified left / right as the rule would: the same assignment as no start at all.
    const L = person(0.3);
    const R = person(0.7);
    const seeded = createTracker({ w: 720, h: 1280, start: { a: [0.32, 0.6], b: [0.68, 0.6] } });
    const plain = createTracker({ w: 720, h: 1280 });
    expect(seeded.push(0, [R, L])).toEqual(plain.push(0, [R, L]));
    expect(seeded.aStartedRight()).toBe(false);
    expect(plain.aStartedRight()).toBe(false);
  });

  it('hipCenter falls back to the root, then one hip', () => {
    const k = person(0.4);
    expect(hipCenter(k)![0]).toBeCloseTo(0.4, 6);
    expect(hipCenter(drop(k, [JOINT.leftHip]))).not.toBeNull();
    expect(hipCenter(drop(k, [JOINT.leftHip, JOINT.rightHip, JOINT.root]))).toBeNull();
  });
});

describe('seriesChecks', () => {
  it('recomputes max people, frames over two and side swaps from a series', () => {
    const frames: PoseSeries['frames'] = [];
    for (let t = 0; t <= 4000; t += 100) {
      const swapped = t >= 2000;
      frames.push({
        t,
        n: t === 500 ? 3 : 2,
        a: quantizePerson(person(swapped ? 0.7 : 0.3)),
        b: quantizePerson(person(swapped ? 0.3 : 0.7)),
      });
    }
    const s: PoseSeries = {
      schema_version: 1,
      w: 720,
      h: 1280,
      fps_cap: 10,
      sync_offset_ms: 0,
      frames,
    };
    expect(seriesChecks(s)).toEqual({
      max_people: 3,
      frames_over_two: 1,
      side_swaps: 1,
      a_start: 'left',
    });
  });

  it('byFace: reads the starting sides from the first frame with both; swaps count from there', () => {
    const at = (t: number, aX: number, bX: number) => ({
      t,
      n: 2,
      a: quantizePerson(person(aX)),
      b: quantizePerson(person(bX)),
    });
    const base = { schema_version: 1 as const, w: 720, h: 1280, fps_cap: 10, sync_offset_ms: 0 };
    const stay: PoseSeries = {
      ...base,
      frames: [{ t: 0, n: 1, a: quantizePerson(person(0.7)), b: null }],
    };
    for (let t = 100; t <= 4000; t += 100) stay.frames.push(at(t, 0.7, 0.3));
    const byFace = { byFace: true };
    expect(seriesChecks(stay, byFace)).toEqual({
      max_people: 2,
      frames_over_two: 0,
      side_swaps: 0,
      a_start: 'right',
    });
    const swap: PoseSeries = { ...base, frames: [] };
    for (let t = 0; t <= 4000; t += 100)
      swap.frames.push(t < 2000 ? at(t, 0.7, 0.3) : at(t, 0.3, 0.7));
    expect(seriesChecks(swap, byFace)).toMatchObject({ side_swaps: 1, a_start: 'right' });
    expect(seriesChecks({ ...base, frames: [] }, byFace).a_start).toBeNull();
  });

  it('without a face identification, A is expected on the LEFT: A on the right is a swap', () => {
    // A recorder that labels B's skeleton as A from the start (or players who crossed before
    // the series window): the left / right rule flags it, as it did before the face assignment.
    const at = (t: number, aX: number, bX: number) => ({
      t,
      n: 2,
      a: quantizePerson(person(aX)),
      b: quantizePerson(person(bX)),
    });
    const base = { schema_version: 1 as const, w: 720, h: 1280, fps_cap: 10, sync_offset_ms: 0 };
    const right: PoseSeries = { ...base, frames: [] };
    for (let t = 0; t <= 4000; t += 100) right.frames.push(at(t, 0.7, 0.3));
    expect(seriesChecks(right)).toEqual({
      max_people: 2,
      frames_over_two: 0,
      side_swaps: 1,
      a_start: 'right',
    });
    expect(seriesChecks(right, { byFace: false }).side_swaps).toBe(1);
    // The same series with A on the left counts no swap either way.
    const left: PoseSeries = {
      ...base,
      frames: right.frames.map((f) => ({ ...f, a: f.b, b: f.a })),
    };
    expect(seriesChecks(left).side_swaps).toBe(0);
    expect(seriesChecks(left, { byFace: true })).toMatchObject({ side_swaps: 0, a_start: 'left' });
  });
});
