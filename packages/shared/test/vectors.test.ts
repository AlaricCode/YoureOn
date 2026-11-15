// SCHEMAS §11 rule 6 — test vectors ({name, input, canonical, hash}). CI runs them on Node;
// the mobile stream runs the same files once on Hermes (D1-M4).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  HearingRuling,
  Ruling,
  Terms,
  computeTermsHash,
  hashJcs,
  jcs,
  normTextDeep,
  sha256Hex,
} from '../src';

// Full values as printed in SCHEMAS.md (§2.5, §5.2, §6). Never edit these to match the code.
const DOC_TERMS_HASH = '05860f0a9c9034685ddbed902667f8453258056a21de30138b430ba3903f998f';
const DOC_RULING_HASH = '997ce27843ff323b7f7f8816f9eff0d0044a485a43c5625512a8967f82755daa';
const DOC_HEARING_HASH = 'a7721bbc9d1aebe51401ecfa0ebceda9f8845413517c60dabd406aea68fdd368';

interface Vector {
  name: string;
  schema: 'Terms' | 'Ruling' | 'HearingRuling';
  expect: 'ok' | 'throws';
  input: unknown;
  canonical: string | null;
  hash: string | null;
  normalized_hash?: string;
  note?: string;
}

const SCHEMAS: Record<Vector['schema'], z.ZodType> = { Terms, Ruling, HearingRuling };
/** [issue code, path] each "throws" vector must produce (§2.5: stray key; double space; NFD name). */
const THROWS_AT: Record<string, [string, string]> = {
  'terms-v1-extra-key': ['unrecognized_keys', ''],
  'terms-v1-non-normalized': ['custom', 'claim'],
  'terms-v1-nfd': ['custom', 'party_b.display_name'],
};
const dir = join(import.meta.dirname, 'vectors');
const vectors: Vector[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Vector);
const byName = (n: string): Vector => {
  const v = vectors.find((x) => x.name === n);
  if (!v) throw new Error(`missing vector ${n}`);
  return v;
};

describe('SCHEMAS §11 test vectors', () => {
  it('has the required vectors', () => {
    expect(vectors.map((v) => v.name)).toEqual(
      expect.arrayContaining([
        'terms-v1-001',
        'terms-v1-key-order',
        'terms-v1-nfc',
        'terms-v1-nfd',
        'terms-v1-extra-key',
        'terms-v1-non-normalized',
        'ruling-v1-001',
        'hearing-ruling-v1-001',
      ]),
    );
  });

  for (const v of vectors) {
    it(`${v.name} (${v.schema}, ${v.expect})`, () => {
      const schema = SCHEMAS[v.schema];
      if (v.expect === 'throws') {
        // Must fail as a validation error at the vector's documented spot, not crash elsewhere.
        const r = schema.safeParse(v.input);
        expect(r.success).toBe(false);
        expect(() => schema.parse(v.input)).toThrow(z.ZodError);
        const want = THROWS_AT[v.name];
        expect(want, `no expected issue registered for ${v.name}`).toBeDefined();
        if (!r.success && want)
          expect(r.error.issues.map((i) => [i.code, i.path.join('.')])).toContainEqual(want);
        return;
      }
      const parsed = schema.parse(v.input);
      expect(jcs(parsed)).toBe(v.canonical);
      expect(hashJcs(parsed)).toBe(v.hash);
      expect(sha256Hex(v.canonical!)).toBe(v.hash);
    });
  }
});

describe('D0-J1 CI checks', () => {
  it('terms-v1-001 hashes to 05860f0a…f998f (1,099 bytes canonical)', () => {
    const v = byName('terms-v1-001');
    const { canonical, terms_hash } = computeTermsHash(v.input);
    expect(terms_hash).toBe(DOC_TERMS_HASH);
    expect(canonical).toBe(v.canonical);
    expect(new TextEncoder().encode(canonical).length).toBe(1099);
  });

  it('the §5.2 ruling hashes to 997ce278…5daa (1,173 bytes canonical)', () => {
    const r = Ruling.parse(byName('ruling-v1-001').input);
    expect(hashJcs(r)).toBe(DOC_RULING_HASH);
    expect(new TextEncoder().encode(jcs(r)).length).toBe(1173);
  });

  it('the §6 hearing ruling hashes to a7721bbc…d368 (1,670 bytes canonical)', () => {
    const r = HearingRuling.parse(byName('hearing-ruling-v1-001').input);
    expect(hashJcs(r)).toBe(DOC_HEARING_HASH);
    expect(new TextEncoder().encode(jcs(r)).length).toBe(1670);
  });

  it('key order is irrelevant', () => {
    expect(computeTermsHash(byName('terms-v1-key-order').input).terms_hash).toBe(DOC_TERMS_HASH);
  });

  it('NFC: NFD input is rejected raw, and hashes like NFC after normText', () => {
    const nfc = byName('terms-v1-nfc');
    const nfd = byName('terms-v1-nfd');
    expect(() => Terms.parse(nfd.input)).toThrow();
    const normalized = computeTermsHash(normTextDeep(nfd.input));
    expect(normalized.terms_hash).toBe(nfc.hash);
    expect(normalized.terms_hash).toBe(nfd.normalized_hash);
    expect(computeTermsHash(nfc.input).terms_hash).toBe(nfc.hash);
    expect(nfc.hash).not.toBe(DOC_TERMS_HASH);
  });

  it('an extra key throws', () => {
    expect(() => computeTermsHash(byName('terms-v1-extra-key').input)).toThrow();
  });

  it('a non-normalized string throws', () => {
    expect(() => computeTermsHash(byName('terms-v1-non-normalized').input)).toThrow();
  });

  it('§2.4 "Zoë" example: NFC and NFD strings hash differently (c6a12698…f067 vs c106d155…f50f)', () => {
    // Escapes, not literals: an editor or formatter that normalizes source text must not hide the test.
    const nfc = sha256Hex('Zo\u00eb');
    const nfd = sha256Hex('Zoe\u0308');
    expect('Zoe\u0308'.normalize('NFC')).toBe('Zo\u00eb');
    expect(nfc).toBe('c6a12698582fc1104ea24107a2d7268145ff06ef859707729d01fd060897f067');
    expect(nfd).toBe('c106d15587c5ec6c0b5a6d6ff0da1ac753c5921fafab25e962dd81b0b3f3f50f');
    expect(nfc.startsWith('c6a12698') && nfc.endsWith('f067')).toBe(true);
    expect(nfd.startsWith('c106d155') && nfd.endsWith('f50f')).toBe(true);
  });

  it('example placeholders match their documented commands (§5.2, §6)', () => {
    const r = Ruling.parse(byName('ruling-v1-001').input);
    expect(r.evidence_hash).toBe(sha256Hex('example clip bytes'));
    expect(r.frame_hashes).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((k) => sha256Hex(`example frame ${k}`)),
    );
    const h = HearingRuling.parse(byName('hearing-ruling-v1-001').input);
    expect(h.arguments[0].transcript_sha256).toBe(
      sha256Hex('It hit the cap first and bounced, that is not a clean landing.'),
    );
    expect(h.arguments[1].transcript_sha256).toBe(sha256Hex('It ended standing up. Pay me.'));
  });
});
