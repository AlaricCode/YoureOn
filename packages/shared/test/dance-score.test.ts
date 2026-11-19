// DANCE-OFF §4: the deterministic scorer, calibrated against synthetic players (./dance-helpers).
import { describe, expect, it } from 'vitest';
import {
  createLiveScorer,
  DANCE_SCORING,
  dequantizePerson,
  displayX10,
  getRoutine,
  lagFactor,
  limbSimilarity,
  limbVectors,
  mirrorLimbs,
  POSE_MAX_FRAMES,
  POSE_T_MAX_MS,
  PoseSeries,
  poseSha256,
  ROUTINE_MAX_DURATION_MS,
  quantizePerson,
  RoutineData,
  ROUTINES,
  routineSha256,
  scoreRound,
  type DanceRoundResult,
} from '../src';
import { lcg, makePlayer, selfSeries, seriesOf, type PlayerOpts } from './dance-helpers';

const AMATEUR: PlayerOpts = { angleDeg: 12, lagMs: 250, lagWobbleMs: 60, jitter: 0.003 };
const STILL: PlayerOpts = { stand: true, jitter: 0.003 };

const round = (r: RoutineData, a: PlayerOpts, b: PlayerOpts, seed: number): DanceRoundResult => {
  const rng = lcg(seed);
  return scoreRound(r, seriesOf(r, makePlayer(r, a, rng), makePlayer(r, b, rng)));
};

describe('routines (§2)', () => {
  it('exactly 3 bundled routines, each a valid RoutineData with 8..16 beat key moves', () => {
    expect(ROUTINES).toHaveLength(3);
    expect(new Set(ROUTINES.map((r) => r.id)).size).toBe(3);
    for (const r of ROUTINES) {
      expect(RoutineData.safeParse(r).success).toBe(true);
      expect(r.key_moves.length).toBeGreaterThanOrEqual(8);
      expect(r.key_moves.length).toBeLessThanOrEqual(16);
      const beat = 60_000 / r.bpm;
      for (const m of r.key_moves) {
        const beats = (m.t - r.first_beat_ms) / beat;
        expect(Math.abs(beats - Math.round(beats))).toBeLessThan(0.01);
      }
      expect(getRoutine(r.id)).toBe(r);
      expect(routineSha256(r)).toMatch(/^[0-9a-f]{64}$/);
      expect(routineSha256(r)).toBe(routineSha256(r));
    }
    expect(getRoutine('nope')).toBeNull();
  });
});

