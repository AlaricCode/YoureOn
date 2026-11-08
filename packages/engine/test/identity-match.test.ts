import { describe, expect, it } from 'vitest';
import {
  circuitMatch,
  closedSetMatch,
  cosineBps,
  enrollmentTemplate,
  matchFromScores,
  normalizeEmbedding,
  padToCircuit,
  quantizeEmbedding,
} from '../src/identity/index.js';
import { isqrtBig } from '../src/identity/math.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randVec = (r: () => number, n: number) => Array.from({ length: n }, () => r() * 2 - 1);

describe('isqrtBig', () => {
  it('is floor(sqrt) at perfect squares and their neighbours', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 99n, 100n, 101n]) {
      const s = isqrtBig(n);
      expect(s * s <= n && (s + 1n) * (s + 1n) > n).toBe(true);
    }
    const big = (1n << 64n) - 1n;
    const s = isqrtBig(big);
    expect(s).toBe(4294967295n);
    const sq = 9_597_970_048_524n * 9_597_970_048_524n;
    expect(isqrtBig(sq)).toBe(9_597_970_048_524n);
    expect(isqrtBig(sq - 1n)).toBe(9_597_970_048_523n);
    expect(() => isqrtBig(-1n)).toThrow();
  });
});

describe('quantizeEmbedding (§8.2)', () => {
  it('scales by 512, rounds half away from zero, clamps to ±127', () => {
    // unit vector with components at rounding boundaries: 0.5/512 → 1, −0.5/512 → −1
    const tiny = 0.5 / 512;
    const big = Math.sqrt(1 - 2 * tiny * tiny);
    const q = quantizeEmbedding([tiny, -tiny, big]);
    expect(Array.from(q)).toEqual([1, -1, 127]);
    const q2 = quantizeEmbedding([0.2, -0.3, Math.sqrt(1 - 0.04 - 0.09)]);
    expect(Array.from(q2)).toEqual([102, -127, 127]);
  });
  it('normalizes non-unit inputs; zero vector → zeros', () => {
    expect(Array.from(quantizeEmbedding([3, 4]))).toEqual([127, 127]);
    expect(Array.from(quantizeEmbedding([0.03, 0.04].map((x) => x * 1)))).toEqual([127, 127]);
    expect(Array.from(quantizeEmbedding([0, 0, 0]))).toEqual([0, 0, 0]);
    const v = Array.from({ length: 128 }, (_, i) => (i % 2 ? 1 : -1));
    const q = quantizeEmbedding(v);
    // each component ±1/sqrt(128) ≈ ±0.0884 → ±45.25 → ±45
    expect(q[0]).toBe(-45);
    expect(q[1]).toBe(45);
    expect(() => quantizeEmbedding([NaN, 1])).toThrow();
  });
  it('enrollmentTemplate = quantize(normalize(mean))', () => {
    const r = rng(3);
    const samples = [randVec(r, 128), randVec(r, 128), randVec(r, 128)].map((v) => Array.from(normalizeEmbedding(v)));
    const mean = samples[0]!.map((_, i) => (samples[0]![i]! + samples[1]![i]! + samples[2]![i]!) / 3);
    expect(Array.from(enrollmentTemplate(samples))).toEqual(Array.from(quantizeEmbedding(normalizeEmbedding(mean))));
    expect(() => enrollmentTemplate([])).toThrow();
  });
  it('padToCircuit zero-pads to 192 and validates', () => {
    const p = padToCircuit(new Int8Array(128).fill(5));
    expect(p.length).toBe(192);
    expect(p[127]).toBe(5);
    expect(p[128]).toBe(0);
    expect(() => padToCircuit([-128])).toThrow();
    expect(() => padToCircuit(new Array(193).fill(0))).toThrow();
  });
});

describe('cosineBps (§8.3)', () => {
  it('identical vectors → 10000; orthogonal / opposite / zero → 0', () => {
    expect(cosineBps([3, 4], [3, 4])).toBe(10000);
    expect(cosineBps([1, 0], [0, 1])).toBe(0);
    expect(cosineBps([1, 0], [-1, 0])).toBe(0);
    expect(cosineBps([0, 0], [1, 1])).toBe(0);
    expect(cosineBps([1, 1], [0, 0])).toBe(0);
  });
  it('is floor(dot·10000 / isqrt(ne·no))', () => {
    // dot = 1, ne = 1, no = 2 → isqrt(2) = 1 → 10000 (isqrt floors)
    expect(cosineBps([1, 0], [1, 1])).toBe(10000);
    // dot = 3, ne = 2, no = 9 → isqrt(18) = 4 → 7500
    expect(cosineBps([1, 1], [0, 3])).toBe(7500);
    const r = rng(9);
    for (let t = 0; t < 50; t++) {
      const e = Array.from(quantizeEmbedding(randVec(r, 192)));
      const o = Array.from(quantizeEmbedding(randVec(r, 192)));
      let dot = 0n;
      let ne = 0n;
      let no = 0n;
      for (let i = 0; i < 192; i++) {
        dot += BigInt(e[i]! * o[i]!);
        ne += BigInt(e[i]! ** 2);
        no += BigInt(o[i]! ** 2);
      }
      const expected = dot <= 0n ? 0 : Number((dot * 10000n) / isqrtBig(ne * no));
      expect(cosineBps(e, o)).toBe(expected);
      expect(cosineBps(e, o)).toBeLessThanOrEqual(10000);
    }
  });
  it('128-d face equals its zero-padded 192-d form; max-magnitude vectors', () => {
    const r = rng(5);
    const a = quantizeEmbedding(randVec(r, 128));
    const b = quantizeEmbedding(randVec(r, 128));
    expect(cosineBps(a, b)).toBe(cosineBps(padToCircuit(a), padToCircuit(b)));
    const m = new Array(192).fill(127);
    expect(cosineBps(m, m)).toBe(10000);
    expect(() => cosineBps([128], [1])).toThrow();
  });
});

