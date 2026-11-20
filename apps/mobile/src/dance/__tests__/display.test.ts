// The Dance Off display sizes its words from the screen it is on (model/display): any device
// can be the display, a phone keeps the sizes it always had, an iPad gets bigger ones.
import { describe, expect, it } from 'vitest';

import { space, type } from '../../ui/tokens';
import {
  DISPLAY_PHONE,
  DISPLAY_PHONE_SIDE,
  displayScale,
  displaySizes,
  sized,
} from '../model/display';

const PHONES = [
  [375, 667],
  [393, 852],
  [402, 874],
  [440, 956],
] as const;

describe('the dance display on a phone', () => {
  it('is drawn at the phone sizes on every phone, either way up', () => {
    for (const [w, h] of PHONES) {
      expect(displaySizes({ width: w, height: h })).toEqual(DISPLAY_PHONE);
      expect(displaySizes({ width: h, height: w })).toEqual(DISPLAY_PHONE);
    }
  });

  it('uses the sizes the screen had before it sized itself: the app’s type, a 240 pt numeral', () => {
    // (the tokens are at a phone's scale in this test run)
    expect(DISPLAY_PHONE.title).toBe(type.heading.fontSize);
    expect(DISPLAY_PHONE.name).toBe(type.subtitle.fontSize);
    expect(DISPLAY_PHONE.vs).toBe(type.section.fontSize);
    expect(DISPLAY_PHONE.status).toBe(type.subtitle.fontSize);
    expect(DISPLAY_PHONE.edge).toBe(space.x6);
    expect(DISPLAY_PHONE.numeral).toBe(240);
    expect(DISPLAY_PHONE.bar).toBe(2);
  });
});

describe('the dance display on an iPad', () => {
  it('grows with the short side', () => {
    expect(displayScale({ width: DISPLAY_PHONE_SIDE, height: 956 })).toBe(1);
    expect(displayScale({ width: 834, height: 1210 })).toBeCloseTo(834 / 440, 6);
    expect(displayScale({ width: 1210, height: 834 })).toBeCloseTo(834 / 440, 6);
  });

  it('is about twice a phone on an 11-inch iPad, more on a 13-inch', () => {
    const eleven = displaySizes({ width: 834, height: 1210 });
    expect(eleven.numeral).toBe(455);
    expect(eleven.name).toBe(42);
    expect(eleven.title).toBe(32);
    expect(eleven.status).toBe(42);
    expect(eleven.bar).toBe(4);
    const thirteen = displaySizes({ width: 1032, height: 1376 });
    expect(thirteen.numeral).toBeGreaterThan(eleven.numeral);
    expect(thirteen.name).toBeGreaterThan(eleven.name);
  });

  it('keeps the same proportion of the width for "GO" as a phone does', () => {
    const phone = displaySizes({ width: 440, height: 956 });
    const pad = displaySizes({ width: 834, height: 1210 });
    expect(pad.numeral / 834).toBeCloseTo(phone.numeral / 440, 2);
  });

  it('keeps its words in the same band at the top and the bottom', () => {
    expect(displaySizes({ width: 834, height: 1210 }).edge).toBe(DISPLAY_PHONE.edge);
  });
});

describe('sized', () => {
  it('gives a size the line height it needs', () => {
    expect(sized(40)).toEqual({ fontSize: 40, lineHeight: 50 });
  });
});
