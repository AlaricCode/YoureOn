// The reference clip is slid so its dancer is in the middle of the screen (model/framing), from
// the routine's own pose track.
import { JOINT_COUNT, KEYPOINT_LEN } from '@youre-on/shared/dance/joints';
import { getRoutine } from '@youre-on/shared/dance/routine';
import { describe, expect, it } from 'vitest';

import { clipSlide, mirroredClipShift, REACH_MARGIN, routineFraming } from '../model/framing';

const LONG = getRoutine('bye-bye-shuffle')!;

/** A frame with every joint at `x` (0..1), sure. */
const frameAt = (t: number, xs: readonly number[]) => {
  const k = new Array<number>(KEYPOINT_LEN).fill(0);
  for (let j = 0; j < JOINT_COUNT; j++) {
    k[j * 3] = Math.round(xs[j % xs.length]! * 10_000);
    k[j * 3 + 1] = 5_000;
    k[j * 3 + 2] = 900;
  }
  return { t, k };
};

describe('routineFraming', () => {
  it('finds the dancer of bye-bye-shuffle well right of centre', () => {
    const f = routineFraming(LONG)!;
    // measured on the clip's own frames: the silhouette's median middle is 0.706
    expect(f.centerX).toBeGreaterThan(0.68);
    expect(f.centerX).toBeLessThan(0.73);
    expect(f.minX).toBeGreaterThan(0.2);
    expect(f.minX).toBeLessThan(0.3);
    expect(f.maxX).toBeGreaterThan(0.95);
  });

  it('ignores joints the tracker was not sure of, and a routine with none', () => {
    const unsure = frameAt(0, [0.9]);
    for (let j = 0; j < JOINT_COUNT; j++) unsure.k[j * 3 + 2] = 50;
    expect(routineFraming({ frames: [unsure] })).toBeNull();
    const mixed = frameAt(0, [0.4, 0.6]);
    mixed.k[0] = 9_900;
    mixed.k[2] = 50;
    expect(routineFraming({ frames: [mixed] })).toEqual({ centerX: 0.5, minX: 0.4, maxX: 0.6 });
  });
});

describe('clipSlide', () => {
  it('does nothing for a dancer in the middle, or with no framing', () => {
    expect(clipSlide(null)).toBe(0);
    expect(clipSlide({ centerX: 0.5, minX: 0.3, maxX: 0.7 })).toBe(0);
  });

  it('slides the picture so the dancer is centred when there is room', () => {
    expect(clipSlide({ centerX: 0.6, minX: 0.45, maxX: 0.75 })).toBeCloseTo(0.1, 6);
    expect(clipSlide({ centerX: 0.4, minX: 0.25, maxX: 0.55 })).toBeCloseTo(-0.1, 6);
  });

  it('never slides the furthest reach out of the picture', () => {
    // centring would take 0.25, but an arm reaches to 0.2: only 0.2 − margin is spare
    expect(clipSlide({ centerX: 0.75, minX: 0.2, maxX: 0.95 })).toBeCloseTo(0.2 - REACH_MARGIN, 6);
    expect(clipSlide({ centerX: 0.25, minX: 0.05, maxX: 0.8 })).toBeCloseTo(
      -(0.2 - REACH_MARGIN),
      6,
    );
    // a dancer who uses the whole frame is left where they are
    expect(clipSlide({ centerX: 0.6, minX: 0.02, maxX: 0.98 })).toBe(0);
  });

  it('brings bye-bye-shuffle most of the way to the middle', () => {
    const f = routineFraming(LONG)!;
    const slide = clipSlide(f);
    expect(slide).toBeGreaterThan(0.12);
    expect(slide).toBeLessThanOrEqual(f.minX - REACH_MARGIN + 1e-9);
    // from about 0.71 to within 6% of the middle
    expect(Math.abs(f.centerX - slide - 0.5)).toBeLessThan(0.06);
  });
});

describe('mirroredClipShift', () => {
  it('moves the mirrored clip right by the slide, in points of the drawn width', () => {
    const slide = clipSlide(routineFraming(LONG));
    // an upright phone and an upright iPad: the clip (8:9) fills the width
    expect(mirroredClipShift(LONG, { width: 402, height: 874 })).toBe(Math.round(slide * 402));
    expect(mirroredClipShift(LONG, { width: 834, height: 1210 })).toBe(Math.round(slide * 834));
    // on its side the clip is as tall as the screen, and narrower
    const drawn = (834 * LONG.w) / LONG.h;
    expect(mirroredClipShift(LONG, { width: 1210, height: 834 })).toBe(Math.round(slide * drawn));
  });

  it('is nothing before the view is measured', () => {
    expect(mirroredClipShift(LONG, { width: 0, height: 0 })).toBe(0);
  });
});
