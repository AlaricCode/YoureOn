/**
 * Cross-checks constants.ts against the §0.5 table and the §2.5.4 / §9.6 lists
 * of docs/CONTRACTS.md, so drift between the document and the code fails CI.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, GLOBAL_CONSTANTS, RESERVED_WORDS } from '../src/constants.js';

const contractPath = fileURLToPath(new URL('../../../docs/CONTRACTS.md', import.meta.url));
const hasContract = existsSync(contractPath);
const doc = hasContract ? readFileSync(contractPath, 'utf8') : '';

function section(startHeader: string, endHeader: string): string {
  const start = doc.indexOf(startHeader);
  const end = doc.indexOf(endHeader, start + 1);
  if (start < 0 || end < 0) throw new Error(`section ${startHeader} not found`);
  return doc.slice(start, end);
}

describe.skipIf(!hasContract)('constants match docs/CONTRACTS.md', () => {
  it('§0.5 table: every name and value', () => {
    const table = section('### 0.5 Global constants', '### 0.6');
    const expected = new Map<string, number>();
    for (const line of table.split('\n')) {
      const m = /^\| `([A-Z0-9_]+)`(?: \/ `([A-Z0-9_]+)`)? \| ([0-9 /]+) \|/.exec(line);
      if (!m) continue;
      const values = m[3]!.split('/').map((v) => Number(v.trim()));
      expected.set(m[1]!, values[0]!);
      if (m[2]) expected.set(m[2], values[1]!);
    }
    expect(expected.size).toBe(83);
    const actual = new Map(Object.entries(GLOBAL_CONSTANTS));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, value] of expected) {
      expect(actual.get(name), name).toBe(value);
    }
  });

  it('§2.5.4 reserved words', () => {
    const m = /\*\*Reserved words\*\*: `([^`]+)`/.exec(doc);
    expect(m).not.toBeNull();
    expect([...RESERVED_WORDS]).toEqual(m![1]!.trim().split(/\s+/));
  });

  it('§9.6 error names and numbering', () => {
    const errs = /^`(6000 [^`]+)`/m.exec(section('### 9.6 Errors', '### 9.7'))![1]!;
    const pairs = [...errs.matchAll(/(\d{4}) ([A-Za-z0-9]+)/g)].map((m) => [Number(m[1]), m[2]] as const);
    expect(pairs).toHaveLength(ERROR_CODES.length);
    pairs.forEach(([code, name], i) => {
      expect(code).toBe(6000 + i);
      expect(ERROR_CODES[i]).toBe(name);
    });
  });
});