describe('closedSetMatch (§8.3)', () => {
  const s = (pairs: [number, number][]) => pairs.map(([candidate, cos_bps]) => ({ candidate, cos_bps }));
  it('threshold and margin boundaries (face τ=5500, δ=1000)', () => {
    expect(matchFromScores(s([[0, 5500], [1, 4500]]), 'face')).toEqual({ matched: true, best: 0, cos1: 5500, cos2: 4500 });
    expect(matchFromScores(s([[0, 5499], [1, 0]]), 'face').matched).toBe(false);
    expect(matchFromScores(s([[0, 5500], [1, 4501]]), 'face').matched).toBe(false);
    expect(matchFromScores(s([[0, 5000], [1, 4000]]), 'voice').matched).toBe(true);
    expect(matchFromScores(s([[0, 4999]]), 'voice').matched).toBe(false);
  });
  it('single candidate: cos2 = 0; none: best null', () => {
    expect(matchFromScores(s([[3, 6000]]), 'face')).toEqual({ matched: true, best: 3, cos1: 6000, cos2: 0 });
    expect(matchFromScores([], 'face')).toEqual({ matched: false, best: null, cos1: 0, cos2: 0 });
  });
  it('ties → lower candidate index and margin 0 (not matched)', () => {
    const m = matchFromScores(s([[2, 8000], [1, 8000], [0, 100]]), 'face');
    expect(m.best).toBe(1);
    expect(m.cos2).toBe(8000);
    expect(m.matched).toBe(false);
  });
  it('matches the right enrolled member among a closed set', () => {
    const r = rng(11);
    const members = [0, 1, 2, 3].map((i) => ({ candidate: i, template: quantizeEmbedding(randVec(r, 128)) }));
    const noisy = Array.from(members[2]!.template, (v) => v / 127 + (r() - 0.5) * 0.1);
    const o = quantizeEmbedding(noisy);
    const m = closedSetMatch(o, members, 'face');
    expect(m.best).toBe(2);
    expect(m.matched).toBe(true);
    expect(m.scores.length).toBe(4);
    expect(m.scores[2]!.cos_bps).toBe(m.cos1);
  });
});

describe('circuitMatch (§8.3, bigint)', () => {
  it('dot ≤ 0 never matches', () => {
    expect(circuitMatch([1, 0], [0, 1], 0)).toBe(false);
    expect(circuitMatch([1, 0], [-1, 0], 0)).toBe(false);
  });
  it('exact boundary: cos = 0.6 exactly with τ = 6000 matches, 6001 does not', () => {
    // e = (3,4), o = (1,0): dot = 3, ne = 25, no = 1 → cos = 0.6
    expect(circuitMatch([3, 4], [1, 0], 6000)).toBe(true);
    expect(circuitMatch([3, 4], [1, 0], 6001)).toBe(false);
    expect(cosineBps([3, 4], [1, 0])).toBe(6000);
  });
  it('can differ from cosineBps ≥ τ because isqrt floors (prover must use circuitMatch)', () => {
    // e=(1,0), o=(1,1): true cos = 0.7071, cos_bps = 10000 (isqrt(2) = 1)
    expect(cosineBps([1, 0], [1, 1])).toBe(10000);
    expect(circuitMatch([1, 0], [1, 1], 7071)).toBe(true);
    expect(circuitMatch([1, 0], [1, 1], 7072)).toBe(false);
  });
  it('handles max-range 192-d vectors without overflow', () => {
    const m = new Array(192).fill(127);
    const n = new Array(192).fill(-127);
    expect(circuitMatch(m, m, 10000)).toBe(true);
    expect(circuitMatch(m, m, 16383)).toBe(false);
    expect(circuitMatch(m, n, 0)).toBe(false);
    expect(() => circuitMatch(m, m, -1)).toThrow();
  });
});
