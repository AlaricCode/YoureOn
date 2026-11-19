// You're On design tokens: "Limelight". The room is dark and the bet is what is lit.
//
// 1. Black is the room: pure OLED black, nothing tinted.
// 2. White asks, green answers. Every action is white (the primary pill, selection, focus).
//    Green appears only when something is on: live, locked, won, paid, online, and on the one
//    control that moves money (swipe to lock in). Red is money leaving and fixable problems.
// 3. Two voices. Geist for everything you operate (labels, buttons, figures with tabular
//    numerals). Instrument Serif for what is said: the judge, the bet's claim, the headline of a
//    moment, the wordmark.
// 4. Objects are glass: the things you could hold (the bet slip, a sheet, the roster, the camera
//    stage) are top-lit panels with a 1 pt rim (`material`). Plain rows stay on black.
// 5. Light marks the moment: one aurora behind a moment's words, a bloom under what is on.
//
// Pure TS on purpose: no react-native / expo imports, so vitest can load it in Node and every
// screen gets the same numbers. Haptics are named tokens only; the call site maps them to
// expo-haptics (whose enum values are these same strings: 'light', 'success', ...). Font files are
// loaded by ./fonts (expo-font) under exactly the family names in `fontFamily` below.
//
// Timing sources from OUR contracts: HoldToConfirm 800 ms / maxDistance 24 (TASKS D1-M5); the
// payout animation fires at `processed` and reverts if not confirmed within 5 s (SCHEMAS X10,
// API-CONTRACT §6.2, ARCHITECTURE §5.2); LOCKED is a double haptic on both phones (ARCHITECTURE §5.2).

// ---------------------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------------------

/** The named swatches. Screens should reach for the semantic names in `palette` / `color`. */
export const swatch = {
  /** Background everywhere, the status bar area too. */
  black: '#000000',
  /** Sheets, modals and inputs only. Most content sits straight on black. */
  raised: '#0F0F11',
  /** Hairline dividers; also the fill of secondary buttons, chips and avatars. */
  line: '#1C1C1F',
  /** The rim of a glass object and of a control: one step brighter than `line`. */
  edge: '#2A2A2E',
  /** Primary text, and the primary action's fill. */
  white: '#FFFFFF',
  /** Secondary text (>= 4.5:1 on black). */
  grey: '#8D8D93',
  /** Tertiary text, disabled, offline. */
  dim: '#4A4A4F',
  /** "On": live, locked, won, paid, online, and the swipe that moves money. Ink on it is black. */
  green: '#00D47A',
  /** Money down, losses, destructive actions, fixable capture problems. Sparingly. */
  red: '#FF4F45',
} as const;

export const palette = {
  ...swatch,
  // Semantic aliases (the names every screen uses).
  background: swatch.black,
  /** Sheets, modals, inputs, the camera stage. */
  surface: swatch.raised,
  /** Secondary buttons, chips, avatar discs, toggles off. */
  fill: swatch.line,
  hairline: swatch.line,
  /** The 1 pt rim of glass objects, secondary buttons, chips and avatar discs. */
  rim: swatch.edge,
  text: swatch.white,
  textSecondary: swatch.grey,
  textTertiary: swatch.dim,
  /** "On": live state, a done step, a tick, the hold / swipe that moves money. Never a plain action. */
  accent: swatch.green,
  /** Money down, the loss cross, destructive actions, fixable capture problems. */
  danger: swatch.red,
  /** Money up ("+$", Won, paid) and online presence. Same green as the accent. */
  success: swatch.green,
} as const;

/** Semantic roles. Every role resolves to a palette value. */
export const color = {
  ...palette,
  /** Text and icons on a green or white fill: black, never white. */
  onAccent: palette.black,
  /** Text on the white primary pill and on a white selection. */
  onPrimary: palette.black,
  /** Text on a green success fill. */
  onSuccess: palette.black,
  /** Text on a red fill (the filled "Yes, delete"). */
  onDanger: palette.black,
  /** Errors are short noun phrases in the text color, never red. */
  error: palette.text,
  divider: palette.hairline,
  border: palette.hairline,
  /** A focused input: a 1 pt white border (`border.focused`). */
  borderFocused: palette.white,
  /** Avatar discs: a glass disc with a white serif initial. No per-person tints. */
  avatar: palette.fill,
  disabled: palette.dim,
  /** The balance shown "+$" at processed, before confirmation (ARCHITECTURE §5.2). */
  pending: palette.textSecondary,
  live: palette.accent,
  /** White asks: the one filled action on a screen is a white pill with black text. */
  primaryAction: palette.white,
  /** The selected chip / stake: white, like every other choice you make. */
  selected: palette.white,
  /** The one green control: the swipe (or hold) that locks money in. */
  commit: palette.green,
  /** Destructive buttons and fixable capture problems (see palette.danger). */
  destructive: palette.danger,
  fixable: palette.danger,
  /** Money down: a loss, "−$", a lock that ended badly, a failed payout. */
  negative: palette.danger,
  /** Money up: "+$" on a payout you received, Won, paid. */
  positive: palette.green,
  /** Presence dots. */
  online: palette.green,
  offline: palette.dim,
} as const;

