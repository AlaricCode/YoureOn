import { describe, expect, it } from 'vitest';

import {
  SETTLE,
  SWIPE,
  bridgeScale,
  drainFrom,
  liftVelocity,
  swipeArmed,
  swipeLift,
  swipeOutcome,
  swipeProgress,
  ticksCrossed,
} from '../swipe';

describe('swipe tokens', () => {
  it('travel is a thumb flick, not a reach (56..96 pt)', () => {
    expect(SWIPE.travel).toBeGreaterThanOrEqual(56);
    expect(SWIPE.travel).toBeLessThanOrEqual(96);
  });

  it('the settle spring is critically damped and clamped: no bounce', () => {
    const ratio = SETTLE.damping / (2 * Math.sqrt(SETTLE.stiffness * SETTLE.mass));
    expect(ratio).toBeGreaterThanOrEqual(1);
    expect(SETTLE.overshootClamping).toBe(true);
  });

  it('short transitions stay within the 200 ms rule', () => {
    for (const ms of [SWIPE.nudgeMs, SWIPE.armMs, SWIPE.pressInMs, SWIPE.pressOutMs]) {
      expect(ms).toBeLessThanOrEqual(200);
    }
  });

  it('ticks are ascending and strictly inside (0, 1)', () => {
    const t = [...SWIPE.ticks];
    expect(t).toEqual([...t].sort((a, b) => a - b));
    for (const v of t) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('swipeLift', () => {
  it('is 0 at rest and when pulling down', () => {
    expect(swipeLift(0)).toBe(0);
    expect(swipeLift(30)).toBe(0);
    expect(swipeLift(Number.NaN)).toBe(0);
  });

  it('follows the finger 1:1 up to travel', () => {
    expect(swipeLift(-1)).toBe(1);
    expect(swipeLift(-36)).toBe(36);
    expect(swipeLift(-SWIPE.travel)).toBe(SWIPE.travel);
  });

  it('rubber-bands past travel at the overdrag factor', () => {
    expect(swipeLift(-(SWIPE.travel + 20))).toBeCloseTo(SWIPE.travel + 20 * SWIPE.overdragFactor);
  });

  it('caps the overdrag', () => {
    expect(swipeLift(-1000)).toBe(SWIPE.travel + SWIPE.maxOverdrag);
    expect(swipeLift(-(SWIPE.travel + SWIPE.maxOverdrag / SWIPE.overdragFactor))).toBe(
      SWIPE.travel + SWIPE.maxOverdrag,
    );
  });

  it('is monotonic in upward travel', () => {
    let prev = -1;
    for (let up = 0; up <= 300; up += 3) {
      const l = swipeLift(-up);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });
});

describe('swipeProgress / swipeArmed', () => {
  it('maps lift to 0..1 over travel and clamps the overdrag', () => {
    expect(swipeProgress(0)).toBe(0);
    expect(swipeProgress(SWIPE.travel / 2)).toBe(0.5);
    expect(swipeProgress(SWIPE.travel)).toBe(1);
    expect(swipeProgress(SWIPE.travel + SWIPE.maxOverdrag)).toBe(1);
    expect(swipeProgress(-5)).toBe(0);
  });

  it('arms exactly at travel', () => {
    expect(swipeArmed(SWIPE.travel - 0.01)).toBe(false);
    expect(swipeArmed(SWIPE.travel)).toBe(true);
    expect(swipeArmed(SWIPE.travel + 4)).toBe(true);
  });
});

describe('ticksCrossed', () => {
  it('counts each tick once on the way up', () => {
    expect(ticksCrossed(0, 0.2)).toBe(0);
    expect(ticksCrossed(0.2, 0.25)).toBe(1);
    expect(ticksCrossed(0.25, 0.3)).toBe(0);
    expect(ticksCrossed(0, 0.8)).toBe(3);
    expect(ticksCrossed(0.4, 0.6)).toBe(1);
  });

  it('crossing down or standing still ticks nothing', () => {
    expect(ticksCrossed(0.8, 0)).toBe(0);
    expect(ticksCrossed(0.5, 0.5)).toBe(0);
    expect(ticksCrossed(0.6, 0.4)).toBe(0);
  });

  it('a full climb in small steps ticks exactly ticks.length times', () => {
    let n = 0;
    let prev = 0;
    for (let up = 0; up <= SWIPE.travel; up += 0.7) {
      const p = swipeProgress(swipeLift(-up));
      n += ticksCrossed(prev, p);
      prev = p;
    }
    expect(n).toBe(SWIPE.ticks.length);
  });
});

describe('swipeOutcome', () => {
  const armed = SWIPE.travel;
  const far = SWIPE.travel * SWIPE.flingMinProgress;
  const fast = -SWIPE.flingVelocity;

  it('commits an armed release', () => {
    expect(swipeOutcome({ lift: armed, velocityY: 0, canceled: false })).toBe('commit');
    expect(swipeOutcome({ lift: armed + 10, velocityY: 300, canceled: false })).toBe('commit');
  });

  it('never commits a canceled gesture, armed or flung', () => {
    expect(swipeOutcome({ lift: armed, velocityY: 0, canceled: true })).toBe('settle');
    expect(swipeOutcome({ lift: far, velocityY: fast * 2, canceled: true })).toBe('settle');
  });

  it('commits a fast upward flick from far enough along', () => {
    expect(swipeOutcome({ lift: far, velocityY: fast, canceled: false })).toBe('commit');
  });

  it('does not commit a flick that started too low', () => {
    expect(swipeOutcome({ lift: far - 1, velocityY: fast * 3, canceled: false })).toBe('settle');
  });

  it('does not commit a slow release short of travel', () => {
    expect(swipeOutcome({ lift: far, velocityY: fast + 1, canceled: false })).toBe('settle');
    expect(swipeOutcome({ lift: armed - 1, velocityY: 0, canceled: false })).toBe('settle');
  });

  it('backing out (slid down below the threshold, released moving down) settles', () => {
    expect(swipeOutcome({ lift: 20, velocityY: 600, canceled: false })).toBe('settle');
    expect(swipeOutcome({ lift: 0, velocityY: 0, canceled: false })).toBe('settle');
  });

  it('a downward flick never commits, even from high up', () => {
    expect(swipeOutcome({ lift: armed - 1, velocityY: 2000, canceled: false })).toBe('settle');
  });
});

describe('stretch helpers', () => {
  it('bridgeScale spans 0..1 over the full stretch', () => {
    expect(bridgeScale(0)).toBe(0);
    expect(bridgeScale(SWIPE.travel + SWIPE.maxOverdrag)).toBe(1);
    expect(bridgeScale(1000)).toBe(1);
    expect(bridgeScale(-3)).toBe(0);
  });

  it('liftVelocity flips the sign (up is positive lift)', () => {
    expect(liftVelocity(-900)).toBe(900);
    expect(liftVelocity(400)).toBe(-400);
  });
});

describe('drainFrom', () => {
  it('starts at the fraction left and drains over the time left', () => {
    expect(drainFrom(10_000, 20_000, 0)).toEqual({ fraction: 0.5, holdMs: 0, drainMs: 10_000 });
    expect(drainFrom(20_000, 20_000, 0)).toEqual({ fraction: 1, holdMs: 0, drainMs: 20_000 });
  });

  it('a deadline further out than the window holds full, then drains over the window', () => {
    expect(drainFrom(25_000, 20_000, 0)).toEqual({ fraction: 1, holdMs: 5_000, drainMs: 20_000 });
  });

  it('a past deadline is an empty, still bar', () => {
    expect(drainFrom(1_000, 20_000, 5_000)).toEqual({ fraction: 0, holdMs: 0, drainMs: 0 });
  });

  it('a zero or bad window is an empty, still bar', () => {
    expect(drainFrom(10_000, 0, 0)).toEqual({ fraction: 0, holdMs: 0, drainMs: 0 });
    expect(drainFrom(Number.NaN, 20_000, 0)).toEqual({ fraction: 0, holdMs: 0, drainMs: 0 });
  });
});
