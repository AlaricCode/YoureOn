import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { addressToBytes, base58Decode, base58Encode, bytesEqual, concatBytes } from '../bytes';

describe('base58 matches @solana/kit codecs', () => {
  const kitToString = getBase58Decoder(); // bytes -> string
  const kitToBytes = getBase58Encoder(); // string -> bytes

  it('round-trips random buffers, including leading zeros', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array(32),
      Uint8Array.of(0, 0, 1),
      Uint8Array.of(255),
    ];
    for (let i = 0; i < 200; i++) {
      const b = new Uint8Array(randomBytes(1 + (i % 64)));
      if (i % 5 === 0) b[0] = 0;
      cases.push(b);
    }
    for (const b of cases) {
      const ours = base58Encode(b);
      expect(ours).toBe(kitToString.decode(b));
      expect(base58Decode(ours)).toEqual(new Uint8Array(kitToBytes.encode(ours)));
    }
  });

  it('knows the system program address', () => {
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
  });

  it('rejects invalid characters and wrong-length addresses', () => {
    expect(() => base58Decode('0OIl')).toThrow();
    expect(() => addressToBytes('1111')).toThrow();
  });
});

describe('misc', () => {
  it('concat and constant-time-ish equality', () => {
    expect(concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3))).toEqual(Uint8Array.of(1, 2, 3));
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 0))).toBe(false);
  });
});

describe('source guards', () => {
  // Every app source under src/ (not just the wallet: any screen could reach for getRandomBytes),
  // plus App.tsx. Test files are excluded.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const path = join(dir, d.name);
      if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(path);
      return /\.(ts|tsx)$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [path] : [];
    });
  const files = [...walk(srcDir), join(srcDir, '..', 'App.tsx')];
  const sources = files.map((path) => ({
    f: relative(srcDir, path),
    // Strip comments, so prose that names the forbidden calls doesn't count.
    code: readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, ''),
  }));

  it('finds the app sources', () => {
    expect(sources.map((s) => s.f)).toEqual(
      expect.arrayContaining([
        join('wallet', 'wallet.ts'),
        join('wallet', 'expoPlatform.ts'),
        join('wallet', 'pda.ts'),
        join('diagnostics', 'autoChecks.ts'),
      ]),
    );
  });

  it('never calls getRandomBytes (Math.random in __DEV__) or noble keygen()', () => {
    for (const { f, code } of sources) {
      expect(code, f).not.toMatch(/getRandomBytes\b/);
      expect(code, f).not.toMatch(/\bkeygen(Async)?\s*\(/);
      expect(code, f).not.toMatch(/randomSecretKey/);
    }
  });

  it('never sets requireAuthentication: true', () => {
    for (const { f, code } of sources)
      expect(code, f).not.toMatch(/requireAuthentication\s*:\s*true/);
  });

  it('does not import @solana/kit in app code (dev/test only; its PDA helper throws on Hermes)', () => {
    for (const { f, code } of sources) expect(code, f).not.toMatch(/from '@solana\/kit'/);
  });
});