describe('scoreRound (§4)', () => {
  it('a routine against itself is exactly 100.0 under identity, every key move PERFECT', () => {
    for (const r of ROUTINES) {
      const res = scoreRound(r, selfSeries(r));
      expect(res.a.score_x10).toBe(1000);
      expect(res.b.score_x10).toBe(1000);
      expect(res.a.convention).toBe('identity');
      expect(res.a.key_moves.every((m) => m.grade === 'PERFECT')).toBe(true);
      // A Vision take has a few frames where nobody was seen (and its last frame is a little
      // before duration_ms); a synthetic routine covers every bin.
      if (r.source === 'synthetic') expect(res.a.coverage_pct).toBe(100);
      else expect(res.a.coverage_pct).toBeGreaterThanOrEqual(95);
      expect(res.a.mean_lag_ms).toBe(0);
      expect(res.too_close).toBe(true);
      expect(res.winner).toBeNull();
      expect(res.failed).toBeNull();
    }
  });

  it('standing still scores at most 10.0 (near 0) on every routine', () => {
    for (const [i, r] of ROUTINES.entries()) {
      const res = round(r, STILL, STILL, 100 + i);
      expect(res.a.score_x10).toBeLessThanOrEqual(100);
      expect(res.b.score_x10).toBeLessThanOrEqual(100);
      expect(res.a.movement).toBeLessThan(0.15);
      expect(res.a.key_moves.filter((m) => m.grade !== 'MISS').length).toBeLessThanOrEqual(1);
    }
  });

  it('a decent amateur (12° errors, ~250 ms late, jitter) lands 60..90', () => {
    for (const [i, r] of ROUTINES.entries()) {
      for (const seed of [1, 2, 3]) {
        const res = round(r, AMATEUR, AMATEUR, seed * 10 + i);
        for (const p of [res.a, res.b]) {
          expect(p.score_x10).toBeGreaterThanOrEqual(600);
          expect(p.score_x10).toBeLessThanOrEqual(900);
          expect(p.mean_lag_ms).toBeGreaterThan(50);
          expect(p.mean_lag_ms).toBeLessThan(400);
        }
      }
    }
  });

  it('a mirror copier (flip + L/R swap) scores high under the mirror convention', () => {
    for (const [i, r] of ROUTINES.entries()) {
      const res = round(r, { ...AMATEUR, mirror: true }, AMATEUR, 40 + i);
      expect(res.a.convention).toBe('mirror');
      expect(res.a.score_x10).toBeGreaterThanOrEqual(600);
      expect(res.b.convention).toBe('identity');
    }
  });

  it('20 seeded head-to-heads: the clearly better dancer wins every one', () => {
    const variants: { name: string; worse: (rng: () => number) => PlayerOpts }[] = [
      {
        name: 'sloppy',
        worse: (rng) => ({ angleDeg: 28 + 8 * rng(), lagMs: 380 + 80 * rng(), jitter: 0.006 }),
      },
      { name: 'standing', worse: () => STILL },
      { name: 'half', worse: () => ({ ...AMATEUR, untilMs: 7_000 }) },
      { name: 'very late', worse: () => ({ angleDeg: 14, lagMs: 650, jitter: 0.004 }) },
      { name: 'wrong routine', worse: () => ({ ...AMATEUR, dances: undefined }) },
    ];
    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      const rng = lcg(1000 + i);
      const r = ROUTINES[i % 3]!;
      const v = variants[i % variants.length]!;
      const better: PlayerOpts = {
        angleDeg: 6 + 6 * rng(),
        lagMs: 150 + 150 * rng(),
        lagWobbleMs: 40,
        jitter: 0.003,
      };
      const worse = v.worse(rng);
      if (v.name === 'wrong routine') worse.dances = ROUTINES[(i + 1) % 3];
      const aBetter = i % 2 === 0;
      const res = aBetter ? round(r, better, worse, 2000 + i) : round(r, worse, better, 2000 + i);
      results.push(`${i} ${v.name} ${res.a.score_x10}/${res.b.score_x10} ${res.winner}`);
      expect(res.failed, results.join('\n')).toBeNull();
      expect(res.too_close, results.join('\n')).toBe(false);
      expect(res.winner, results.join('\n')).toBe(aBetter ? 'A' : 'B');
    }
  });

  it('identical players are too close to call (no winner)', () => {
    const r = ROUTINES[0]!;
    const p = makePlayer(r, AMATEUR, lcg(7));
    const res = scoreRound(r, seriesOf(r, p, p));
    expect(res.a.score_x10).toBe(res.b.score_x10);
    expect(res.too_close).toBe(true);
    expect(res.winner).toBeNull();
  });

  it('a player seen under MIN_COVERAGE fails the round (coverage_b); empty is no_frames', () => {
    const r = ROUTINES[1]!;
    const res = round(r, AMATEUR, { ...AMATEUR, visibleUntilMs: 6_000 }, 9);
    expect(res.b.coverage_pct).toBeLessThan(DANCE_SCORING.MIN_COVERAGE * 100);
    expect(res.failed).toBe('coverage_b');
    expect(res.winner).toBeNull();
    const a = round(r, { ...AMATEUR, visibleUntilMs: 4_000 }, AMATEUR, 9);
    expect(a.failed).toBe('coverage_a');
    const empty = scoreRound(r, { ...selfSeries(r), frames: [] });
    expect(empty.failed).toBe('no_frames');
    expect(empty.a.score_x10).toBe(0);
  });

  it('random dropouts lower coverage but a 20 % dropout still scores', () => {
    const r = ROUTINES[2]!;
    const res = round(r, { ...AMATEUR, dropout: 0.2 }, AMATEUR, 11);
    expect(res.failed).toBeNull();
    expect(res.a.coverage_pct).toBeGreaterThanOrEqual(90);
    expect(res.a.score_x10).toBeGreaterThan(500);
  });

  it('sync_offset_ms is subtracted from every t', () => {
    const r = ROUTINES[0]!;
    const rng = lcg(5);
    const late = makePlayer(r, { angleDeg: 8, lagMs: 300, jitter: 0.002 }, rng);
    const raw = scoreRound(r, seriesOf(r, late, late));
    const synced = scoreRound(r, seriesOf(r, late, late, { sync_offset_ms: 300 }));
    // Held poses match at lag 0 too, so the reported mean lag understates a constant lag.
    expect(raw.a.mean_lag_ms).toBeGreaterThan(100);
    expect(Math.abs(synced.a.mean_lag_ms)).toBeLessThan(raw.a.mean_lag_ms / 2);
    expect(synced.a.score_x10).toBeGreaterThan(raw.a.score_x10);
  });

  it('is deterministic: the same input gives the same result', () => {
    const r = ROUTINES[2]!;
    const rng = lcg(77);
    const s = seriesOf(r, makePlayer(r, AMATEUR, rng), makePlayer(r, STILL, rng));
    const copy = PoseSeries.parse(JSON.parse(JSON.stringify(s)));
    expect(scoreRound(r, copy)).toEqual(scoreRound(r, s));
    expect(poseSha256(copy)).toBe(poseSha256(s));
  });
});