export type ColorToken = keyof typeof color;

/** Every hex value a screen may use. */
export const ALLOWED_COLORS: ReadonlySet<string> = new Set(Object.values(palette));

/** Money direction -> its colour: up green, down red, flat white. */
export function moneyColor(deltaCents: number): string {
  return deltaCents > 0 ? color.positive : deltaCents < 0 ? color.negative : color.text;
}

/**
 * The soft glow behind a moment's money figure: a radial fade of the money colour from
 * `opacity` at the centre to 0 at the edge of a `size` disc (no gradient banners, no blur views).
 */
export const glow = { size: 320, opacity: 0.22, lossOpacity: 0.1 } as const;

/**
 * The aurora: the one light on a moment screen. A wide ellipse of the moment's colour hung from
 * the top of the screen, fading to nothing before the buttons (it runs past both sides, so the
 * fade reads as a glow, not a shape).
 */
export const aurora = {
  /** The ellipse's box, as fractions of the screen: wider than it, hung above its top edge. */
  width: 1.8,
  height: 0.74,
  top: -0.22,
  /** Centre opacity: money in / locked. */
  opacity: 0.34,
  /** Centre opacity: money out (the loss is quieter than the win). */
  lossOpacity: 0.22,
  /** Centre opacity: a neutral (white) moment, e.g. an incoming challenge. */
  neutralOpacity: 0.1,
  fadeMs: 280,
} as const;

/**
 * What objects are made of. Strings are React Native style values (`backgroundImage`,
 * `boxShadow`), so a component spreads them straight into a style. Every colour inside is a
 * palette swatch or white / the palette green at an alpha.
 */
export const material = {
  /** A glass object's fill: lit from the top, falling to near black. */
  glass: 'linear-gradient(180deg, #17171A 0%, #0B0B0D 100%)',
  /** A glass object sitting on glass (a well inside a sheet): one step up. */
  glassRaised: 'linear-gradient(180deg, #222226 0%, #17171A 100%)',
  /** The lit top edge of a glass object or a control. */
  highlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
  /** An avatar disc: lit from the upper left. */
  disc: 'linear-gradient(145deg, #2E2E33 0%, #161618 58%, #0E0E10 100%)',
  /** The bloom under the green control that moves money. */
  bloomOn: '0 10px 32px -8px rgba(0, 212, 122, 0.6)',
  /** The lit ring around what just won / locked. */
  ringOn: '0 0 0 1px rgba(0, 212, 122, 0.55), 0 0 28px 0 rgba(0, 212, 122, 0.35)',
  /** The lift under the white primary pill: barely there, it only separates it from black. */
  bloomPrimary: '0 8px 28px -10px rgba(255, 255, 255, 0.28)',
} as const;

/**
 * The judge's presence: a pearl sphere with a halo that breathes while it listens and beats
 * faster while it speaks. It is the one object with a material of its own (cool greys, not
 * palette swatches), so it reads as someone, not as a control. Drawn with react-native-svg.
 */
export const orb = {
  size: 148,
  /** Where the light falls on the sphere (fractions of its box). */
  light: { x: 0.34, y: 0.28 },
  /** The sphere's shading from the highlight out to the rim: [offset, colour]. */
  stops: [
    [0, '#FFFFFF'],
    [0.14, '#E9ECF3'],
    [0.42, '#9AA0B4'],
    [0.74, '#2A2C36'],
    [1, '#0B0B0E'],
  ] as readonly (readonly [number, string])[],
  /** The halo: a disc of this colour, `haloSize` times the sphere, fading out from its edge. */
  halo: '#C8D2FF',
  haloSize: 2.3,
  haloOpacity: 0.34,
  /** The two orbit rings, as multiples of `size`. */
  rings: [1.42, 1.76] as readonly number[],
  /** One breath (out and back) while listening; a faster beat while it speaks. */
  breatheMs: 2400,
  speakMs: 900,
  /** Scale at the top of a breath / a beat. */
  breatheTo: 1.04,
  speakTo: 1.08,
  /** The halo's opacity at rest (it reaches 1 at the top of a breath). */
  restOpacity: 0.55,
} as const;

