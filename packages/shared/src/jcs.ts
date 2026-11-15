// SCHEMAS §2.4 — RFC 8785 JCS canonicalization (`canonicalize`) + SHA-256. Used for
// terms_hash, ruling_hash (Ruling / HearingRuling / AppealResult) and the Gemini evidence_hash.
import canonicalize from 'canonicalize';
import { isWellFormedUtf16, sha256Hex } from './primitives';

/**
 * canonicalize@5.1.0 calls ES2024 `String.prototype.isWellFormed()` on every key and string value
 * (lib/canonicalize.js serializeString). Hermes support for it is unverified (SCHEMAS §11 rule 6),
 * and a missing method would make every jcs()/hashJcs() call — including the TermsEnvelope hash
 * check on the phone — throw a TypeError. Install a spec-equivalent fallback only when the engine
 * lacks the method; on Node / V8 this is a no-op.
 */
export function ensureStringIsWellFormed(): void {
  const proto = String.prototype as { isWellFormed?: unknown };
  if (typeof proto.isWellFormed === 'function') return;
  Object.defineProperty(String.prototype, 'isWellFormed', {
    value: function isWellFormed(this: unknown): boolean {
      return isWellFormedUtf16(String(this));
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function jcs(value: unknown): string {
  ensureStringIsWellFormed();
  const s = canonicalize(value);
  if (s === undefined) throw new Error('value is not JCS-serializable');
  return s;
}

/** sha256(UTF-8(JCS(value))) as lowercase hex. Callers parse with the record's schema first. */
export const hashJcs = (value: unknown): string => sha256Hex(jcs(value));
