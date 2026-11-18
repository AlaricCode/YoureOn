import { describe, expect, it } from 'vitest';

import { SPARK_MIN_POINTS, sparkDirection, sparkGeometry } from '../spark';

describe('sparkline geometry', () => {
  it('draws nothing under three points (two are a ruler line) or without room', () => {
    expect(SPARK_MIN_POINTS).toBe(3);
    expect(sparkGeometry([], 100, 50)).toEqual({ d: '', end: null });
    expect(sparkGeometry([5], 100, 50)).toEqual({ d: '', end: null });
    expect(sparkGeometry([1, 2], 100, 50)).toEqual({ d: '', end: null });
    expect(sparkGeometry([1, 2, 3], 8, 50)).toEqual({ d: '', end: null });
    expect(sparkGeometry([1, Number.NaN, 2], 100, 50)).toEqual({ d: '', end: null });
  });

  it('spans the width left to right, lowest value at the bottom, as smooth cubic segments', () => {
    const g = sparkGeometry([0, 10, 5], 108, 58, 4);
    expect(g.d.startsWith('M4 54 C')).toBe(true);
    expect(g.d.match(/C/g)).toHaveLength(2);
    expect(g.d).toContain(' 54 4 C');
    expect(g.d.endsWith(' 104 29')).toBe(true);
    expect(g.end).toEqual({ x: 104, y: 29 });
  });

  it('is monotone: a local peak is flat (no overshoot above the highest point)', () => {
    const g = sparkGeometry([0, 10, 5], 108, 58, 4);
    // Every y in the path stays inside the padded box: nothing above the peak at y = 4.
    const ys = g.d
      .replace(/[MC]/g, ' ')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((_, i) => i % 2 === 1);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(4);
      expect(y).toBeLessThanOrEqual(54);
    }
  });

  it('can start on the left edge and keep the pad only on the right (the end dot)', () => {
    const g = sparkGeometry([0, 10, 5], 107, 58, 6, 1);
    expect(g.d.startsWith('M1 52 C')).toBe(true);
    expect(g.end).toEqual({ x: 101, y: 29 });
  });

  it('a flat series is a flat line through the middle', () => {
    expect(sparkGeometry([3, 3, 3], 108, 58, 4).d).toBe(
      'M4 29 C20.67 29 37.33 29 54 29 C70.67 29 87.33 29 104 29',
    );
  });

  it('knows which way the money went', () => {
    expect(sparkDirection([100, 90, 150])).toBe(1);
    expect(sparkDirection([100, 150, 90])).toBe(-1);
    expect(sparkDirection([100, 50, 100])).toBe(0);
    expect(sparkDirection([100])).toBe(0);
  });
});

describe('design preview sparkline data', () => {
  it('ends at the preview balance and goes up overall', async () => {
    const { BALANCE, BALANCE_SERIES } = await import('../../preview/data');
    expect(BALANCE_SERIES.at(-1)).toBe(Number(BigInt(BALANCE.usdc) / 10_000n));
    expect(sparkDirection(BALANCE_SERIES)).toBe(1);
  });
});