/**
 * Voice activation only ("Jarvis" heard, the judge listening/thinking): the full hue wheel,
 * computed by wake/spectrum as rgb() strings for the RainbowLoop edge light. Never a fill, never
 * text, never a screen colour. The one documented exception to "two chromatic colours";
 * ALLOWED_COLORS stays palette-only.
 */
export const spectrum = {
  saturation: 1,
  lightness: 0.6,
  reservedFor: 'voice-activation',
} as const;

// ---------------------------------------------------------------------------------------
// Type: two voices. Geist (four weights) for everything you operate; Instrument Serif (regular
// and italic) for what is said.
// ---------------------------------------------------------------------------------------

/**
 * Loaded font family names, one per face (./fonts registers each file under exactly this
 * name). iOS does not pick a weight inside a custom family from fontWeight, so each weight is its
 * own family; fontWeight is still set on every style so the system-font fallback (fonts failed to
 * load) keeps the hierarchy.
 */
export const fontFamily = {
  /** Geist 300: money figures and big numbers. */
  light: 'Geist_300Light',
  /** Geist 400: body, inputs, mid-size amounts. */
  regular: 'Geist_400Regular',
  /** Geist 500: labels. */
  medium: 'Geist_500Medium',
  /** Geist 600: headings, buttons, titles. */
  semibold: 'Geist_600SemiBold',
  /** Instrument Serif: the bet's claim, a moment's headline, monograms. */
  voice: 'InstrumentSerif_400Regular',
  /** Instrument Serif Italic: the judge speaking, the wordmark, "You're on". */
  voiceItalic: 'InstrumentSerif_400Regular_Italic',
} as const;

export type FontFamilyName = (typeof fontFamily)[keyof typeof fontFamily];

export const fontWeight = {
  light: '300',
  regular: '400',
  medium: '500',
  semibold: '600',
} as const;
export type FontWeight = (typeof fontWeight)[keyof typeof fontWeight];
type Weight = keyof typeof fontWeight;

/** UI sizes. */
export const typeScale = [13, 15, 17, 22, 28] as const;
/** Figure sizes: money and big numbers. Geist Light/Regular with tabular numerals only. */
export const displayScale = [34, 44, 56] as const;
/**
 * Voice sizes (Instrument Serif). It is a narrow display face with a small x-height, so it runs
 * about a fifth larger than Geist for the same presence, and never below 22.
 */
export const voiceScale = [22, 26, 30, 40, 52, 64] as const;

/** Numerals all the same width, so a counting figure does not jitter. */
export const TABULAR: ['tabular-nums'] = ['tabular-nums'];

type TypeStyle = {
  readonly fontFamily: FontFamilyName;
  readonly fontSize:
    (typeof typeScale)[number] | (typeof displayScale)[number] | (typeof voiceScale)[number];
  readonly lineHeight: number;
  readonly fontWeight: FontWeight;
  readonly letterSpacing: number;
  readonly color: string;
  readonly fontVariant?: ['tabular-nums'];
};

const ui = (
  fontSize: (typeof typeScale)[number],
  lineHeight: number,
  w: Exclude<Weight, 'light'>,
  c: string = palette.text,
  letterSpacing = 0,
): TypeStyle => ({
  fontFamily: fontFamily[w],
  fontSize,
  lineHeight,
  fontWeight: fontWeight[w],
  letterSpacing,
  color: c,
});

/** A figure: tabular numerals, tight tracking (about -2.8 % of the size). */
const figure = (
  fontSize: (typeof typeScale)[number] | (typeof displayScale)[number],
  lineHeight: number,
  w: 'light' | 'regular' = 'light',
): TypeStyle => ({
  fontFamily: fontFamily[w],
  fontSize,
  lineHeight,
  fontWeight: fontWeight[w],
  letterSpacing: -Math.round(fontSize * 0.028 * 10) / 10,
  color: palette.text,
  fontVariant: TABULAR,
});

