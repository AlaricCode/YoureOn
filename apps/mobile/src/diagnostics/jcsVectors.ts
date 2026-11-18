// SCHEMAS §11 rule 6 on Hermes (TASKS D1-M4): run the packages/shared JCS / terms-hash test
// vectors on the phone and compare to the committed hashes. Hermes differs from Node in exactly
// the places JCS depends on (String.prototype.normalize('NFC') in primitives.ts, number
// formatting, UTF-8 encoding), so a pass here is what lets both phones trust terms_hash.
// Pure TS: the same function runs in vitest on Node.
import { HearingRuling } from '@youre-on/shared/hearing';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { normTextDeep, sha256Hex } from '@youre-on/shared/primitives';
import { Ruling } from '@youre-on/shared/ruling';
import { Terms, computeTermsHash } from '@youre-on/shared/terms';
import type { z } from 'zod/v4';

import hearing001 from '../../../../packages/shared/test/vectors/hearing-ruling-v1-001.json';
import ruling001 from '../../../../packages/shared/test/vectors/ruling-v1-001.json';
import terms001 from '../../../../packages/shared/test/vectors/terms-v1-001.json';
import termsExtraKey from '../../../../packages/shared/test/vectors/terms-v1-extra-key.json';
import termsKeyOrder from '../../../../packages/shared/test/vectors/terms-v1-key-order.json';
import termsNfc from '../../../../packages/shared/test/vectors/terms-v1-nfc.json';
import termsNfd from '../../../../packages/shared/test/vectors/terms-v1-nfd.json';
import termsNonNormalized from '../../../../packages/shared/test/vectors/terms-v1-non-normalized.json';

export interface JcsVector {
  name: string;
  schema: 'Terms' | 'Ruling' | 'HearingRuling';
  expect: 'ok' | 'throws';
  input: unknown;
  canonical: string | null;
  hash: string | null;
  normalized_hash?: string;
}

export const JCS_VECTORS: readonly JcsVector[] = [
  terms001,
  termsKeyOrder,
  termsNfc,
  termsNfd,
  termsExtraKey,
  termsNonNormalized,
  ruling001,
  hearing001,
] as JcsVector[];

/** SCHEMAS §2.5 as printed: the demo bet's terms_hash. */
export const DOC_TERMS_HASH = '05860f0a9c9034685ddbed902667f8453258056a21de30138b430ba3903f998f';

const SCHEMAS: Record<JcsVector['schema'], z.ZodType> = { Terms, Ruling, HearingRuling };

export interface VectorResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function runJcsVectors(vectors: readonly JcsVector[] = JCS_VECTORS): VectorResult[] {
  const out: VectorResult[] = [];
  for (const v of vectors) {
    try {
      const schema = SCHEMAS[v.schema];
      if (v.expect === 'throws') {
        const r = schema.safeParse(v.input);
        out.push({ name: v.name, ok: !r.success, detail: r.success ? 'parsed but must throw' : 'rejected' });
        continue;
      }
      const parsed = schema.parse(v.input);
      const canonical = jcs(parsed);
      const hash = hashJcs(parsed);
      const ok = canonical === v.canonical && hash === v.hash && sha256Hex(v.canonical ?? '') === v.hash;
      out.push({ name: v.name, ok, detail: ok ? hash.slice(0, 12) : `got ${hash.slice(0, 12)}, want ${(v.hash ?? '').slice(0, 12)}` });
    } catch (e) {
      out.push({ name: v.name, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    }
  }
  // NFC: NFD input normalizes (String.prototype.normalize on Hermes) to the NFC vector's hash.
  const nfd = vectors.find((v) => v.name === 'terms-v1-nfd');
  const nfc = vectors.find((v) => v.name === 'terms-v1-nfc');
  if (nfd && nfc) {
    try {
      const h = computeTermsHash(normTextDeep(nfd.input)).terms_hash;
      const ok = h === nfc.hash && h === nfd.normalized_hash && 'Zoë'.normalize('NFC') === 'Zoë';
      out.push({ name: 'nfd->nfc', ok, detail: ok ? h.slice(0, 12) : `got ${h.slice(0, 12)}` });
    } catch (e) {
      out.push({ name: 'nfd->nfc', ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e) });
    }
  }
  const t = vectors.find((v) => v.name === 'terms-v1-001');
  if (t) {
    const h = computeTermsHash(t.input).terms_hash;
    out.push({ name: 'doc-terms-hash', ok: h === DOC_TERMS_HASH, detail: h.slice(0, 12) });
  }
  return out;
}

/** The diagnostics row body: throws (fails the row) on any mismatch. */
export function jcsVectorsCheck(): string {
  const results = runJcsVectors();
  const bad = results.filter((r) => !r.ok);
  if (bad.length > 0) throw new Error(bad.map((b) => `${b.name}: ${b.detail}`).join('; '));
  return `${results.length}/${results.length} vectors match (terms ${DOC_TERMS_HASH.slice(0, 8)})`;
}
