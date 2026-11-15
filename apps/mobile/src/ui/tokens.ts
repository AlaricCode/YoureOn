// You're On design tokens. Ported from Verdict app/lib/ui/tokens.dart, app/lib/ui/theme.dart and
// verdict-spec.md §6.2-§6.4 (docs/CONTRACTS.md §12.12), re-expressed as plain React Native style
// values. Monochrome, dark, ONE accent reserved for the primary action and live state.
//
// Pure TS on purpose: no react-native / expo imports, so vitest can load it in Node and every
// screen gets the same numbers. Haptics are named tokens only; the call site maps them to
// expo-haptics (whose enum values are these same strings: 'light', 'success', ...).
//
// Timing sources from OUR contracts: HoldToConfirm 800 ms / maxDistance 24 (TASKS D1-M5); the
// payout animation fires at `processed` and reverts if not confirmed within 5 s (SCHEMAS X10,
// API-CONTRACT §6.2, ARCHITECTURE §5.2); LOCKED is a double haptic on both phones (ARCHITECTURE §5.2).

// ---------------------------------------------------------------------------------------
// Color: monochrome + one accent (Verdict Palette)
// ---------------------------------------------------------------------------------------

export const palette = {
  background: '#0B0B0C',
  surface: '#141416',
  hairline: '#26262A',
  text: '#EDEDEF',
  textSecondary: '#8A8A8F',
  /** The only accent: the primary action and the live dot. Nothing else. */
  accent: '#5E6AD2',
} as const;

/** Semantic roles. Every role resolves to a palette value; there is no second hue. */
export const color = {
  ...palette,
  onAccent: palette.text,
  /** Errors are short noun phrases in the text color, never red (Verdict theme: error = text). */
  error: palette.text,
  divider: palette.hairline,
  border: palette.hairline,
  borderFocused: palette.textSecondary,
  /** The balance shown "+$" at processed, before confirmation (ARCHITECTURE §5.2). */
  pending: palette.textSecondary,
  live: palette.accent,
  primaryAction: palette.accent,
} as const;

export type ColorToken = keyof typeof color;

/** The only hex values a screen may use. */
export const ALLOWED_COLORS: ReadonlySet<string> = new Set(Object.values(palette));

// ---------------------------------------------------------------------------------------
// Type: one sans family, two weights, scale 13/15/17/22/28 (Verdict Typo)
// ---------------------------------------------------------------------------------------

/**
 * Verdict ships Inter. The app has no font asset or expo-font yet, and an unknown fontFamily is a
 * red-box error on iOS, so `family` stays undefined (system SF Pro, one sans) until Inter is added.
 */
export const fontFamily: string | undefined = undefined;

export const fontWeight = { regular: '400', semibold: '600' } as const;
export type FontWeight = (typeof fontWeight)[keyof typeof fontWeight];

export const typeScale = [13, 15, 17, 22, 28] as const;

type TypeStyle = {
  readonly fontSize: (typeof typeScale)[number];
  readonly lineHeight: number;
  readonly fontWeight: FontWeight;
  readonly letterSpacing: number;
  readonly color: string;
};

export const type = {
  display: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.4,
    color: palette.text,
  },
  title: {
    fontSize: 22,
    lineHeight: 32,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.2,
    color: palette.text,
  },
  heading: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0,
    color: palette.text,
  },
  label: {
    fontSize: 15,
    lineHeight: 24,
    fontWeight: fontWeight.regular,
    letterSpacing: 0,
    color: palette.text,
  },
  labelStrong: {
    fontSize: 15,
    lineHeight: 24,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0,
    color: palette.text,
  },
  value: {
    fontSize: 15,
    lineHeight: 24,
    fontWeight: fontWeight.regular,
    letterSpacing: 0,
    color: palette.textSecondary,
  },
  small: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: fontWeight.regular,
    letterSpacing: 0,
    color: palette.textSecondary,
  },
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

// ---------------------------------------------------------------------------------------
// Space (8-pt grid), radii, sizes
// ---------------------------------------------------------------------------------------

export const GRID = 8;

export const space = {
  x1: 8,
  x2: 16,
  x3: 24,
  x4: 32,
  x5: 40,
  x6: 48,
  x8: 64,
  /** Horizontal page margin. */
  page: 24,
  /** Standard control height (buttons, inputs). */
  control: 48,
} as const;