/** What is said: Instrument Serif, upright or italic, tracked a touch tight at display sizes. */
const voice = (
  fontSize: (typeof voiceScale)[number],
  lineHeight: number,
  face: 'voice' | 'voiceItalic' = 'voice',
  c: string = palette.text,
): TypeStyle => ({
  fontFamily: fontFamily[face],
  fontSize,
  lineHeight,
  fontWeight: fontWeight.regular,
  letterSpacing: fontSize >= 40 ? -Math.round(fontSize * 0.012 * 10) / 10 : 0,
  color: c,
});

export const type = {
  // --- Figures (Geist Light / Regular, tabular) ------------------------------------------
  /** The balance: 56 Light. The signature. */
  balance: figure(56, 62),
  /** The money figure on a moment ("+$5.00"): 56 Light, coloured by direction. */
  money: figure(56, 62),
  /** Big numbers that are not money: the countdown clock. 44 Light. */
  display: figure(44, 50),
  /** A mid-size figure (the pot, a stake on the terms card): 34 Light. */
  figure: figure(34, 40),
  /** Dollar amounts in rows ("$10"): 22 Regular. */
  amount: figure(22, 28, 'regular'),
  // --- The voice (Instrument Serif) ------------------------------------------------------
  /** The moment headline ("You're on", the ruling): serif 64. */
  moment: voice(64, 66),
  /** A longer moment line ("Logan challenged you"), or a moment on a small phone: serif 52. */
  momentSmall: voice(52, 54),
  /** End-state titles ("Declined. Nothing moved.", "Payout failed"): serif 40. */
  endTitle: voice(40, 44),
  /** The bet statement (the claim on terms, live, hearing, market): serif 30. */
  statement: voice(30, 34),
  /** The claim where room is tight (the draft read back under the judge): serif 26. */
  statementSmall: voice(26, 30),
  /** The judge speaking (the caption under the orb, the ruling's reason): serif italic 26. */
  spoken: voice(26, 32, 'voiceItalic'),
  /** A quieter spoken line (the reason under a ruling): serif italic 22. */
  spokenSmall: voice(22, 28, 'voiceItalic'),
  /** The wordmark beside the mark: serif italic 22. */
  wordmark: voice(22, 28, 'voiceItalic'),
  /** The sign-up title (the name of the app, said once): serif italic 64. */
  hero: voice(64, 66, 'voiceItalic'),
  // --- UI (Geist) ------------------------------------------------------------------------
  /** Screen titles: 28/600. */
  title: ui(28, 34, 'semibold', palette.text, -0.6),
  /** A sub-headline (sheet titles, "Face saved"): 22/600. */
  subtitle: ui(22, 28, 'semibold', palette.text, -0.3),
  /** A large initial on a 56 pt avatar disc: 22/500. */
  initial: ui(22, 28, 'medium'),
  /** Names in lists, sheet titles, the stage prompt: 17/600. */
  heading: ui(17, 24, 'semibold'),
  /** Button labels: 17/600. */
  button: ui(17, 22, 'semibold'),
  /** A plain text button ("Skip for now", "Back"): 17/500 white. */
  buttonQuiet: ui(17, 22, 'medium'),
  /** List row titles (Profile, History): 17/400. */
  row: ui(17, 24, 'regular'),
  /** Names that lead a row (the appeal panel's models), stake chips: 17/500. */
  rowMedium: ui(17, 24, 'medium'),
  /** Text typed into a field: 17/400. */
  input: ui(17, 22, 'regular'),
  /** Running text and explanations under a title: 15, grey. */
  body: ui(15, 22, 'regular', palette.textSecondary),
  label: ui(15, 22, 'regular'),
  /** Section headers ("Counts if", "Profile"): grey 15/500, quieter than the rows under them. */
  section: ui(15, 22, 'medium', palette.textSecondary),
  labelMedium: ui(15, 22, 'medium'),
  labelStrong: ui(15, 22, 'semibold'),
  /** The value in a row, and "Balance" above the figure: 15, grey. */
  value: ui(15, 22, 'regular', palette.textSecondary),
  small: ui(13, 18, 'regular', palette.textSecondary),
  smallStrong: ui(13, 18, 'medium', palette.text),
} as const satisfies Record<string, TypeStyle>;

export type TypeToken = keyof typeof type;

