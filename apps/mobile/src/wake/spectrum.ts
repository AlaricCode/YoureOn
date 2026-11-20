// The "Jarvis" rainbow loop: the pure maths behind RainbowLoop, kept free of react-native so
// vitest can load it in Node. The functions the UI thread calls every frame are worklets.
//
// The loop is one rounded rectangle hugging the physical screen edge, drawn N times. Copy i is a
// single hue and a single dash: `strokeDasharray = [seg + overlap, L - seg - overlap]` (the two
// add up to the perimeter L, so each copy shows exactly one dash per lap) placed at arclength
// `i * seg + phase * L`. Advancing `phase` (turns, 0..1) slides every dash clockwise together, so
// the spectrum flows around the edge; one full turn is the same picture, so the wrap is seamless.
// Neighbouring dashes overlap by `overlap` pt (butt caps) and the later one paints on top, so the
// anti-aliased ends never leave a dark hairline between two hues.
//
// Colour: the Limelight palette is black, white, greys, one green, one red (ui/tokens). Voice
// activation is the one place the full spectrum is allowed; the colours are computed here as
// rgb() strings from a hue wheel, never as hex literals scattered through screens.

import { MAX_TRANSITION_MS, motion, spectrum } from '../ui/tokens';

// ---------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------

export const LOOP = {
  /** Corner radius when the display is not in the table below (props override). */
  defaultCornerRadius: 48,
  /** Hue copies in the crisp core (10 degrees apart) and the soft glow (15 degrees apart). */
  coreSegments: 36,
  glowSegments: 24,
  /** How far each dash runs into the next hue (pt), hiding the anti-aliased seam. */
  overlap: 1.5,
  /**
   * Stroke widths. The path runs ON the physical edge (inset 0) so it follows the display's
   * corners exactly; half of every stroke falls off the glass, so the visible band is half of
   * each width: a 3.5 pt crisp line, an 11 pt glow, a 24 pt halo.
   */
  coreWidth: 7,
  glowWidth: 22,
  haloWidth: 48,
  /** The halo's opacity inside the glow layer (the glow itself is opaque there). */
  haloOpacity: 0.4,
  /** The hue wheel (ui/tokens spectrum): vivid, a touch light so blue does not sink on black. */
  saturation: spectrum.saturation,
  lightness: spectrum.lightness,
  /** One full lap of the spectrum. Listening sweeps faster than thinking. */
  listeningTurnMs: 3200,
  thinkingTurnMs: 7000,
  /** A frame longer than this (a stall) advances the loop by this much, not by a jump. */
  maxFrameMs: 50,
  /** The glow breathes (sine in-out, there and back) over this, each way. */
  breathMs: 1400,
  /** Glow layer opacity [at rest, at the top of a breath] per mode. */
  glowListening: [0.34, 0.55],
  glowThinking: [0.2, 0.3],
  /** Core layer opacity per mode. */
  coreListening: 1,
  coreThinking: 0.75,
  /** Activation is a moment: the loop arrives over one moment reveal. */
  fadeInMs: motion.momentMs,
  /** It leaves, and modes cross over, within one standard transition. */
  fadeOutMs: MAX_TRANSITION_MS,
  modeMs: MAX_TRANSITION_MS,
  /** Above every screen, sheet and toast. */
  zIndex: 1000,
} as const;

// ---------------------------------------------------------------------------------------
// Small worklet helpers
// ---------------------------------------------------------------------------------------

