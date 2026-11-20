// The replay player's look: the app's neutrals (ui/tokens, "Limelight": pure black, white type,
// green for a win, red for a foul, Geist), kept as local values under their first name
// (`obsidian`) so this feature stands alone. The hexes are the palette's own:
//   obsidian.black -> palette.background   obsidian.raised -> palette.surface
//   obsidian.line  -> palette.hairline     obsidian.edge  -> palette.rim
//   obsidian.white -> palette.text         obsidian.grey  -> palette.textSecondary
//   obsidian.dim   -> palette.textTertiary obsidian.green -> palette.accent
//   obsidian.red   -> palette.danger
//   geist.*        -> fontFamily.* (ui/fonts loads exactly these family names)
// Without the fonts registered, iOS falls back to the system font for an unknown family and the
// fontWeight below keeps the hierarchy.
//
// Pure TS (no react-native import).

export const obsidian = {
  black: '#000000',
  raised: '#161618',
  line: '#232327',
  /** One step above `line`: a control on a panel. */
  edge: '#2E2E33',
  white: '#FFFFFF',
  grey: '#98989F',
  dim: '#5C5C63',
  green: '#00D47A',
  red: '#FF4F45',
  /** Text on a green fill. */
  onGreen: '#000000',
  /** The scrim behind the controls drawn over a frame. */
  scrim: 'rgba(0,0,0,0.55)',
} as const;

export const geist = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
} as const;

type Face = keyof typeof geist;
const weightOf: Record<Face, '400' | '500' | '600' | '700'> = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

/** A text style fragment: family + matching weight (iOS needs both for the fallback). */
export const font = (face: Face, size: number, color: string = obsidian.white) => ({
  fontFamily: geist[face],
  fontWeight: weightOf[face],
  fontSize: size,
  color,
});

/** The ring on the held frame: green for a win, red for a foul. */
export const accentFor = (kind: 'win' | 'foul'): string =>
  kind === 'foul' ? obsidian.red : obsidian.green;
