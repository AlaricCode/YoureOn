import { describe, expect, it } from 'vitest';

import { columnFor } from '../column';
import { layout, space } from '../tokens';

describe('the content column', () => {
  it('is the whole window on a phone, upright', () => {
    for (const [w, h] of [
      [375, 667],
      [393, 852],
      [402, 874],
      [440, 956],
    ] as const)
      expect(columnFor(w, h)).toEqual({ width: w, inset: 0, wide: false });
  });

  it('is the whole window on a phone on its side (the judge cam on a tripod keeps its width)', () => {
    expect(columnFor(874, 402)).toEqual({ width: 874, inset: 0, wide: false });
    expect(columnFor(956, 440)).toEqual({ width: 956, inset: 0, wide: false });
  });

  it('is a centred phone-width column on an iPad, either way up', () => {
    for (const [w, h] of [
      [744, 1133],
      [834, 1210],
      [1032, 1376],
      [1210, 834],
      [1376, 1032],
    ] as const) {
      const c = columnFor(w, h);
      expect(c.wide).toBe(true);
      expect(c.width).toBe(layout.maxContentWidth);
      expect(c.inset * 2 + c.width).toBe(w);
    }
  });

  it('leaves a narrow iPad window (Split View, Slide Over) alone', () => {
    expect(columnFor(320, 1210)).toEqual({ width: 320, inset: 0, wide: false });
    expect(columnFor(507, 1210)).toEqual({ width: 507, inset: 0, wide: false });
    // tall and exactly as wide as the column: nothing to centre
    expect(columnFor(layout.maxContentWidth, 1210).wide).toBe(false);
  });

  it('the column is wider than any phone and leaves a real margin on the smallest iPad', () => {
    expect(layout.maxContentWidth).toBeGreaterThan(440);
    expect(layout.tabletMinSide).toBeGreaterThan(layout.maxContentWidth);
    expect(columnFor(744, 1133).inset).toBeGreaterThanOrEqual(space.x8);
  });
});
