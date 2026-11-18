import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CHECKS, getCheck, REQUIRED_CHECK_IDS } from '../catalog';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('diagnostics catalog (TASKS D0-M2)', () => {
  it('has exactly the eight required checks from the D0-M2 list, in its order', () => {
    expect(REQUIRED_CHECK_IDS).toEqual([
      'vision-camera-preview',
      'tflite-warmup',
      'mlkit-still-face',
      'expo-camera-record',
      'local-auth-hardware',
      'secure-store-rw',
      'haptics',
      'mic-livekit',
    ]);
  });

  it('has unique ids', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every interactive check a camera panel and no other check one', () => {
    for (const c of CHECKS) {
      if (c.kind === 'interactive') expect('panel' in c && c.panel).toBeTruthy();
      else expect('panel' in c).toBe(false);
    }
  });

  it('getCheck finds by id and throws on an unknown one', () => {
    expect(getCheck('haptics').kind).toBe('confirm');
    expect(() => getCheck('nope' as never)).toThrow(/unknown check/);
  });

  it('implements a body for every auto/confirm check, and none for interactive ones', () => {
    // autoChecks.ts imports native modules lazily, so read its source rather than importing it.
    const src = read('../autoChecks.ts');
    const block = src.slice(src.indexOf('export const AUTO_CHECKS'));
    for (const c of CHECKS) {
      const key = new RegExp(`(^|\\s)('${c.id}'|${c.id.replace(/-/g, '_')})(:|,)`, 'm');
      if (c.kind === 'interactive') expect(block).not.toMatch(key);
      else expect(block, c.id).toMatch(key);
    }
  });

  it('records every interactive check from its panel', () => {
    const vision = read('../VisionCameraPanel.tsx');
    const expo = read('../ExpoCameraPanel.tsx');
    for (const c of CHECKS) {
      if (c.kind !== 'interactive') continue;
      const src = c.panel === 'vision' ? vision : expo;
      expect(src, c.id).toContain(`'${c.id}'`);
    }
  });

  it('only imports native modules lazily in autoChecks (one missing module fails one row)', () => {
    const src = read('../autoChecks.ts');
    const staticImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)].map(
      (m) => m[1],
    );
    // The one static import is the pure-TS guard that keeps a failing module from crashing.
    expect(staticImports).toEqual(['../app/importSafely']);
  });

  it('loads every native module through importSafely (a bare import() crashes on failure)', () => {
    const src = read('../autoChecks.ts');
    const dynamic = [...src.matchAll(/import\('([^']+)'\)/g)].length;
    const guarded = [...src.matchAll(/importSafely\(\(\) => import\('([^']+)'\)\)/g)].length;
    expect(dynamic).toBeGreaterThan(0);
    expect(guarded).toBe(dynamic);
  });
});
