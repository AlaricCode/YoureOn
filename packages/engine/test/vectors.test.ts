/**
 * Golden vectors (§0.6): the committed testvectors/ are exactly what
 * `npm run vectors` generates, and every vector re-evaluates from its hex
 * fields alone (the path crates/verdict-rules and the LiteSVM tests take).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  decodeProgram,
  encodeCalibration,
  encodeProgram,
  evaluate,
  hexToBytes,
  isEngineError,
  jsonHash,
  parseYaml,
  programHash,
  toYaml,
} from '../src/index.js';
import type { Checkpoint, EvalOptions, Program } from '../src/types.js';
import { buildFiles, FUZZ_CASES, FUZZ_FILE, REQUIRED_COVERAGE } from '../scripts/vectors/index.js';
import { ctxFor } from '../scripts/vectors/common.js';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../testvectors');

type Vec = Record<string, unknown> & { expected: Record<string, unknown> };

function third(v: Record<string, unknown>): Uint8Array {
  return hexToBytes((v.track_bin ?? v.market_bin ?? '') as string);
}

function opts(v: Record<string, unknown>): EvalOptions | undefined {
  const o = v.opts as { maxCost: number | null } | undefined;
  return o ? { maxCost: o.maxCost === null ? Infinity : o.maxCost } : undefined;
}

/** Evaluate from hex; returns the §9.6 error name or the comparable result fields. */
function run(v: Record<string, unknown>, verified: Checkpoint[]): Record<string, unknown> {
  try {
    const r = evaluate(hexToBytes(v.program_bin as string), hexToBytes(v.calibration_bin as string), third(v), verified, opts(v));
    return { ...r };
  } catch (e) {
    if (isEngineError(e)) return { error: e.code };
    throw e;
  }
}

describe('testvectors/ (§0.6)', () => {
  const files = buildFiles();

  it('the committed files are up to date (`npm run vectors -- --check`)', () => {
    expect(existsSync(DIR)).toBe(true);
    const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).sort();
    expect(onDisk).toEqual([...files.keys()].sort());
    for (const [name, content] of files) expect(readFileSync(join(DIR, name), 'utf8'), name).toBe(content);
  });

  it('cover every §0.6 item and every MOCK_SCENARIO', () => {
    const index = JSON.parse(files.get('index.json')!) as { coverage: Record<string, string[]> };
    for (const tag of REQUIRED_COVERAGE) expect(index.coverage[tag]?.length ?? 0, tag).toBeGreaterThan(0);
  });

  const named = [...files.entries()].filter(([n]) => n.endsWith('.json') && n !== 'index.json').map(([, c]) => JSON.parse(c) as Vec);

  it('every named vector re-evaluates to its expected result from hex alone', () => {
    expect(named.length).toBeGreaterThan(200);
    for (const v of named) {
      const got = run(v, (v.verified_checkpoints as Checkpoint[]) ?? []);
      if ('error' in v.expected) expect(got, v.name as string).toEqual(v.expected);
      else for (const [k, want] of Object.entries(v.expected)) expect(got[k], `${v.name as string}.${k}`).toEqual(want);
    }
  });

  it('program fields are consistent: yaml round-trip, json hash, program_bin, calibration_bin', () => {
    for (const v of named) {
      if (!v.program) continue;
      const p = v.program as Program;
      expect(v.program_canonical_json).toBe(canonicalJson(p));
      expect(v.json_hash).toBe(jsonHash(p));
      expect(v.program_bin).toBe(Buffer.from(encodeProgram(p)).toString('hex'));
      expect(v.program_hash).toBe(programHash(p));
      expect(v.yaml).toBe(toYaml(p));
      expect(v.calibration_bin).toBe(Buffer.from(encodeCalibration(v.calibration as never, p)).toString('hex'));
      expect(decodeProgram(encodeProgram(p)).json_hash).toBe(v.json_hash);
      if (!v.compile_errors) {
        const back = parseYaml(v.yaml as string, ctxFor(p));
        expect(back.ok && canonicalJson(back.program), v.name as string).toBe(canonicalJson(p));
      }
    }
  });

  it(`${FUZZ_FILE}: ${FUZZ_CASES} seeded cases (seed 1) re-evaluate from hex`, () => {
    const lines = files.get(FUZZ_FILE)!.trim().split('\n');
    expect(lines.length).toBe(FUZZ_CASES);
    expect(lines.length).toBeGreaterThanOrEqual(2000);
    const reasons = new Set<number>();
    for (const line of lines) {
      const v = JSON.parse(line) as Vec;
      const got = run(v, v.verified as Checkpoint[]);
      for (const k of ['status', 'reason', 'leg_results', 'leg_causes', 'preruling', 'winner_mask', 'n_checkpoints', 'checkpoints', 'decisive_frames']) {
        expect(got[k], `case ${v.case as number}.${k}`).toEqual(v.expected[k]);
      }
      reasons.add(v.expected.reason as number);
    }
    expect([...reasons].sort()).toEqual([0, 10, 11, 12, 13]);
  });
});