// ---------------------------------------------------------------------------------------
// Space (4-pt grid, 8-pt steps), radii, sizes
// ---------------------------------------------------------------------------------------

export const GRID = 4;

export const space = {
  x1: 8,
  x2: 16,
  x3: 24,
  x4: 32,
  x5: 40,
  x6: 48,
  x7: 56,
  x8: 64,
  x10: 80,
  /** Horizontal page margin. */
  page: 20,
  /** Standard control height (buttons, inputs, the hold control). */
  control: 56,
  /** A list row's minimum height (hairline-separated). */
  row: 56,
} as const;

/** Half-steps of the grid, for tight inner gaps (chip padding, label-to-field). */
export const half = { x05: 4, x15: 12 } as const;

/**
 * sm: checkboxes; md: inputs, banners; lg: sheets and the camera stage; xl: the bet slip and the
 * other glass objects that sit on the page margin; pill: buttons, chips.
 */
export const radius = { sm: 6, md: 14, lg: 20, xl: 28, pill: 999 } as const;

/** Hairline: use StyleSheet.hairlineWidth at the call site; this is the logical fallback. */
export const border = { hairline: 0.5, focused: 1 } as const;

/** One outline icon set (Lucide), used sparingly. */
export const iconSize = { sm: 16, md: 20 } as const;

/** Avatar disc sizes in use. */
export const avatarSize = {
  sm: 32,
  md: 40,
  lg: 48,
  vs: 56,
  xl: 72,
  moment: 88,
  hero: 112,
} as const;

/** The balance sparkline (Home): a 2 pt line, no axes, no grid. */
export const sparkline = {
  height: 72,
  strokeWidth: 2,
  endDot: 3,
  /** The soft halo around the end dot: an r = 6 disc at 0.2 opacity. */
  haloRadius: 6,
  haloOpacity: 0.2,
  /** The wash under the line: the line's colour at this opacity, fading to nothing at the floor. */
  areaOpacity: 0.26,
  /** Fewer points than this draw nothing (two points are just a ruler line). */
  minPoints: 3,
} as const;

// ---------------------------------------------------------------------------------------
// Motion: functional only, ease-out, no bounce. One reveal on a moment (fade and a slight rise,
// <= 300 ms); every other transition <= 200 ms. One spring, and only to settle a released gesture
// (it has to carry the finger's velocity): critically damped and clamped, so it never overshoots.
// ---------------------------------------------------------------------------------------

export const MAX_TRANSITION_MS = 200;
export const MAX_MOMENT_MS = 300;

export const motion = {
  /** Every UI transition. */
  fastMs: 150,
  /** The moment reveal: fade in and rise `momentRise` pt. Off under Reduce Motion. */
  momentMs: 280,
  momentRise: 12,
  /** A slight scale-in some reveals pair with the fade (kept subtle). */
  momentFromScale: 0.98,
  /** Flutter Curves.easeOut = cubic-bezier(0, 0, 0.58, 1). Reanimated: Easing.bezier(...). */
  easing: [0, 0, 0.58, 1] as const,
  /**
   * Springs are banned (spec §6.2) except to settle a released gesture (SwipeToConfirm), and then
   * only `settle` below. ui/__tests__/motionAudit enforces both.
   */
  spring: 'gesture-settle',
  /**
   * The gesture settle: damping ratio 36 / (2 * sqrt(300)) = 1.04 (critically damped) and
   * clamped, so a released pill glides home with the finger's velocity and never bounces.
   */
  settle: { damping: 36, stiffness: 300, mass: 1, overshootClamping: true },
  /** Press feedback: scale down on press-in, back on release. */
  pressInMs: 90,
  pressOutMs: 150,
  /** Buttons. */
  pressScale: 0.97,
  /** Stake chips (smaller targets, a touch deeper). */
  chipPressScale: 0.95,
} as const;

// ---------------------------------------------------------------------------------------
// Swipe to confirm (SwipeToConfirm): the deliberate intent before Face ID (replaces the hold)
// ---------------------------------------------------------------------------------------

