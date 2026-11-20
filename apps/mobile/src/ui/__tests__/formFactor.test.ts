// The interface scale (ui/formFactor): 1 on a phone, larger on an iPad, set once before any
// style module loads (index.ts imports ui/formFactorBoot first) and applied to every size token.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scaleFor,
  setUiScale,
  TABLET_MIN_SIDE,
  UI_SCALE_MAX,
  UI_SCALE_MIN_TABLET,
  uiScale,
} from '../formFactor';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

afterEach(() => {
  setUiScale(1);
  vi.resetModules();
});

describe('scaleFor', () => {
  it('is 1 on every phone, either way up', () => {
    for (const side of [320, 375, 393, 402, 440]) expect(scaleFor(side, false)).toBe(1);
    // a big phone is still a phone
    expect(scaleFor(900, false)).toBe(1);
  });

  it('is larger on an iPad, by its size, in steps of 0.05', () => {
    expect(scaleFor(744, true)).toBe(1.15); // mini
    expect(scaleFor(820, true)).toBe(1.3); // Air 11-inch
    expect(scaleFor(834, true)).toBe(1.3); // Pro 11-inch
    expect(scaleFor(1032, true)).toBe(UI_SCALE_MAX); // 13-inch
    for (const side of [744, 768, 820, 834, 1024, 1032]) {
      const k = scaleFor(side, true);
      expect(k).toBeGreaterThanOrEqual(UI_SCALE_MIN_TABLET);
      expect(k).toBeLessThanOrEqual(UI_SCALE_MAX);
      expect(Math.round(k * 20)).toBeCloseTo(k * 20, 6);
    }
  });

  it('is 1 for an iPad window that is phone-sized (Split View, Slide Over), or not measured', () => {
    expect(scaleFor(320, true)).toBe(1);
    expect(scaleFor(TABLET_MIN_SIDE - 1, true)).toBe(1);
    expect(scaleFor(0, true)).toBe(1);
    expect(scaleFor(Number.NaN, true)).toBe(1);
  });
});

describe('setUiScale', () => {
  it('keeps the scale between 1 and the maximum, and 1 for nonsense', () => {
    setUiScale(1.3);
    expect(uiScale()).toBe(1.3);
    setUiScale(9);
    expect(uiScale()).toBe(UI_SCALE_MAX);
    setUiScale(0.5);
    expect(uiScale()).toBe(1);
    setUiScale(Number.NaN);
    expect(uiScale()).toBe(1);
  });
});

describe('the tokens at a device scale', () => {
  const load = async (k: number) => {
    vi.resetModules();
    const ff = await import('../formFactor');
    ff.setUiScale(k);
    return import('../tokens');
  };

  it('are the phone sizes at 1 (what every other test, and every phone, sees)', async () => {
    const t = await load(1);
    expect(t.type.heading.fontSize).toBe(17);
    expect(t.space.page).toBe(20);
    expect(t.space.control).toBe(56);
    expect(t.radius.xl).toBe(32);
    expect(t.layout.maxContentWidth).toBe(540);
    expect(t.dp(100)).toBe(100);
  });

  it('are all larger on an iPad: type, spacing, controls, radii and the content column', async () => {
    const t = await load(1.3);
    expect(t.type.heading.fontSize).toBe(22);
    expect(t.type.heading.lineHeight).toBeGreaterThan(22);
    expect(t.type.balance.fontSize).toBe(73);
    expect(t.space.page).toBe(26);
    expect(t.space.control).toBe(73);
    expect(t.radius.xl).toBe(42);
    expect(t.avatarSize.vs).toBe(73);
    expect(t.layout.maxContentWidth).toBe(702);
    expect(t.dp(100)).toBe(130);
    // whole points, so nothing lands on a half pixel
    for (const v of Object.values(t.space)) expect(Number.isInteger(v)).toBe(true);
  });

  it('does not scale what is not a size: the pill radius, colours, durations, the tablet cut-off', async () => {
    const [phone, pad] = [await load(1), await load(1.3)];
    expect(pad.radius.pill).toBe(phone.radius.pill);
    expect(pad.palette).toEqual(phone.palette);
    expect(pad.motion.screenMs).toBe(phone.motion.screenMs);
    expect(pad.layout.tabletMinSide).toBe(phone.layout.tabletMinSide);
    expect(pad.type.heading.fontFamily).toBe(phone.type.heading.fontFamily);
  });
});

describe('the app entry', () => {
  it('sets the scale before anything else is imported', () => {
    const entry = readFileSync(resolve(MOBILE, 'index.ts'), 'utf8');
    const imports = [...entry.matchAll(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    );
    expect(imports[0]).toBe('./src/ui/formFactorBoot');
  });

  it('measures the window as the app starts, and only an iPad is ever scaled', () => {
    const boot = readFileSync(resolve(MOBILE, 'src/ui/formFactorBoot.ts'), 'utf8');
    expect(boot).toContain("Dimensions.get('window')");
    expect(boot).toContain("Platform.OS === 'ios' && Platform.isPad");
  });
});
