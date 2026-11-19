// Loads the app's two typefaces (ui/tokens `fontFamily`) with expo-font, one family name per
// face: iOS does not select a weight inside a custom family from fontWeight. Geist is the UI
// voice; only the four weights the tokens use are imported (the package's index file would bundle
// all 18). Instrument Serif (regular and italic, SIL OFL 1.1) is what is said: the judge, the
// bet's claim, a moment's headline. Its two files are vendored in assets/fonts with the licence.
//
// The app root keeps the in-app splash (ui/brand SplashView, mark only) until this settles, so no
// text draws in a font that is about to change. If loading fails, or takes longer than
// FONT_TIMEOUT_MS, the app renders anyway: React Native falls back to the system font for a family
// that is not registered (RCTFont logs and uses systemFontOfSize:weight:), and every type style
// also sets fontWeight, so the hierarchy survives the fallback.
import Geist_300Light from '@expo-google-fonts/geist/300Light/Geist_300Light.ttf';
import Geist_400Regular from '@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf';
import Geist_500Medium from '@expo-google-fonts/geist/500Medium/Geist_500Medium.ttf';
import Geist_600SemiBold from '@expo-google-fonts/geist/600SemiBold/Geist_600SemiBold.ttf';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';

import InstrumentSerif_400Regular from '../../assets/fonts/InstrumentSerif_400Regular.ttf';
import InstrumentSerif_400Regular_Italic from '../../assets/fonts/InstrumentSerif_400Regular_Italic.ttf';
import type { FontFamilyName } from './tokens';

/** Family name -> bundled file. Keys must be exactly the tokens' family names (checked by tsc). */
export const FONT_FILES = {
  Geist_300Light,
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  InstrumentSerif_400Regular,
  InstrumentSerif_400Regular_Italic,
} as const satisfies Record<FontFamilyName, number>;

/** Give up waiting (system font) after this long. Bundled files normally load in tens of ms. */
export const FONT_TIMEOUT_MS = 3_000;

/** True once the fonts are loaded, failed (system fallback) or timed out. Call once, at the root. */
export function useAppFonts(timeoutMs: number = FONT_TIMEOUT_MS): boolean {
  const [loaded, error] = useFonts(FONT_FILES);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (loaded || error) return;
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [loaded, error, timeoutMs]);
  useEffect(() => {
    if (error) console.warn('Fonts did not load; using the system font.', error);
  }, [error]);
  return loaded || error !== null || timedOut;
}
