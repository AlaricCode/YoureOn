import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLOBAL_CONSTANTS } from '../src/constants.js';
import { diffDartConstants, docComments, parseDartConstants, renderDartConstants } from '../scripts/gen-dart-lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/constants.ts'), 'utf8');

describe('npm run gen:dart (§0.5 → app/lib/contracts/constants.dart)', () => {
  it('renders every §0.5 constant with its value, in table order', () => {
    const dart = renderDartConstants(src);
    const parsed = parseDartConstants(dart);
    expect([...parsed.keys()]).toEqual(Object.keys(GLOBAL_CONSTANTS));
    expect(diffDartConstants(parsed)).toEqual([]);
    expect(dart).toContain('const int MAX_STAKE_UNITS = 1000000000000;');
  });

  it('takes doc comments from the JSDoc directly above each constant', () => {
    const docs = docComments(src);
    expect(docs.FPS).toMatch(/^Track frame rate/);
    expect(Object.values(docs).every((d) => !d.includes('*/') && !d.includes('export const'))).toBe(true);
  });

  it('detects missing, extra and wrong values', () => {
    const m = parseDartConstants('const int FPS = 11;\nconst int NOPE = 1;\nconst int MAX_STAKE_UNITS = 1_000_000_000_000;');
    const problems = diffDartConstants(m);
    expect(problems).toContain('FPS = 11, engine 10');
    expect(problems).toContain('extra NOPE (not in §0.5)');
    expect(problems).toContain('missing COORD_MAX');
    expect(problems.some((p) => p.startsWith('MAX_STAKE_UNITS'))).toBe(false);
  });

  const appFile = resolve(here, '../../../app/lib/contracts/constants.dart');
  it.runIf(existsSync(appFile))('the App copy matches the engine values', () => {
    expect(diffDartConstants(parseDartConstants(readFileSync(appFile, 'utf8')))).toEqual([]);
  });
});