describe('scorer helpers', () => {
  it('limb similarity: identical = 1, COS_FLOOR and beyond = 0, mirror swaps sides', () => {
    const k = dequantizePerson(ROUTINES[0]!.frames[30]!.k);
    const v = limbVectors(k, 720, 1280);
    expect(limbSimilarity(v, v)).toBeCloseTo(1, 12);
    const flipped = { ...v, dx: v.dx.map((x) => -x), dy: v.dy.map((y) => -y) };
    expect(limbSimilarity(v, flipped)).toBe(0);
    expect(limbSimilarity(mirrorLimbs(mirrorLimbs(v)), v)).toBeCloseTo(1, 12);
    expect(mirrorLimbs(v).ok).toEqual([1, 0, 3, 2, 5, 4, 7, 6, 8].map((i) => v.ok[i]));
    const none = { ...v, ok: v.ok.map(() => false), weight: 0 };
    expect(limbSimilarity(v, none)).toBeNull();
  });

  it('lag factor and display curve', () => {
    expect(lagFactor(0)).toBe(1);
    expect(lagFactor(-DANCE_SCORING.LAG_GRACE_MS)).toBe(1);
    expect(lagFactor(500)).toBeCloseTo(1 - (DANCE_SCORING.LAG_PENALTY * 350) / 500, 12);
    expect(displayX10(0)).toBe(0);
    expect(displayX10(1)).toBe(1000);
    expect(displayX10(DANCE_SCORING.RAW_CEIL)).toBe(1000);
    expect(displayX10(DANCE_SCORING.RAW_FLOOR)).toBe(0);
    expect(Number.isInteger(displayX10(0.5))).toBe(true);
  });
});

