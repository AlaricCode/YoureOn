// Small typesetting helpers for headline type (ui/tokens): at 20 pt and up, bold, a line shows
// every shortcut the keyboard took. Pure TS, tested in node.
import { type, type TypeToken } from './tokens';

/** Headline sizes start here; under it type is read, not looked at. */
export const DISPLAY_FROM = 20;

/** True for the type styles big enough to be set with care (20 pt and up). */
export function isDisplay(variant: TypeToken): boolean {
  return type[variant].fontSize >= DISPLAY_FROM;
}

/**
 * Typewriter apostrophes become real ones ("You're On" -> "You’re On", "Jake's" -> "Jake’s"):
 * in a bold headline a straight tick reads as a mistake. Only an apostrophe that follows
 * a letter or digit is touched, so quoted text and prime marks are left alone.
 */
export function typographic(text: string): string {
  return text.replace(/([\p{L}\p{N}])'/gu, '$1’');
}

/**
 * A headline that needs two lines, broken where the two come out closest in length, so a short
 * last word is never left alone under a full line ("Logan challenged / you" becomes
 * "Logan / challenged you"). Text that fits on one line (`fitsChars`), already has a break, or
 * cannot be split into two lines that both fit is returned as it is, to wrap by itself.
 */
export function balance(text: string, fitsChars: number): string {
  if (text.includes('\n') || text.length <= fitsChars) return text;
  const words = text.split(' ').filter((w) => w.length > 0);
  if (words.length < 2) return text;
  let best: { longer: number; text: string } | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const longer = Math.max(a.length, b.length);
    if (longer > fitsChars) continue;
    if (best === null || longer < best.longer) best = { longer, text: `${a}\n${b}` };
  }
  return best ? best.text : text;
}
