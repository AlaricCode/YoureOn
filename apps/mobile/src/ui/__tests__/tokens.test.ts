import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_COLORS,
  aurora,
  border,
  color,
  displayScale,
  fontFamily,
  GRID,
  haptics,
  hold,
  material,
  MAX_MOMENT_MS,
  MAX_TRANSITION_MS,
  moneyColor,
  motion,
  orb,
  palette,
  payout,
  radius,
  scrub,
  skeleton,
  space,
  spectrum,
  swatch,
  swipe,
  ticker,
  type,
  typeScale,
  voiceScale,
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

describe('color: Limelight (black, white, greys, one green, one red)', () => {
  it('every swatch and palette value is #RRGGBB', () => {
    for (const v of Object.values(palette)) expect(v).toMatch(HEX);
  });

  it('pins the swatches', () => {
    expect(swatch).toEqual({
      black: '#000000',
      raised: '#0F0F11',
      line: '#1C1C1F',
      edge: '#2A2A2E',
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
      rim: swatch.edge,
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

  it('the voice spectrum is a reserved exception, not a palette colour', () => {
    expect(spectrum.reservedFor).toBe('voice-activation');
    expect(Object.keys(palette)).not.toContain('spectrum');
    expect(Object.keys(color)).not.toContain('spectrum');
  });

  it('roles resolve to palette values only', () => {
    for (const v of Object.values(color)) expect(ALLOWED_COLORS.has(v)).toBe(true);
  });

  it('white asks: the primary action, a selection and focus are white with black ink', () => {
    expect(color.primaryAction).toBe(palette.white);
    expect(color.selected).toBe(palette.white);
    expect(color.borderFocused).toBe(palette.white);
    expect(color.onPrimary).toBe(palette.black);
    expect(ratio(color.onPrimary, color.primaryAction)).toBeGreaterThan(15);
  });

  it('green answers: on, live, money up, online and the one commit control; never a plain action', () => {
    expect(rolesOf(palette.green)).toEqual(
      ['accent', 'commit', 'green', 'live', 'online', 'positive', 'success'].sort(),
    );
    expect(payout.deltaColor).toBe(palette.green);
  });

  it('red is money down, destructive and fixable problems; errors stay white', () => {
    expect(rolesOf(palette.red)).toEqual(
      ['danger', 'destructive', 'fixable', 'negative', 'red'].sort(),
    );
    expect(color.error).toBe(palette.text);
  });

  it('the glass rim is a neutral one step brighter than the fill it outlines', () => {
    expect(chromatic(palette.rim)).toBe(false);
    expect(lum(palette.rim)).toBeGreaterThan(lum(palette.fill));
    expect(lum(palette.rim)).toBeLessThan(lum(palette.textTertiary));
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

describe('type: two voices, Geist to operate and Instrument Serif for what is said', () => {
  const styles = Object.values(type);
  const families = new Set<string>(Object.values(fontFamily));
  const serif: readonly string[] = [fontFamily.voice, fontFamily.voiceItalic];
  const isSerif = (s: { fontFamily: string }) => serif.includes(s.fontFamily);

  it('every style uses a loaded face, one family name per face', () => {
    for (const s of styles) expect(families.has(s.fontFamily)).toBe(true);
    // The fallback weight matches the face, so the system font keeps the hierarchy.
    const weightOf: Record<string, string> = {
      Geist_300Light: '300',
      Geist_400Regular: '400',
      Geist_500Medium: '500',
      Geist_600SemiBold: '600',
      InstrumentSerif_400Regular: '400',
      InstrumentSerif_400Regular_Italic: '400',
    };
    expect(Object.keys(weightOf).sort()).toEqual([...families].sort());
    for (const s of styles) expect(s.fontWeight).toBe(weightOf[s.fontFamily]);
  });

  it('ui/fonts loads exactly the families the tokens name, from the matching files', () => {
    const src = readFileSync(fileURLToPath(new URL('../fonts.ts', import.meta.url)), 'utf8');
    for (const name of Object.values(fontFamily)) {
      // Geist from its package (one folder per weight); the serif from the vendored files.
      const from = name.startsWith('Geist_')
        ? `@expo-google-fonts/geist/[^']+/${name}\\.ttf`
        : `\\.\\./\\.\\./assets/fonts/${name}\\.ttf`;
      expect(src).toMatch(new RegExp(`import ${name} from '${from}'`));
      expect(src).toMatch(new RegExp(`^\\s+${name},$`, 'm'));
    }
    expect(src.match(/\.ttf'/g)).toHaveLength(families.size);
    expect(src).not.toMatch(/big-shoulders|instrument-sans/);
  });

  it('the vendored serif ships with its licence', () => {
    const asset = (name: string) =>
      readFileSync(fileURLToPath(new URL(`../../../assets/fonts/${name}`, import.meta.url)));
    for (const face of serif) expect(asset(`${face}.ttf`).length).toBeGreaterThan(10_000);
    expect(asset('OFL-InstrumentSerif.txt').toString('utf8')).toMatch(/SIL Open Font License/);
  });

  it('Geist sizes come from 13/15/17/22/28 (UI) and 34/44/56 (thin tabular figures)', () => {
    for (const s of styles.filter((x) => !isSerif(x))) {
      expect([...typeScale, ...displayScale]).toContain(s.fontSize);
      if ((displayScale as readonly number[]).includes(s.fontSize)) {
        expect([fontFamily.light, fontFamily.regular]).toContain(s.fontFamily);
        expect(s.fontVariant).toEqual(['tabular-nums']);
      }
    }
    for (const s of styles) expect(ALLOWED_COLORS.has(s.color)).toBe(true);
    const used = new Set(styles.map((s) => s.fontSize));
    for (const size of [...typeScale, ...displayScale, ...voiceScale]) expect(used).toContain(size);
  });

  it('the serif is a display face: never under 22, never a figure, tight only when large', () => {
    for (const s of styles.filter(isSerif)) {
      expect(voiceScale).toContain(s.fontSize);
      expect(s.fontSize).toBeGreaterThanOrEqual(22);
      expect('fontVariant' in s).toBe(false);
      if (s.fontSize < 40) expect(s.letterSpacing).toBe(0);
      else expect(s.letterSpacing).toBeLessThan(0);
    }
  });

  it('what is said is in the serif: moments, the claim, the judge, the wordmark', () => {
    for (const k of ['moment', 'momentSmall', 'endTitle', 'statement', 'statementSmall'] as const)
      expect(type[k].fontFamily).toBe(fontFamily.voice);
    for (const k of ['spoken', 'spokenSmall', 'wordmark', 'hero'] as const)
      expect(type[k].fontFamily).toBe(fontFamily.voiceItalic);
    expect(type.moment.fontSize).toBeGreaterThan(type.momentSmall.fontSize);
    expect(type.momentSmall.fontSize).toBeGreaterThan(type.endTitle.fontSize);
  });

  it('money and big numbers are big, thin, tabular and tightly tracked', () => {
    for (const k of ['balance', 'money', 'display', 'figure'] as const) {
      expect(type[k].fontFamily).toBe(fontFamily.light);
      expect(type[k].fontVariant).toEqual(['tabular-nums']);
      expect(type[k].letterSpacing).toBeLessThan(0);
    }
    expect(type.amount.fontVariant).toEqual(['tabular-nums']);
    expect(type.balance.fontSize).toBe(56);
    expect(type.money.fontSize).toBe(56);
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

  it('controls are 56 pt pills; inputs radius 14; the stage 20; glass objects 28; focus 1 pt', () => {
    expect(space.control).toBe(56);
    expect(radius.pill).toBe(999);
    expect(radius.md).toBe(14);
    expect(radius.lg).toBe(20);
    expect(radius.xl).toBe(28);
    expect(border.focused).toBe(1);
  });
});

describe('materials and light', () => {
  const hexes = (s: string) => s.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
  const alphas = (s: string) =>
    [...s.matchAll(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/g)].map((m) => ({
      rgb: `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`,
      a: Number(m[4]),
    }));

  it('glass is neutral, lit from the top, and never brighter than its rim', () => {
    for (const fill of [material.glass, material.glassRaised, material.disc]) {
      const stops = hexes(fill);
      expect(stops.length).toBeGreaterThanOrEqual(2);
      for (const c of stops) expect(chromatic(c.toUpperCase())).toBe(false);
      const lums = stops.map((c) => lum(c.toUpperCase()));
      expect([...lums].sort((a, b) => b - a)).toEqual(lums);
    }
    const top = lum((hexes(material.glass)[0] as string).toUpperCase());
    expect(top).toBeLessThan(lum(palette.rim));
  });

  it('light is only white or the palette green, always at an alpha', () => {
    const green = palette.green.toLowerCase();
    for (const [name, value] of Object.entries(material)) {
      for (const { rgb, a } of alphas(value)) {
        expect(a, name).toBeGreaterThan(0);
        expect(a, name).toBeLessThan(1);
        expect(['#ffffff', green], name).toContain(rgb);
      }
    }
    for (const k of ['bloomOn', 'ringOn'] as const)
      expect(alphas(material[k]).every((c) => c.rgb === green)).toBe(true);
    expect(alphas(material.bloomPrimary).every((c) => c.rgb === '#ffffff')).toBe(true);
  });

  it('the aurora hangs from above the screen, runs past both sides, and the loss is quieter', () => {
    expect(aurora.width).toBeGreaterThan(1);
    expect(aurora.top).toBeLessThan(0);
    expect(aurora.top + aurora.height).toBeGreaterThan(0.4);
    expect(aurora.top + aurora.height).toBeLessThan(0.7);
    expect(aurora.lossOpacity).toBeLessThan(aurora.opacity);
    expect(aurora.neutralOpacity).toBeLessThan(aurora.lossOpacity);
    expect(aurora.fadeMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
  });

  it('the aurora swells slowly and slightly: light, not an animation', () => {
    expect(aurora.swellMs).toBeGreaterThanOrEqual(3_000);
    expect(aurora.swellTo).toBeGreaterThan(1);
    expect(aurora.swellTo).toBeLessThanOrEqual(1.1);
    expect(aurora.swellDim).toBeGreaterThanOrEqual(0.7);
    expect(aurora.swellDim).toBeLessThan(1);
  });

  it('the judge orb is shaded from a white highlight to a near-black rim and breathes gently', () => {
    const offsets = orb.stops.map(([o]) => o);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(1);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    const lums = orb.stops.map(([, c]) => lum(c));
    expect([...lums].sort((a, b) => b - a)).toEqual(lums);
    expect(orb.stops[0]?.[1]).toBe('#FFFFFF');
    expect(orb.breatheTo).toBeGreaterThan(1);
    expect(orb.breatheTo).toBeLessThanOrEqual(1.06);
    expect(orb.speakTo).toBeGreaterThan(orb.breatheTo);
    expect(orb.speakTo).toBeLessThanOrEqual(1.1);
    expect(orb.speakMs).toBeLessThan(orb.breatheMs);
    expect([...orb.rings].sort((a, b) => a - b)).toEqual(orb.rings);
    for (const r of orb.rings) expect(r).toBeGreaterThan(1);
    expect(orb.haloSize).toBeGreaterThanOrEqual(orb.rings.at(-1) as number);
  });
});

describe('motion and timing', () => {
  it('transitions are <= 200 ms, ease-out; the one moment reveal is <= 300 ms', () => {
    expect(motion.fastMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(hold.releaseMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(payout.revealMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(MAX_MOMENT_MS).toBe(300);
    expect(motion.momentMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
    expect(motion.momentFromScale).toBeGreaterThanOrEqual(0.9);
    expect(motion.momentFromScale).toBeLessThan(1);
    expect(motion.momentRise).toBeGreaterThan(0);
    expect(motion.momentRise).toBeLessThanOrEqual(16);
    expect(motion.easing).toEqual([0, 0, 0.58, 1]);
  });

  it('the one spring settles a released gesture: critically damped and clamped (no bounce)', () => {
    expect(motion.spring).toBe('gesture-settle');
    const { damping, stiffness, mass, overshootClamping } = motion.settle;
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeGreaterThanOrEqual(1);
    expect(overshootClamping).toBe(true);
  });

  it('gesture and polish transitions stay inside the motion budget', () => {
    for (const ms of [
      motion.pressInMs,
      motion.pressOutMs,
      swipe.nudgeMs,
      swipe.armMs,
      swipe.pressInMs,
      swipe.pressOutMs,
      scrub.glideMs,
      scrub.fadeMs,
      ticker.colorMs,
      ticker.leadMs,
    ]) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    }
    expect(swipe.bobMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
    for (const s of [motion.pressScale, motion.chipPressScale, swipe.pressScale]) {
      expect(s).toBeGreaterThanOrEqual(0.9);
      expect(s).toBeLessThan(1);
    }
  });

  it('a money roll is the payout count-up; a price tick is one moment at most', () => {
    expect(ticker.rollMs).toBe(payout.countUpMs);
    expect(ticker.tickMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
    expect(ticker.minScale).toBeGreaterThan(0);
    expect(ticker.minScale).toBeLessThan(1);
  });

  it('the swipe arms after a deliberate thumb travel, not a twitch', () => {
    expect(swipe.travel).toBeGreaterThanOrEqual(56);
    expect(swipe.travel).toBeLessThanOrEqual(96);
    expect(swipe.activateOffset).toBeLessThan(swipe.travel);
    expect(swipe.flingMinProgress).toBeGreaterThanOrEqual(0.5);
    expect([...swipe.ticks].sort()).toEqual(swipe.ticks);
    for (const t of swipe.ticks) expect(t > 0 && t < 1).toBe(true);
  });

  it('skeleton pulses in opacity only, never fully out', () => {
    expect(skeleton.low).toBeGreaterThan(0.3);
    expect(skeleton.low).toBeLessThan(1);
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