describe('pose quantization (§2)', () => {
  it('quantize ∘ dequantize is the identity on quantized ints; values clamp; no -0', () => {
    const rng = lcg(3);
    for (let n = 0; n < 50; n++) {
      const q = Array.from({ length: 57 }, (_, i) =>
        Math.floor(rng() * (i % 3 === 2 ? 1001 : 10001)),
      );
      expect(quantizePerson(dequantizePerson(q))).toEqual(q);
    }
    const k: number[] = Array.from({ length: 57 }, (_, i) =>
      i % 3 === 2 ? 2 : i === 0 ? -0.0 : 1.5,
    );
    k[3] = Number.NaN;
    const q = quantizePerson(k);
    expect(q[0]).toBe(0);
    expect(Object.is(q[0], -0)).toBe(false);
    expect(q[1]).toBe(10000);
    expect(q[2]).toBe(1000);
    expect(q[3]).toBe(0);
    expect(() => quantizePerson([1, 2])).toThrow();
  });

  it('PoseSeries is strict, bounded and ordered', () => {
    const r = ROUTINES[0]!;
    const s = selfSeries(r);
    expect(PoseSeries.safeParse(s).success).toBe(true);
    expect(PoseSeries.safeParse({ ...s, extra: 1 }).success).toBe(false);
    expect(PoseSeries.safeParse({ ...s, fps_cap: 31 }).success).toBe(false);
    expect(PoseSeries.safeParse({ ...s, sync_offset_ms: 501 }).success).toBe(false);
    const many = (n: number) => ({
      ...s,
      frames: Array.from({ length: n }, (_, t) => ({ ...s.frames[0]!, t })),
    });
    // A 40 s round + count-in at the 30 fps cap fits; one frame over the cap does not.
    expect(PoseSeries.safeParse(many(43 * 30)).success).toBe(true);
    expect(PoseSeries.safeParse(many(POSE_MAX_FRAMES + 1)).success).toBe(false);
    const at = (t: number) => ({ ...s, frames: [{ ...s.frames[0]!, t }] });
    expect(PoseSeries.safeParse(at(POSE_T_MAX_MS)).success).toBe(true);
    expect(PoseSeries.safeParse(at(POSE_T_MAX_MS + 1)).success).toBe(false);
    expect(POSE_T_MAX_MS).toBeGreaterThanOrEqual(ROUTINE_MAX_DURATION_MS + 1_000);
    const back = { ...s, frames: [s.frames[1]!, s.frames[0]!] };
    expect(PoseSeries.safeParse(back).success).toBe(false);
    const badC = [...s.frames[0]!.a!];
    badC[2] = 1001;
    expect(PoseSeries.safeParse({ ...s, frames: [{ ...s.frames[0]!, a: badC }] }).success).toBe(
      false,
    );
    expect(
      PoseSeries.safeParse({ ...s, frames: [{ ...s.frames[0]!, a: [1.5, ...badC.slice(1)] }] })
        .success,
    ).toBe(false);
  });
});

describe('createLiveScorer (§4.6)', () => {
  it('final() is exactly scoreRound over the quantized series; meters and events behave', () => {
    const r = ROUTINES[0]!;
    const rng = lcg(21);
    const a = makePlayer(r, AMATEUR, rng);
    const b = makePlayer(r, STILL, rng);
    const live = createLiveScorer(r, { syncOffsetMs: 0, w: r.w, h: r.h, fpsCap: 20 });
    const events: { key_move_id: string; player: string; grade: string }[] = [];
    let last = { a: 0, b: 0 };
    for (let i = 0; i < a.length; i++) {
      const u = live.push({ t: a[i]!.t, n: 2, a: a[i]!.k, b: b[i]!.k });
      events.push(...u.events);
      expect(u.a.meter).toBeGreaterThanOrEqual(0);
      expect(u.a.meter).toBeLessThanOrEqual(100);
      expect(u.a.limbs).toHaveLength(9);
      last = { a: u.a.meter, b: u.b.meter };
    }
    expect(last.a).toBeGreaterThan(last.b);
    const { series, result } = live.final();
    expect(PoseSeries.safeParse(series).success).toBe(true);
    expect(series.fps_cap).toBe(20);
    expect(result).toEqual(scoreRound(r, series));
    expect(result.winner).toBe('A');
    // Every key move whose window closed inside the round, once per player.
    const closed = r.key_moves.filter(
      (m) => m.t + DANCE_SCORING.KEY_WINDOW_AFTER_MS < r.duration_ms,
    );
    expect(events).toHaveLength(closed.length * 2);
    const liveA = events.filter((e) => e.player === 'A');
    const finalA = result.a.key_moves.slice(0, liveA.length).map((m) => m.grade);
    expect(liveA.map((e) => e.grade)).toEqual(finalA);
    expect(events.filter((e) => e.player === 'B').every((e) => e.grade === 'MISS')).toBe(true);
  });

  it('takes w / h from the first frame and drops out-of-order frames', () => {
    const r = ROUTINES[1]!;
    const live = createLiveScorer(r);
    const k = dequantizePerson(r.frames[0]!.k);
    live.push({ t: 100, n: 1, a: k, b: null, w: 720, h: 1280 });
    live.push({ t: 50, n: 1, a: k, b: null });
    const s = live.series();
    expect(s.w).toBe(720);
    expect(s.h).toBe(1280);
    expect(s.frames.map((f) => f.t)).toEqual([100]);
    expect(s.frames[0]!.b).toBeNull();
  });
});
