import { describe, expect, it } from 'vitest';

import { balanceA11yValue, indexAtX, SCRUB, scrubDelta, scrubStep } from '../scrub';
import { sparkGeometry, sparkPoints } from '../spark';
import { MAX_TRANSITION_MS } from '../tokens';

describe('scrub index', () => {
  it('snaps to the nearest vertex, clamped to the series', () => {
    // 5 points across 108 pt with 4 pt insets: vertices at x = 4, 29, 54, 79, 104.
    expect(indexAtX(4, 5, 108, 4)).toBe(0);
    expect(indexAtX(16, 5, 108, 4)).toBe(0);
    expect(indexAtX(17, 5, 108, 4)).toBe(1);
    expect(indexAtX(54, 5, 108, 4)).toBe(2);
    expect(indexAtX(104, 5, 108, 4)).toBe(4);
    expect(indexAtX(-30, 5, 108, 4)).toBe(0);
    expect(indexAtX(500, 5, 108, 4)).toBe(4);
  });

  it('honours a separate left inset (the line starts on the page margin)', () => {
    expect(indexAtX(1, 3, 107, 6, 1)).toBe(0);
    expect(indexAtX(51, 3, 107, 6, 1)).toBe(1);
    expect(indexAtX(101, 3, 107, 6, 1)).toBe(2);
  });

  it('agrees with the drawn vertices (one shared layout)', () => {
    const series = [3, 9, 4, 12, 7, 7, 15];
    const pts = sparkPoints(series, 320, 56, 6, 1);
    expect(pts).toHaveLength(series.length);
    pts.forEach((p, i) => expect(indexAtX(p.x, series.length, 320, 6, 1)).toBe(i));
    // The drawn path ends where the last vertex is.
    const g = sparkGeometry(series, 320, 56, 6, 1);
    const last = pts[pts.length - 1];
    expect(g.end).toEqual({
      x: Math.round((last?.x ?? 0) * 100) / 100,
      y: Math.round((last?.y ?? 0) * 100) / 100,
    });
  });

  it('degenerate sizes do not throw', () => {
    expect(indexAtX(10, 0, 100, 4)).toBe(0);
    expect(indexAtX(10, 1, 100, 4)).toBe(0);
    expect(indexAtX(10, 4, 4, 4)).toBe(3);
    expect(sparkPoints([1, 2], 100, 50)).toEqual([]);
  });
});

describe('scrub delta (change up to that point)', () => {
  it('is the point minus the first point', () => {
    const s = [3000, 3215, 2900, 3500];
    expect(scrubDelta(s, 0)).toBe(0);
    expect(scrubDelta(s, 1)).toBe(215);
    expect(scrubDelta(s, 2)).toBe(-100);
    expect(scrubDelta(s, 3)).toBe(500);
    expect(scrubDelta(s, 99)).toBe(500);
    expect(scrubDelta([], 2)).toBe(0);
  });
});

describe('VoiceOver adjustable', () => {
  it('steps back from live and returns to live at the end', () => {
    expect(scrubStep(null, 4, -1)).toBe(2);
    expect(scrubStep(2, 4, -1)).toBe(1);
    expect(scrubStep(0, 4, -1)).toBe(0);
    expect(scrubStep(1, 4, 1)).toBe(2);
    expect(scrubStep(2, 4, 1)).toBeNull();
    expect(scrubStep(null, 4, 1)).toBeNull();
    expect(scrubStep(null, 1, -1)).toBeNull();
  });

  it('reads the balance and the change', () => {
    const series = [3000, 3215, 2900, 3500];
    expect(balanceA11yValue({ cents: 3500, series, at: null, changeCents: 500 })).toBe(
      '$35.00, +$5.00',
    );
    expect(balanceA11yValue({ cents: 3500, series, at: 1, changeCents: 500 })).toBe(
      '$32.15, +$2.15',
    );
    expect(balanceA11yValue({ cents: 3500, series, at: 2 })).toBe('$29.00, −$1.00');
    expect(balanceA11yValue({ cents: 3500, series: [], at: null, delta: '+$5' })).toBe(
      '$35.00, +$5',
    );
    expect(balanceA11yValue({ cents: 3500, series: [], at: null, inBetsUsd: '$5' })).toBe(
      '$35.00, In bets $5',
    );
  });
});

describe('scrub tuning', () => {
  it('keeps its transitions under the cap', () => {
    expect(SCRUB.glideMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(SCRUB.fadeMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(SCRUB.halo).toBeGreaterThan(SCRUB.dot);
  });
});
