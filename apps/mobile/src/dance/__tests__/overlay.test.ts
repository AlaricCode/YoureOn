// Overlay geometry (contain-fit like the native preview layer, mirroring, panel fitting) and the
// reference skeleton's interpolation.
import { dequantizePerson } from '@youre-on/shared/dance/pose';
import { describe, expect, it } from 'vitest';

import {
  containRect,
  fitPanels,
  headCircle,
  jointPoints,
  mapPoint,
  popupAnchor,
  skeletonSegments,
} from '../model/overlay';
import { frameIndexAt, referencePoseAt, upcomingKeyMove } from '../model/reference';
import { WAVE_POP } from './helpers';

describe('containRect (resizeAspect)', () => {
  it('letterboxes a portrait image in a taller view (bars top and bottom)', () => {
    const r = containRect({ width: 390, height: 844 }, { width: 720, height: 1280 });
    expect(r.width).toBeCloseTo(390);
    expect(r.height).toBeCloseTo(693.33, 1);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo((844 - 693.33) / 2, 1);
  });

  it('pillarboxes it in a wide view (bars left and right)', () => {
    const r = containRect({ width: 1000, height: 400 }, { width: 720, height: 1280 });
    expect(r.height).toBeCloseTo(400);
    expect(r.width).toBeCloseTo(225);
    expect(r.x).toBeCloseTo(387.5);
    expect(r.y).toBe(0);
  });

  it('is empty for an unmeasured view', () => {
    expect(containRect({ width: 0, height: 0 }, { width: 720, height: 1280 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('mapPoint and the skeleton', () => {
  const rect = { x: 10, y: 20, width: 200, height: 400 };

  it('maps normalized image coords (top-left origin) into the rect; mirrored flips x', () => {
    expect(mapPoint(rect, 0, 0)).toEqual({ x: 10, y: 20 });
    expect(mapPoint(rect, 1, 1)).toEqual({ x: 210, y: 420 });
    expect(mapPoint(rect, 0.25, 0.5)).toEqual({ x: 60, y: 220 });
    expect(mapPoint(rect, 0.25, 0.5, true)).toEqual({ x: 160, y: 220 });
  });

  it('draws only bones whose two joints are confident', () => {
    const k = dequantizePerson(WAVE_POP.frames[0]!.k);
    const all = skeletonSegments(k, rect);
    expect(all).toHaveLength(18);
    // Drop the left wrist (10): the left forearm goes.
    const noWrist = k.slice();
    noWrist[10 * 3 + 2] = 0.1;
    expect(skeletonSegments(noWrist, rect)).toHaveLength(17);
    expect(jointPoints(noWrist, rect, [10, 11])).toHaveLength(1);
  });

  it('a mirrored skeleton is the reflection of the plain one', () => {
    const k = dequantizePerson(WAVE_POP.frames[0]!.k);
    const plain = skeletonSegments(k, rect);
    const mirrored = skeletonSegments(k, rect, { mirrored: true });
    plain.forEach((s, i) => {
      const m = mirrored[i]!;
      expect(m.x1).toBeCloseTo(2 * rect.x + rect.width - s.x1);
      expect(m.y1).toBeCloseTo(s.y1);
    });
  });

  it('puts a head disc on the nose, sized from the shoulders', () => {
    const k = dequantizePerson(WAVE_POP.frames[0]!.k);
    const h = headCircle(k, rect)!;
    expect(h.x).toBeCloseTo(mapPoint(rect, k[0]!, k[1]!).x);
    expect(h.r).toBeGreaterThan(4);
    const none = k.map((v, i) => (i % 3 === 2 && i < 15 ? 0 : v));
    expect(headCircle(none, rect)).toBeNull();
  });
});

describe('fitPanels', () => {
  it('two equal 9:16 panels, as large as the box allows', () => {
    const p = fitPanels({ width: 400, height: 600 }, 9 / 16, 8);
    expect(p.width).toBeCloseTo(196);
    expect(p.height).toBeCloseTo(196 / (9 / 16));
    const wide = fitPanels({ width: 1000, height: 400 }, 9 / 16, 8);
    expect(wide.height).toBeCloseTo(400);
    expect(wide.width).toBeCloseTo(225);
    expect(fitPanels({ width: 0, height: 100 }, 9 / 16, 8)).toEqual({ width: 0, height: 0 });
  });

  it('popups sit over each player’s half', () => {
    expect(popupAnchor({ width: 200, height: 400 }, 'A')).toEqual({ x: 50, y: 88 });
    expect(popupAnchor({ width: 200, height: 400 }, 'B')).toEqual({ x: 150, y: 88 });
  });
});

describe('reference pose', () => {
  const frames = WAVE_POP.frames;

  it('finds the frame at or before t', () => {
    expect(frameIndexAt(frames, -100)).toBe(0);
    expect(frameIndexAt(frames, frames[5]!.t)).toBe(5);
    expect(frameIndexAt(frames, frames[5]!.t + 1)).toBe(5);
    expect(frameIndexAt(frames, 99_999)).toBe(frames.length - 1);
  });

  it('is the routine frame itself on a frame time, clamped outside', () => {
    expect(referencePoseAt(WAVE_POP, frames[7]!.t)).toEqual(dequantizePerson(frames[7]!.k));
    expect(referencePoseAt(WAVE_POP, -500)).toEqual(dequantizePerson(frames[0]!.k));
    expect(referencePoseAt(WAVE_POP, 99_999)).toEqual(dequantizePerson(frames.at(-1)!.k));
  });

  it('interpolates halfway between two frames', () => {
    const a = dequantizePerson(frames[3]!.k);
    const b = dequantizePerson(frames[4]!.k);
    const mid = referencePoseAt(WAVE_POP, (frames[3]!.t + frames[4]!.t) / 2);
    for (let i = 0; i < 57; i += 3) {
      expect(mid[i]!).toBeCloseTo((a[i]! + b[i]!) / 2, 6);
      expect(mid[i + 1]!).toBeCloseTo((a[i + 1]! + b[i + 1]!) / 2, 6);
    }
  });

  it('a joint missing in a neighbour does not slide', () => {
    const r = {
      frames: [
        { t: 0, k: Array.from({ length: 57 }, (_, i) => (i % 3 === 2 ? 1_000 : 2_000)) },
        { t: 100, k: Array.from({ length: 57 }, (_, i) => (i % 3 === 2 ? 0 : 8_000)) },
      ],
    };
    const p = referencePoseAt(r, 50);
    expect(p[0]).toBeCloseTo(0.2);
    expect(p[2]).toBeCloseTo(1);
  });

  it('names the next key move within the window', () => {
    const first = WAVE_POP.key_moves[0]!;
    expect(upcomingKeyMove(WAVE_POP, first.t - 1_000)?.id).toBe(first.id);
    expect(upcomingKeyMove(WAVE_POP, first.t - 5_000)).toBeNull();
    expect(upcomingKeyMove(WAVE_POP, 99_999)).toBeNull();
  });
});
