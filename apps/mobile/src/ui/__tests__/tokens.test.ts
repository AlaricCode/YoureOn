import { describe, expect, it } from 'vitest';

import {
  ALLOWED_COLORS,
  color,
  GRID,
  haptics,
  hold,
  MAX_TRANSITION_MS,
  motion,
  palette,
  payout,
  space,
  type,
  typeScale,
} from '../tokens';

const HEX = /^#[0-9A-F]{6}$/;
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const isGrey = (hex: string) => {
  const [r, g, b] = channels(hex) as [number, number, number];
  return Math.max(r, g, b) - Math.min(r, g, b) <= 8;
};

describe('color: monochrome with one accent and one red', () => {
  it('every palette value is #RRGGBB; all but the accent and danger are greys', () => {
    const chromatic = Object.entries(palette).filter(([, v]) => !isGrey(v));
    for (const v of Object.values(palette)) expect(v).toMatch(HEX);
    expect(chromatic).toEqual([
      ['accent', palette.accent],
      ['danger', palette.danger],
    ]);
  });

  it('red is only for destructive actions and fixable capture problems', () => {
    const redRoles = Object.entries(color)
      .filter(([, v]) => v === palette.danger)
      .map(([k]) => k)
      .sort();
    expect(redRoles).toEqual(['danger', 'destructive', 'fixable']);
    expect(color.error).toBe(palette.text);
  });

  it('semantic roles resolve to palette values only, and only primary action / live use the accent', () => {
    for (const v of Object.values(color)) expect(ALLOWED_COLORS.has(v)).toBe(true);
    const accentRoles = Object.entries(color)
      .filter(([, v]) => v === palette.accent)
      .map(([k]) => k)
      .sort();
    expect(accentRoles).toEqual(['accent', 'live', 'primaryAction']);
  });

  it('text on background clears WCAG AA', () => {
    const lum = (hex: string) => {
      const [r, g, b] = channels(hex).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(ratio(palette.text, palette.background)).toBeGreaterThan(7);
    expect(ratio(palette.textSecondary, palette.background)).toBeGreaterThan(4.5);
  });
});

describe('type: one family, two weights, the 13/15/17/22/28 scale', () => {
  it('uses only scale sizes and two weights', () => {
    const styles = Object.values(type);
    expect(new Set(styles.map((s) => s.fontWeight))).toEqual(new Set(['400', '600']));
    for (const s of styles) {
      expect(typeScale).toContain(s.fontSize);
      expect(s.lineHeight).toBeGreaterThanOrEqual(s.fontSize);
      expect(ALLOWED_COLORS.has(s.color)).toBe(true);
    }
    expect(new Set(styles.map((s) => s.fontSize))).toEqual(new Set(typeScale));
  });
});

describe('space: 8-pt grid', () => {
  it('every spacing token is a multiple of 8', () => {
    for (const v of Object.values(space)) expect(v % GRID).toBe(0);
  });
});

describe('motion and timing', () => {
  it('transitions are <= 200 ms, ease-out, no springs', () => {
    expect(motion.fastMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(hold.releaseMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(payout.revealMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(motion.spring).toBe(false);
    expect(motion.easing).toEqual([0, 0, 0.58, 1]);
  });

  it('pins the contract timings: hold 800 ms / 24 pt, payout reverts after 5 s', () => {
    expect(hold).toMatchObject({ durationMs: 800, maxDistance: 24 });
    expect(payout.revertAfterMs).toBe(5_000);
    expect(payout.pendingColor).toBe(palette.textSecondary);
  });
});

describe('haptics: named tokens', () => {
  it('LOCKED is a double haptic; every pattern starts at 0 and is ordered', () => {
    expect(haptics.locked).toHaveLength(2);
    for (const pattern of Object.values(haptics)) {
      expect(pattern[0]?.atMs).toBe(0);
      const times = pattern.map((p) => p.atMs);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('uses expo-haptics string values only', () => {
    const impact = ['light', 'medium', 'heavy', 'soft', 'rigid'];
    const notification = ['success', 'warning', 'error'];
    for (const pattern of Object.values(haptics))
      for (const { haptic } of pattern) {
        if (haptic.kind === 'impact') expect(impact).toContain(haptic.style);
        else if (haptic.kind === 'notification') expect(notification).toContain(haptic.type);
        else expect(haptic.kind).toBe('selection');
      }
  });
});
