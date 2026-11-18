import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { JCS_VECTORS, jcsVectorsCheck, runJcsVectors, type JcsVector } from '../jcsVectors';

describe('jcs-vectors diagnostics check', () => {
  it('bundles every committed vector file', () => {
    const files = readdirSync(
      new URL('../../../../../packages/shared/test/vectors', import.meta.url).pathname,
    )
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(JCS_VECTORS.map((v) => v.name).sort()).toEqual(files);
  });

  it('passes on Node (the same code runs on Hermes)', () => {
    const r = runJcsVectors();
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(jcsVectorsCheck()).toMatch(/^10\/10 vectors match/);
  });

  it('fails the row when a hash differs', () => {
    const bad: JcsVector[] = JCS_VECTORS.map((v) =>
      v.name === 'terms-v1-001' ? { ...v, hash: '00'.repeat(32) } : v,
    );
    expect(runJcsVectors(bad).find((x) => x.name === 'terms-v1-001')!.ok).toBe(false);
  });
});
