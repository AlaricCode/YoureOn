import { describe, expect, it } from 'vitest';

import {
  allMeasured,
  historyMode,
  pillFrame,
  pillMove,
  press,
  pressAt,
  pressTarget,
  sameFrame,
  skeleton,
  skeletonTitleFraction,
  stakePill,
  stakeTap,
  type Frame,
} from '../polish';
import { MAX_MOMENT_MS, MAX_TRANSITION_MS } from '../tokens';

const f = (x: number, width = 64): Frame => ({ x, y: 0, width, height: 44 });

describe('press feedback', () => {
  it('stays inside the motion budget and is subtle', () => {
    expect(press.inMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(press.outMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(press.inMs).toBeLessThan(press.outMs);
    for (const s of [press.scale, press.chipScale, press.avatarScale]) {
      expect(s).toBeGreaterThanOrEqual(0.9);
      expect(s).toBeLessThan(1);
    }
  });

  it('scales and dims on press, returns on release', () => {
    expect(pressTarget(true, false, press.scale)).toEqual({
      scale: 0.97,
      opacity: 0.85,
      ms: press.inMs,
    });
    expect(pressTarget(false, false, press.scale)).toEqual({
      scale: 1,
      opacity: 1,
      ms: press.outMs,
    });
  });

  it('under Reduce Motion: no scale, the plain 0.7 dim, instantly', () => {
    expect(pressTarget(true, true, press.scale)).toEqual({ scale: 1, opacity: 0.7, ms: 0 });
    expect(pressTarget(false, true, press.scale)).toEqual({ scale: 1, opacity: 1, ms: 0 });
    expect(pressAt(1, true, press.chipScale)).toEqual({ scale: 1, opacity: 0.7 });
  });

  it('interpolates and clamps the press amount', () => {
    expect(pressAt(0, false, 0.95)).toEqual({ scale: 1, opacity: 1 });
    expect(pressAt(1, false, 0.95).scale).toBeCloseTo(0.95);
    expect(pressAt(0.5, false, 0.95).scale).toBeCloseTo(0.975);
    expect(pressAt(2, false, 0.95).scale).toBeCloseTo(0.95);
    expect(pressAt(-1, false, 0.95)).toEqual({ scale: 1, opacity: 1 });
  });
});

describe('stake picker pill', () => {
  const options = [1, 2, 5, 10];
  const frames = { 1: f(0), 2: f(72), 5: f(144), 10: f(216, 72) };

  it('has no frame until every chip has measured', () => {
    expect(allMeasured(options, {})).toBe(false);
    expect(allMeasured(options, { 1: f(0), 2: f(72), 5: f(144) })).toBe(false);
    expect(pillFrame(options, { 1: f(0) }, 1)).toBeNull();
    expect(allMeasured([], {})).toBe(false);
  });

  it('sits on the chosen chip', () => {
    expect(allMeasured(options, frames)).toBe(true);
    expect(pillFrame(options, frames, 5)).toEqual(f(144));
    expect(pillFrame(options, frames, 10)).toEqual(f(216, 72));
  });

  it('hides when the value is not an option', () => {
    expect(pillFrame(options, frames, 3)).toBeNull();
  });

  it('jumps into place first (and under Reduce Motion), then slides', () => {
    expect(pillMove(false, false)).toBe('jump');
    expect(pillMove(true, false)).toBe('slide');
    expect(pillMove(true, true)).toBe('jump');
    expect(stakePill.slideMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(stakePill.inkMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
  });

  it('ignores sub-pixel layout noise', () => {
    expect(sameFrame(f(10), { ...f(10), x: 10.2 })).toBe(true);
    expect(sameFrame(f(10), f(11))).toBe(false);
    expect(sameFrame(undefined, f(0))).toBe(false);
  });

  it('reports every tap, ticks only on a change, ignores taps while disabled', () => {
    expect(stakeTap(2, 5, false)).toEqual({ report: true, haptic: true });
    expect(stakeTap(2, 2, false)).toEqual({ report: true, haptic: false });
    expect(stakeTap(2, 5, true)).toEqual({ report: false, haptic: false });
  });
});

describe('history loading', () => {
  it('shows the skeleton only before anything has loaded', () => {
    expect(historyMode('loading', 0)).toEqual({ mode: 'skeleton', refreshing: false });
    expect(historyMode('loading', 3)).toEqual({ mode: 'list', refreshing: true });
  });

  it('keeps loaded rows on a failed reload', () => {
    expect(historyMode('failed', 0)).toEqual({ mode: 'error', refreshing: false });
    expect(historyMode('failed', 3)).toEqual({ mode: 'list', refreshing: false });
  });

  it('shows the empty state or the list when ready', () => {
    expect(historyMode('ready', 0)).toEqual({ mode: 'empty', refreshing: false });
    expect(historyMode('ready', 1)).toEqual({ mode: 'list', refreshing: false });
  });
});

describe('skeleton', () => {
  it('pulses gently and holds still under Reduce Motion', () => {
    expect(skeleton.low).toBeGreaterThan(0.3);
    expect(skeleton.low).toBeLessThan(1);
    expect(skeleton.pulseMs).toBeGreaterThan(MAX_MOMENT_MS);
    expect(skeleton.reducedOpacity).toBeGreaterThan(skeleton.low);
    expect(skeleton.reducedOpacity).toBeLessThan(1);
  });

  it('varies the title bars, deterministically', () => {
    const widths = Array.from({ length: 6 }, (_, i) => skeletonTitleFraction(i));
    expect(new Set(widths).size).toBe(6);
    for (const w of widths) {
      expect(w).toBeGreaterThan(0.3);
      expect(w).toBeLessThan(0.8);
    }
    expect(skeletonTitleFraction(6)).toBe(skeletonTitleFraction(0));
    expect(skeletonTitleFraction(-1)).toBe(skeletonTitleFraction(5));
  });
});
