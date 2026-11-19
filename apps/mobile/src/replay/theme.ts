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
  raised: '#0F0F11',
  line: '#1C1C1F',
  /** The 1 pt rim of a glass control. */
  edge: '#2A2A2E',
  white: '#FFFFFF',
  grey: '#8D8D93',
  dim: '#4A4A4F',
  green: '#00D47A',
  red: '#FF4F45',
  /** Text on a green fill. */
  onGreen: '#000000',
  /** The scrim behind the controls drawn over a frame. */
  scrim: 'rgba(0,0,0,0.55)',
} as const;

export const geist = {
  light: 'Geist_300Light',
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
} as const;

type Face = keyof typeof geist;
const weightOf: Record<Face, '300' | '400' | '500' | '600'> = {
  light: '300',
  regular: '400',
  medium: '500',
  semibold: '600',
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