export function clamp01(v: number): number {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function mix(a: number, b: number, t: number): number {
  'worklet';
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------------------
// Display corners
// ---------------------------------------------------------------------------------------

/**
 * Approximate display corner radii (pt) by logical screen size, short side x long side. Where
 * two models share a size the larger radius wins: a slightly larger arc sits a hair inside the
 * glass at the corner instead of being clipped by it.
 */
const DISPLAY_CORNERS: Readonly<Record<string, number>> = {
  // Home-button phones: square glass.
  '320x568': 0,
  '375x667': 0,
  '414x736': 0,
  // X, XS, 11 Pro (39); 12 mini, 13 mini (44).
  '375x812': 44,
  // XR, 11 (41.5); XS Max, 11 Pro Max (39).
  '414x896': 41.5,
  // 12, 12 Pro, 13, 13 Pro, 14.
  '390x844': 47.33,
  // 12 Pro Max, 13 Pro Max, 14 Plus.
  '428x926': 53.33,
  // 14 Pro, 15, 15 Pro, 16.
  '393x852': 55,
  // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus.
  '430x932': 55,
  // 16 Pro, 17, 17 Pro.
  '402x874': 62,
  // 16 Pro Max, 17 Pro Max.
  '440x956': 62,
};

/** iPads: rounded glass, a much smaller radius. */
const TABLET_CORNER = 18;
const TABLET_MIN_SIDE = 600;

/** The display's corner radius for a `width` x `height` (pt) screen, either orientation. */
export function displayCornerRadius(width: number, height: number): number {
  const short = Math.round(Math.min(width, height));
  const long = Math.round(Math.max(width, height));
  const known = DISPLAY_CORNERS[`${short}x${long}`];
  if (known !== undefined) return known;
  if (short >= TABLET_MIN_SIDE) return TABLET_CORNER;
  return LOOP.defaultCornerRadius;
}

// ---------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------

export type LoopGeometry = {
  /** The SVG path: starts at the top centre, runs clockwise, closes. Empty when degenerate. */
  readonly d: string;
  /** Its perimeter in pt (0 when degenerate). */
  readonly length: number;
  /** The corner radius actually used (clamped to fit, and to the inset). */
  readonly radius: number;
};

/** A path number: at most 3 decimals, no trailing zeros, never "-0". */
export function fmt(n: number): string {
  const v = Math.round(n * 1000) / 1000;
  return String(v === 0 ? 0 : v);
}

/**
 * The perimeter of a `w` x `h` rounded rectangle with corner radius `r` (r clamped to
 * [0, min(w, h) / 2]): four straight runs plus one full circle.
 */
export function roundedRectPerimeter(w: number, h: number, r: number): number {
  if (!(w > 0) || !(h > 0)) return 0;
  const rr = Math.min(Math.max(r, 0), w / 2, h / 2);
  return 2 * (w - 2 * rr) + 2 * (h - 2 * rr) + 2 * Math.PI * rr;
}

/**
 * The loop's path for a `width` x `height` canvas whose display corners have radius `radius`,
 * pulled in by `inset` on every side (the corner radius shrinks by the inset too, so the path
 * stays concentric with the glass). Starts at the top centre and runs clockwise (screen
 * coordinates, y down): the sweep flag 1 on every arc.
 */
export function loopGeometry(
  width: number,
  height: number,
  radius: number,
  inset = 0,
): LoopGeometry {
  const x0 = inset;
  const y0 = inset;
  const x1 = width - inset;
  const y1 = height - inset;
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { d: '', length: 0, radius: 0 };
  }
  const r = Math.min(Math.max(radius - inset, 0), w / 2, h / 2);
  // The dash that crosses the path start is drawn as two butt-capped pieces meeting there.
  // Put that split on a whole point (a whole pixel at every scale) so it never lands on a
  // half-covered pixel column, which would composite to a faint hairline (width 393 / 430).
  // Kept on the top straight run so a radius clamped to half an odd width never runs backwards.
  const cx = Math.min(Math.max(Math.round(width / 2), x0 + r), x1 - r);
  const f = fmt;
  const d =
    r > 0
      ? [
          `M${f(cx)} ${f(y0)}`,
          `H${f(x1 - r)}`,
          `A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y0 + r)}`,
          `V${f(y1 - r)}`,
          `A${f(r)} ${f(r)} 0 0 1 ${f(x1 - r)} ${f(y1)}`,
          `H${f(x0 + r)}`,
          `A${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(y1 - r)}`,
          `V${f(y0 + r)}`,
          `A${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(y0)}`,
          'Z',
        ].join(' ')
      : [`M${f(cx)} ${f(y0)}`, `H${f(x1)}`, `V${f(y1)}`, `H${f(x0)}`, `V${f(y0)}`, 'Z'].join(' ');
  return { d, length: roundedRectPerimeter(w, h, r), radius: r };
}

// ---------------------------------------------------------------------------------------
// Segments (dashes)
// ---------------------------------------------------------------------------------------

export type LoopSegment = {
  /** Where this hue's dash starts at phase 0 (pt along the path from the top centre). */
  readonly start: number;
  /** [dash, gap]; the two add up to the perimeter, so one dash per lap. */
  readonly dash: readonly [number, number];
};

/**
 * `n` equal dashes covering a loop of `length` pt, each running `overlap` pt into the next.
 * The dash never exceeds the whole loop (one segment, or an overlap larger than the gap).
 */
export function segmentDashes(
  length: number,
  n: number,
  overlap: number = LOOP.overlap,
): LoopSegment[] {
  const count = Math.max(1, Math.floor(n));
  if (!(length > 0)) return [];
  const seg = length / count;
  const on = Math.min(seg + Math.max(overlap, 0), length);
  const off = length - on;
  const out: LoopSegment[] = [];
  for (let i = 0; i < count; i++) out.push({ start: i * seg, dash: [on, off] });
  return out;
}

/**
 * The strokeDashoffset that puts a dash starting at `start` (pt, phase 0) where it is after
 * `phase` turns of a `length` pt loop. Always in [0, length): CoreGraphics' dash phase is not
 * defined for negative values, and any multiple of the (length-long) pattern is the same picture.
 */
export function dashOffset(start: number, phase: number, length: number): number {
  'worklet';
  if (!(length > 0)) return 0;
  // Where the dash starts now, wrapped into [0, length).
  let at = (start + phase * length) % length;
  if (at < 0) at += length;
  // An offset o shows the pattern's start at arclength -o (mod length): o = length - at.
  const o = length - at;
  return o >= length ? 0 : o;
}

// ---------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------

/**
 * The loop's phase (turns, [0, 1)) one frame later. `level` is the mode mix: 1 listening, 0
 * thinking (in between while they cross over, so the speed glides instead of jumping). A missing
 * or negative frame time adds nothing; a stall adds at most `maxFrameMs`.
 */
export function advancePhase(phase: number, dtMs: number | null, level: number): number {
  'worklet';
  const dt = dtMs == null || !(dtMs > 0) ? 0 : dtMs > LOOP.maxFrameMs ? LOOP.maxFrameMs : dtMs;
  const turnMs = mix(LOOP.thinkingTurnMs, LOOP.listeningTurnMs, clamp01(level));
  let next = (phase + dt / turnMs) % 1;
  if (next < 0) next += 1;
  return next;
}

/** The glow layer's opacity for a breath (0..1) and mode mix (1 listening, 0 thinking). */
export function glowOpacity(breath: number, level: number): number {
  'worklet';
  const b = clamp01(breath);
  const listening = mix(LOOP.glowListening[0], LOOP.glowListening[1], b);
  const thinking = mix(LOOP.glowThinking[0], LOOP.glowThinking[1], b);
  return mix(thinking, listening, clamp01(level));
}

/** The core layer's opacity for a mode mix (1 listening, 0 thinking). */
export function coreOpacity(level: number): number {
  'worklet';
  return mix(LOOP.coreThinking, LOOP.coreListening, clamp01(level));
}

// ---------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------

export type SpectrumOptions = {
  /** 0..1. Default LOOP.saturation. */
  saturation?: number;
  /** 0..1. Default LOOP.lightness. */
  lightness?: number;
  /** The hue (degrees) at the top centre, where the loop starts. Default 0 (red). */
  hueStart?: number;
};

/** HSL (hue in degrees, any range; s and l 0..1) to 8-bit sRGB channels. */
export function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  const sat = clamp01(s);
  const lig = clamp01(l);
  if (sat === 0) {
    const v = Math.round(lig * 255);
    return [v, v, v];
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/** The spectrum's colour `t` turns around the loop (any real t; 1 turn is the same colour). */
export function spectrumColor(t: number, opts: SpectrumOptions = {}): string {
  // Wrapped into [0, 1) and snapped to 1e-9 of a turn, so the same place reached two ways
  // (0.5 / n and (n + 0.5) / n, say) cannot round to two different 8-bit channels.
  const turns = Math.round((((t % 1) + 1) % 1) * 1e9) / 1e9;
  const [r, g, b] = hslToRgb(
    (opts.hueStart ?? 0) + turns * 360,
    opts.saturation ?? LOOP.saturation,
    opts.lightness ?? LOOP.lightness,
  );
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * `n` colours evenly around the hue wheel, one per segment, each the hue at its segment's middle
 * (so a coarse glow and a fine core agree on where each hue sits). The last wraps into the first
 * by the same step as every other neighbour: no seam.
 */
export function spectrumColors(n: number, opts: SpectrumOptions = {}): string[] {
  const count = Math.max(1, Math.floor(n));
  return Array.from({ length: count }, (_, i) => spectrumColor((i + 0.5) / count, opts));
}
