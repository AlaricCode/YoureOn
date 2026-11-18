import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_COLORS,
  border,
  color,
  displayScale,
  fontFamily,
  GRID,
  haptics,
  hold,
  MAX_MOMENT_MS,
  MAX_TRANSITION_MS,
  moneyColor,
  motion,
  palette,
  payout,
  radius,
  space,
  swatch,
  type,
  typeScale,
} from '../tokens';

const HEX = /^#[0-9A-F]{6}$/;
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
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
/** A neutral grey has r = g = b give or take a few (the near-blacks lean a touch cool). */
const chromatic = (hex: string) => {
  const c = channels(hex);
  return Math.max(...c) - Math.min(...c) > 12;
};
const rolesOf = (hex: string) =>
  Object.entries(color)
    .filter(([, v]) => v === hex)
    .map(([k]) => k)
    .sort();

describe('color: Obsidian (black, white, greys, one green, one red)', () => {
  it('every swatch and palette value is #RRGGBB', () => {
    for (const v of Object.values(palette)) expect(v).toMatch(HEX);
  });

  it('pins the swatches', () => {
    expect(swatch).toEqual({
      black: '#000000',
      raised: '#0F0F11',
      line: '#1C1C1F',
      white: '#FFFFFF',
      grey: '#8D8D93',
      dim: '#4A4A4F',
      green: '#00D47A',
      red: '#FF4F45',
    });
  });

  it('the semantic aliases sit on the named swatches; the background is pure black', () => {
    expect(palette).toMatchObject({
      background: swatch.black,
      surface: swatch.raised,
      fill: swatch.line,
      hairline: swatch.line,
      text: swatch.white,
      textSecondary: swatch.grey,
      textTertiary: swatch.dim,
      accent: swatch.green,
      danger: swatch.red,
      success: swatch.green,
    });
    expect(palette.background).toBe('#000000');
  });

  it('exactly two chromatic colours, green and red; everything else is neutral', () => {
    const hues = [...ALLOWED_COLORS].filter(chromatic).sort();
    expect(hues).toEqual([swatch.green, swatch.red].sort());
  });

  it('roles resolve to palette values only', () => {
    for (const v of Object.values(color)) expect(ALLOWED_COLORS.has(v)).toBe(true);
  });

  it('green is the action, selection, live, money up and online; nothing else', () => {
    expect(rolesOf(palette.green)).toEqual(
      [
        'accent',
        'borderFocused',
        'green',
        'live',
        'online',
        'positive',
        'primaryAction',
        'selected',
        'success',
      ].sort(),
    );
    expect(payout.deltaColor).toBe(palette.green);
  });

  it('red is money down, destructive and fixable problems; errors stay white', () => {
    expect(rolesOf(palette.red)).toEqual(
      ['danger', 'destructive', 'fixable', 'negative', 'red'].sort(),
    );
    expect(color.error).toBe(palette.text);
  });

  it('avatars are a grey disc (no per-person tints)', () => {
    expect(color.avatar).toBe(swatch.line);
    expect(chromatic(color.avatar)).toBe(false);
  });

  it('text on green and red fills is black, never white', () => {
    expect(color.onAccent).toBe(palette.black);
    expect(color.onSuccess).toBe(palette.black);
    expect(color.onDanger).toBe(palette.black);
  });

  it('clears contrast: white/black > 15, grey/black >= 4.5, black on green >= 4.5', () => {
    expect(ratio(palette.text, palette.background)).toBeGreaterThan(15);
    expect(ratio(palette.textSecondary, palette.background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(palette.textSecondary, palette.surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(palette.textSecondary, palette.fill)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(palette.text, palette.fill)).toBeGreaterThan(7);
    expect(ratio(color.onAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color.onDanger, palette.danger)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(palette.green, palette.background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(palette.red, palette.background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(palette.green, palette.fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('money direction picks the colour: up green, down red, flat white', () => {
    expect(moneyColor(500)).toBe(palette.green);
    expect(moneyColor(-1)).toBe(palette.red);
    expect(moneyColor(0)).toBe(palette.text);
  });
});

describe('type: Geist only, thin tabular figures', () => {
  const styles = Object.values(type);
  const families = new Set<string>(Object.values(fontFamily));

  it('every style uses a loaded Geist face, one family name per weight', () => {
    for (const s of styles) expect(families.has(s.fontFamily)).toBe(true);
    for (const f of families) expect(f).toMatch(/^Geist_\d00[A-Za-z]+$/);
    // The fallback weight matches the face, so the system font keeps the hierarchy.
    const weightOf: Record<string, string> = {
      Geist_300Light: '300',
      Geist_400Regular: '400',
      Geist_500Medium: '500',
      Geist_600SemiBold: '600',
    };
    expect(Object.keys(weightOf).sort()).toEqual([...families].sort());
    for (const s of styles) expect(s.fontWeight).toBe(weightOf[s.fontFamily]);
  });

  it('ui/fonts loads exactly the families the tokens name, from the matching files', () => {
    const src = readFileSync(fileURLToPath(new URL('../fonts.ts', import.meta.url)), 'utf8');
    for (const name of Object.values(fontFamily)) {
      expect(src).toMatch(
        new RegExp(`import ${name} from '@expo-google-fonts/geist/[^']+/${name}\\.ttf'`),
      );
      expect(src).toMatch(new RegExp(`^\\s+${name},$`, 'm'));
    }
    expect(src.match(/\.ttf'/g)).toHaveLength(families.size);
    expect(src).not.toMatch(/big-shoulders|instrument-sans/);
  });

  it('UI sizes come from 13/15/17/22/28; display sizes 34/44/56 are Light/Regular figures only', () => {
    for (const s of styles) {
      expect([...typeScale, ...displayScale]).toContain(s.fontSize);
      if ((displayScale as readonly number[]).includes(s.fontSize)) {
        expect([fontFamily.light, fontFamily.regular]).toContain(s.fontFamily);
        expect(s.fontVariant).toEqual(['tabular-nums']);
      }
      expect(ALLOWED_COLORS.has(s.color)).toBe(true);
    }
    const used = new Set(styles.map((s) => s.fontSize));
    for (const size of [...typeScale, ...displayScale]) expect(used).toContain(size);
  });

  it('money and big numbers are big, thin, tabular and tightly tracked', () => {
    for (const k of ['balance', 'money', 'moment', 'momentSmall', 'display', 'figure'] as const) {
      expect(type[k].fontFamily).toBe(fontFamily.light);
      expect(type[k].fontVariant).toEqual(['tabular-nums']);
      expect(type[k].letterSpacing).toBeLessThan(0);
    }
    expect(type.amount.fontVariant).toEqual(['tabular-nums']);
    expect(type.balance.fontSize).toBe(56);
    expect(type.money.fontSize).toBe(56);
    expect(type.moment.fontSize).toBeGreaterThanOrEqual(44);
  });

  it('headings 600, body 400, labels 500; small UI type is untracked with room to breathe', () => {
    expect(type.title).toMatchObject({ fontFamily: fontFamily.semibold, fontSize: 28 });
    expect(type.heading.fontFamily).toBe(fontFamily.semibold);
    expect(type.button).toMatchObject({ fontFamily: fontFamily.semibold, fontSize: 17 });
    expect(type.body.fontFamily).toBe(fontFamily.regular);
    expect(type.labelMedium.fontFamily).toBe(fontFamily.medium);
    for (const s of styles) {
      if (s.fontSize <= 17) expect(s.letterSpacing).toBe(0);
      else expect(s.letterSpacing).toBeLessThanOrEqual(0);
      expect(s.lineHeight).toBeGreaterThanOrEqual(s.fontSize);
      expect(s.lineHeight).toBeLessThanOrEqual(Math.ceil(s.fontSize * 1.5));
    }
  });
});

describe('space and shape', () => {
  it('every spacing token sits on the 4-pt grid; the page margin is 20', () => {
    for (const v of Object.values(space)) expect(v % GRID).toBe(0);
    expect(space.page).toBe(20);
  });

  it('controls are 56 pt pills; inputs radius 14; sheets radius 20; focus is a 1 pt border', () => {
    expect(space.control).toBe(56);
    expect(radius.pill).toBe(999);
    expect(radius.md).toBe(14);
    expect(radius.lg).toBe(20);
    expect(border.focused).toBe(1);
  });
});

describe('motion and timing', () => {
  it('transitions are <= 200 ms, ease-out, no springs; the one moment reveal is <= 300 ms', () => {
    expect(motion.fastMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(hold.releaseMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(payout.revealMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(MAX_MOMENT_MS).toBe(300);
    expect(motion.momentMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
    expect(motion.momentFromScale).toBeGreaterThanOrEqual(0.9);
    expect(motion.momentFromScale).toBeLessThan(1);
    expect(motion.momentRise).toBeGreaterThan(0);
    expect(motion.momentRise).toBeLessThanOrEqual(16);
    expect(motion.spring).toBe(false);
    expect(motion.easing).toEqual([0, 0, 0.58, 1]);
  });

  it('pins the contract timings: hold 800 ms / 24 pt, payout reverts after 5 s', () => {
    expect(hold).toMatchObject({ durationMs: 800, maxDistance: 24, releaseMs: 150 });
    expect(payout).toMatchObject({ countUpMs: 600, revealMs: 150, revertAfterMs: 5_000 });
    expect(payout.pendingColor).toBe(palette.textSecondary);
    expect(payout.settledColor).toBe(palette.text);
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
