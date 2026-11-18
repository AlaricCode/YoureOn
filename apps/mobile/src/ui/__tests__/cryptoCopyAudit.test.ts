// TASKS D5-M2 crypto-copy audit, as a test: no string a party screen can show may say SOL,
// USDC, Solana, lamports, gas, seed phrase, wallet, transaction, devnet or blockchain
// (ui/copyRule CRYPTO_JARGON). It reads the screen sources and checks every string literal and
// every piece of JSX text; comments and import paths are skipped, since nobody sees them.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CRYPTO_JARGON } from '../copyRule';

const SRC = join(__dirname, '..', '..');

/** Everything that renders on a party's phone. */
const SCREEN_DIRS = ['screens', 'enroll', 'signup', 'app', 'face', 'gg'];
const SCREEN_FILES = ['ui/kit.tsx', 'ui/parts.tsx', 'ui/brand.tsx'];

const sources = (): string[] => [
  ...SCREEN_DIRS.flatMap((d) =>
    readdirSync(join(SRC, d))
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => join(d, f)),
  ),
  ...SCREEN_FILES,
];

/** String literals and JSX text, with comments and import/export-from lines removed. */
export function visibleStrings(code: string): string[] {
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .replace(/^\s*(import|export)\b[^;]*\bfrom\s+['"][^'"]+['"];?/gm, '');
  const out: string[] = [];
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>([^<>{}\n]+)</g;
  for (const m of noComments.matchAll(re)) out.push(m[1] ?? m[0].slice(1, -1));
  return out.filter((s) => s.trim() !== '');
}

describe('crypto-copy audit (party screens)', () => {
  it('finds the screen sources', () => {
    expect(sources().length).toBeGreaterThan(10);
  });

  it.each(sources())('%s says nothing about chains or wallets', (file) => {
    const hits = visibleStrings(readFileSync(join(SRC, file), 'utf8')).filter((s) =>
      CRYPTO_JARGON.some((re) => re.test(s)),
    );
    expect(hits).toEqual([]);
  });

  it('catches the words it is meant to', () => {
    const sample = `<Text>Your wallet</Text>; label('Paid in USDC'); x = "seed phrase"; // wallet in a comment`;
    const hits = visibleStrings(sample).filter((s) => CRYPTO_JARGON.some((re) => re.test(s)));
    expect(hits).toEqual(['Your wallet', 'Paid in USDC', 'seed phrase']);
  });
});
