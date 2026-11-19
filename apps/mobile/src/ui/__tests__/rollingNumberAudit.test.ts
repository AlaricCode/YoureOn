// Source audit for ui/RollingNumber (it cannot be rendered in node). Each digit column is a
// one-line window over a tall strip of digits. On the new architecture a Text inside a
// fixed-height parent is measured "at most" that tall and clamped to it, so a strip without a
// height of its own is laid out one line tall and only its first row (digit 0) is ever drawn:
// $12.50 showed as "$ . 0" (found on the simulator). Both strips must set their full height.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CENTS_STRIP, TEXT_STRIP } from '../odometer';

const src = readFileSync(fileURLToPath(new URL('../RollingNumber.tsx', import.meta.url)), 'utf8');

describe('rolling numerals: the digit strips', () => {
  it('have one row per line', () => {
    expect(CENTS_STRIP.split('\n')).toHaveLength(11);
    expect(TEXT_STRIP.split('\n')).toHaveLength(20);
  });

  it('count their rows from the strips themselves', () => {
    expect(src).toMatch(/const CENTS_ROWS = CENTS_STRIP\.split\('\\n'\)\.length;/);
    expect(src).toMatch(/const TEXT_ROWS = TEXT_STRIP\.split\('\\n'\)\.length;/);
  });

  it('are given their full height, so every row is drawn', () => {
    const strips = [...src.matchAll(/<Animated\.Text style=\{\[([^\]]*)\]\}>\s*\{(\w+_STRIP)\}/g)];
    expect(strips.map((m) => m[2]).sort()).toEqual(['CENTS_STRIP', 'TEXT_STRIP']);
    for (const m of strips) {
      const rows = m[2] === 'CENTS_STRIP' ? 'CENTS_ROWS' : 'TEXT_ROWS';
      expect(m[1], m[2]).toContain(`height: lineHeight * ${rows}`);
    }
  });
});