/** Verdict: 4 (chips, tags), 8 (buttons, inputs, banners), 12 (sheet top corners). */
export const radius = { sm: 4, md: 8, lg: 12, pill: 999 } as const;

/** Hairline: use StyleSheet.hairlineWidth at the call site; this is the logical fallback. */
export const border = { hairline: 0.5 } as const;

/** One outline icon set (Lucide), used sparingly. */
export const iconSize = { sm: 16, md: 20 } as const;

// ---------------------------------------------------------------------------------------
// Motion: functional only, <= 200 ms, ease-out, no springs, no bounce
// ---------------------------------------------------------------------------------------

export const MAX_TRANSITION_MS = 200;

export const motion = {
  /** Every UI transition. */
  fastMs: 150,
  /** Flutter Curves.easeOut = cubic-bezier(0, 0, 0.58, 1). Reanimated: Easing.bezier(...). */
  easing: [0, 0, 0.58, 1] as const,
  /** Springs are banned (spec §6.2); a component must not use withSpring. */
  spring: false,
} as const;

// ---------------------------------------------------------------------------------------
// Hold to confirm (TASKS D1-M5)
// ---------------------------------------------------------------------------------------

export const hold = {
  /** Full hold before the Face ID prompt opens. */
  durationMs: 800,
  /** Finger travel that cancels the hold. */
  maxDistance: 24,
  /** Releasing early returns the ring to 0 over this; then no prompt. */
  releaseMs: 150,
  ringStrokeWidth: 2,
} as const;

// ---------------------------------------------------------------------------------------
// Payout moment (SCHEMAS X10, API-CONTRACT §6.2, ARCHITECTURE §5.2)
// ---------------------------------------------------------------------------------------

export const payout = {
  /** The winner's balance counts up from the old to the new value at `processed`. Tunable. */
  countUpMs: 600,
  /** The "+$" line fades in over one standard transition. */
  revealMs: 150,
  /** Not confirmed within this long after `processed` (or failed) -> revert and offer a retry. */
  revertAfterMs: 5_000,
  /** The pending tint lasts until `confirmed` (tx.confirmed), then the value turns to `text`. */
  pendingColor: color.pending,
  settledColor: color.text,
} as const;

// ---------------------------------------------------------------------------------------
// Haptics (named tokens only; expo-haptics string values)
// ---------------------------------------------------------------------------------------

export type HapticToken =
  | { readonly kind: 'impact'; readonly style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' }
  | { readonly kind: 'notification'; readonly type: 'success' | 'warning' | 'error' }
  | { readonly kind: 'selection' };

export type HapticPattern = readonly { readonly haptic: HapticToken; readonly atMs: number }[];

const once = (haptic: HapticToken): HapticPattern => [{ haptic, atMs: 0 }];

export const haptics = {
  /** B's full-screen "Logan challenged you" (ARCHITECTURE §3.1). */
  challengeArrived: once({ kind: 'notification', type: 'warning' }),
  /** The hold ring starts filling. */
  holdStart: once({ kind: 'impact', style: 'light' }),
  /** The ring completes; Face ID opens next. */
  holdComplete: once({ kind: 'impact', style: 'medium' }),
  /** This phone's signature was accepted ("You're in"; SCHEMAS §9.4). */
  authorized: once({ kind: 'notification', type: 'success' }),
  /** LOCKED at `confirmed`: a double haptic on both phones. */
  locked: [
    { haptic: { kind: 'impact', style: 'heavy' }, atMs: 0 },
    { haptic: { kind: 'impact', style: 'heavy' }, atMs: 120 },
  ],
  /** The winner's payout at `processed`. */
  payout: once({ kind: 'notification', type: 'success' }),
  /** A policy rejection, failed lock, or reverted payout. */
  failed: once({ kind: 'notification', type: 'error' }),
} as const satisfies Record<string, HapticPattern>;

export type HapticMoment = keyof typeof haptics;

// ---------------------------------------------------------------------------------------
// Copy limits (used by ./copyRule)
// ---------------------------------------------------------------------------------------

export const copy = {
  /** Labels are 1-3 words (spec §6.3). */
  maxLabelWords: 3,
  /** "Directly below" for the no-subtitle check, in points. */
  belowGapPt: 16,
} as const;