export const swipe = {
  /** Lift that arms the control: the pill follows the finger 1:1 up to here. */
  travel: 72,
  /** Rubber band past `travel`: at most this many extra points... */
  maxOverdrag: 16,
  /** ...at this fraction of the finger's extra travel. */
  overdragFactor: 0.25,
  /** The pan activates after this much upward travel. */
  activateOffset: 8,
  /** Sideways travel (either way) before activation fails the pan: it was not a swipe up. */
  failOffsetX: 40,
  /** Downward travel before activation fails the pan. */
  failOffsetDown: 16,
  /** A release at least this fast upward (pt/s)... */
  flingVelocity: 900,
  /** ...and at least this far along commits without reaching `travel`. */
  flingMinProgress: 0.6,
  /** Selection ticks on the way up. */
  ticks: [0.25, 0.5, 0.75] as readonly number[],
  /** A tap does not commit: the pill lifts this far and settles, and the hint shows. */
  nudgeLift: 14,
  nudgeMs: 180,
  hintMs: 1200,
  /** Idle: the chevron bobs up `bobRise` pt (`bobMs` up, `bobMs` down) every `bobEveryMs`. */
  bobRise: 3,
  bobMs: 300,
  bobEveryMs: 2400,
  /** The tick stays this long after a commit. */
  successHoldMs: 400,
  /** The chevron / tick glyph box, in points. */
  chevron: 10,
  /** The chevron -> tick crossfade when the control arms. */
  armMs: 120,
  /** Press feedback on touch down (a lighter press than a button: the finger is about to move). */
  pressScale: 0.98,
  pressInMs: 90,
  pressOutMs: 150,
} as const;

// ---------------------------------------------------------------------------------------
// Sparkline scrub (Home): the finger on the balance line
// ---------------------------------------------------------------------------------------

export const scrub = {
  /** Horizontal travel (pt) that starts a scrub. */
  activeOffsetX: 6,
  /** Vertical travel (pt) first that gives the touch back (to a scroll, the operator hold). */
  failOffsetY: 14,
  /** Extra touch area above and below the line. */
  hitSlopY: 16,
  /** The hairline and dot gliding to the next point. */
  glideMs: 70,
  /** The scrub overlays fading in and out. */
  fadeMs: 100,
  /** The black wash over the line right of the hairline (the "future" greys out). */
  dimOpacity: 0.6,
  /** Hairline width (pt). */
  hairline: 1,
  /** The scrub dot's radius, and its halo's. */
  dot: 4,
  halo: 8,
  haloOpacity: 0.2,
  /** At most one tick haptic per this long (JS side). */
  tickMinGapMs: 35,
} as const;

// ---------------------------------------------------------------------------------------
// Loading skeleton (History)
// ---------------------------------------------------------------------------------------

/** Rows pulse together in opacity (no gradient shimmer: gradients are banned). */
export const skeleton = { pulseMs: 1100, low: 0.45, bar: 14 } as const;

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
  /** The hold's progress: a black overlay at this opacity sweeping across the green pill. */
  progressOpacity: 0.18,
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
  /** The "+$" delta beside the balance. */
  deltaColor: color.positive,
} as const;

/** The rolling-number ticker (balance, payout, market price). */
export const ticker = {
  /** A money roll is the payout count-up, same 600 ms. */
  rollMs: payout.countUpMs,
  /** A text-mode tick (each changed digit of a live price). */
  tickMs: 250,
  /** Pending grey -> settled white crossfade. */
  colorMs: 150,
  /** A leading column opening (or closing) as it carries in ($9.99 -> $10.00). */
  leadMs: 150,
  /** The smallest the figure shrinks to fit its box. */
  minScale: 0.6,
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
  /** The ruling lands (RulingScreen, both phones): one firm tap before the words. */
  ruled: once({ kind: 'impact', style: 'medium' }),
  /** "Run it back": a light tick, it is a retry, not a result. */
  redo: once({ kind: 'selection' }),
  /** The winner's payout at `processed`. */
  payout: once({ kind: 'notification', type: 'success' }),
  /** A policy rejection, failed lock, or reverted payout. */
  failed: once({ kind: 'notification', type: 'error' }),
  /** A swipe crosses 25 / 50 / 75 % on the way up. */
  swipeTick: once({ kind: 'selection' }),
  /** The swipe reaches the top: a release now commits. */
  swipeArmed: once({ kind: 'impact', style: 'rigid' }),
  /** The sparkline scrub lands on a new point. */
  scrubTick: once({ kind: 'selection' }),
  /** A chip / stake selection changed. */
  select: once({ kind: 'selection' }),
  /** "Jarvis" heard: the rainbow loop starts (wake/RainbowLoop). */
  wakeHeard: once({ kind: 'impact', style: 'soft' }),
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
