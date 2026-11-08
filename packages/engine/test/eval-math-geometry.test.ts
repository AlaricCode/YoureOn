import { describe, expect, it } from 'vitest';
import { applyCmp, EvalInvariantError, idiv, isqrt, sign } from '../src/eval/math.js';
import {
  area,
  bottomCenter,
  center,
  expand,
  inter,
  interiorRect,
  openingRect,
  polyBBox,
  ptInPoly,
  ptInRect,
  side,
} from '../src/eval/geometry.js';

describe('eval math', () => {
  it('idiv truncates and asserts operand signs', () => {
    expect(idiv(7, 2)).toBe(3);
    expect(idiv(0, 5)).toBe(0);
    expect(idiv(10, 10)).toBe(1);
    expect(idiv(2 ** 53 - 1, 3)).toBe(3002399751580330);
    expect(() => idiv(-1, 2)).toThrow(EvalInvariantError);
    expect(() => idiv(1, 0)).toThrow(EvalInvariantError);
    expect(() => idiv(1.5, 1)).toThrow(EvalInvariantError);
  });

  it('isqrt is floor(sqrt(n)) by integer Newton', () => {
    for (let r = 0; r < 2000; r++) {
      expect(isqrt(r * r)).toBe(r);
      if (r > 0) expect(isqrt(r * r - 1)).toBe(r - 1);
      expect(isqrt(r * r + r)).toBe(r);
    }
    // the largest value the evaluator can produce: (2·10^4)² ·2
    expect(isqrt(2 * 10000 * 10000)).toBe(14142);
    expect(isqrt(200000000)).toBe(14142);
    expect(isqrt(1e15)).toBe(31622776);
    expect(() => isqrt(-4)).toThrow(EvalInvariantError);
  });

  it('applyCmp follows the CMP codes', () => {
    expect([0, 1, 2, 3, 4, 5].map((c) => applyCmp(c, 3, 3))).toEqual([true, false, true, false, true, false]);
    expect([0, 1, 2, 3, 4, 5].map((c) => applyCmp(c, 4, 3))).toEqual([true, true, false, false, false, true]);
    expect(() => applyCmp(6, 1, 1)).toThrow(EvalInvariantError);
  });

  it('sign', () => {
    expect([sign(-5), sign(0), sign(9)]).toEqual([-1, 0, 1]);
  });
});

describe('eval geometry', () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('area / inter / ptInRect', () => {
    expect(area({ x0: 0, y0: 0, x1: 10, y1: 5 })).toBe(50);
    expect(inter({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 })).toEqual({ x0: 5, y0: 5, x1: 10, y1: 10 });
    // touching edges is empty
    expect(inter({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 })).toBeNull();
    expect(ptInRect({ x: 10, y: 10 }, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(true);
    expect(ptInRect({ x: 11, y: 10 }, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBe(false);
  });

  it('side of the §15.1 line', () => {
    const a = { x: 3000, y: 6000 };
    const b = { x: 3000, y: 10000 };
    expect(side(a, b, { x: 1000, y: 9000 })).toBe(1);
    expect(side(a, b, { x: 5000, y: 9000 })).toBe(-1);
    expect(side(a, b, { x: 3000, y: 1 })).toBe(0);
  });

  it('ptInPoly interior, exterior, edges and vertices (exact even-odd)', () => {
    expect(ptInPoly({ x: 5, y: 5 }, sq)).toBe(true);
    expect(ptInPoly({ x: 15, y: 5 }, sq)).toBe(false);
    // left edge in, right edge out; vertex (0,0) in, (10,10) out
    expect(ptInPoly({ x: 0, y: 5 }, sq)).toBe(true);
    expect(ptInPoly({ x: 10, y: 5 }, sq)).toBe(false);
    expect(ptInPoly({ x: 0, y: 0 }, sq)).toBe(true);
    expect(ptInPoly({ x: 10, y: 10 }, sq)).toBe(false);
    // orientation does not matter
    expect(ptInPoly({ x: 5, y: 5 }, [...sq].reverse())).toBe(true);
    // concave polygon (U shape): notch is outside
    const u = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
      { x: 20, y: 30 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 30 },
      { x: 0, y: 30 },
    ];
    expect(ptInPoly({ x: 15, y: 20 }, u)).toBe(false);
    expect(ptInPoly({ x: 5, y: 20 }, u)).toBe(true);
    expect(ptInPoly({ x: 25, y: 20 }, u)).toBe(true);
  });

  it('polyBBox / expand / center / anchors', () => {
    expect(polyBBox([{ x: 5, y: 9 }, { x: 1, y: 3 }, { x: 7, y: 2 }])).toEqual({ x0: 1, y0: 2, x1: 7, y1: 9 });
    expect(expand({ x0: 100, y0: 100, x1: 200, y1: 300 }, 10)).toEqual({ x0: 90, y0: 80, x1: 210, y1: 320 });
    expect(expand({ x0: 0, y0: 5, x1: 10000, y1: 10000 }, 10)).toEqual({ x0: 0, y0: 0, x1: 10000, y1: 10000 });
    expect(center({ x0: 0, y0: 0, x1: 5, y1: 7 })).toEqual({ x: 2, y: 3 });
    expect(bottomCenter({ x0: 0, y0: 0, x1: 5, y1: 7 })).toEqual({ x: 2, y: 7 });
  });

  it('derived sub-regions', () => {
    const b = { x0: 7600, y0: 6200, x1: 8800, y1: 9400 };
    expect(openingRect(b)).toEqual({ x0: 7720, y0: 5880, x1: 8680, y1: 6840 });
    expect(interiorRect(b)).toEqual({ x0: 7720, y0: 6520, x1: 8680, y1: 9080 });
    // opening y0 clamps at 0
    expect(openingRect({ x0: 0, y0: 10, x1: 100, y1: 1000 }).y0).toBe(0);
  });
});
