/**
 * Canonical JSON (§4.1): RFC 8785 (JCS) restricted to integers.
 *
 * - Objects: keys sorted ascending by UTF-16 code units; no duplicate keys
 *   (after NFC normalization); members whose value is `undefined` omitted;
 *   `null` forbidden.
 * - Numbers: safe integers only, shortest decimal; `-0` is written `0`.
 * - Strings: NFC-normalized; escapes `\" \\ \b \f \n \r \t`, other code points
 *   < 0x20 as `\u00xx` (lowercase hex); everything else literal (incl. `/`).
 *   Lone surrogates are rejected (not representable in UTF-8).
 * - No whitespace; arrays keep order.
 */
import { sha256 } from './sha256.js';
import { bytesToHex, utf8 } from './bytes.js';
import type { Hex32 } from '../types.js';

/** Thrown for values outside the canonical JSON domain. */
export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`canonicalJson: ${message} at ${path || '$'}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

const SHORT_ESCAPES: Record<number, string> = {
  0x22: '\\"',
  0x5c: '\\\\',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
};

function quote(raw: string, path: string): string {
  const s = raw.normalize('NFC');
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) throw new CanonicalJsonError(path, 'lone surrogate in string');
      out += s[i]! + s[i + 1]!;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalJsonError(path, 'lone surrogate in string');
    const esc = SHORT_ESCAPES[c];
    if (esc !== undefined) out += esc;
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s[i]!;
  }
  return out + '"';
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function ser(v: unknown, path: string, stack: Set<object>): string {
  switch (typeof v) {
    case 'string':
      return quote(v, path);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new CanonicalJsonError(path, `non-integer or unsafe number ${String(v)}`);
      return v === 0 ? '0' : String(v);
    case 'object': {
      if (v === null) throw new CanonicalJsonError(path, 'null is forbidden');
      if (stack.has(v)) throw new CanonicalJsonError(path, 'cyclic value');
      stack.add(v);
      try {
        if (Array.isArray(v)) {
          const parts: string[] = [];
          for (let i = 0; i < v.length; i++) {
            if (!(i in v) || v[i] === undefined) throw new CanonicalJsonError(`${path}[${i}]`, 'undefined array element');
            parts.push(ser(v[i], `${path}[${i}]`, stack));
          }
          return '[' + parts.join(',') + ']';
        }
        if (!isPlainObject(v)) throw new CanonicalJsonError(path, 'only plain objects and arrays are allowed');
        const members: [string, string][] = [];
        const seen = new Set<string>();
        for (const key of Object.keys(v)) {
          const val = (v as Record<string, unknown>)[key];
          if (val === undefined) continue;
          const nk = key.normalize('NFC');
          if (seen.has(nk)) throw new CanonicalJsonError(path, `duplicate key ${JSON.stringify(nk)}`);
          seen.add(nk);
          const childPath = `${path}.${key}`;
          members.push([nk, quote(nk, childPath) + ':' + ser(val, childPath, stack)]);
        }
        // Default string comparison is by UTF-16 code units (RFC 8785 §3.2.3).
        members.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return '{' + members.map((m) => m[1]).join(',') + '}';
      } finally {
        stack.delete(v);
      }
    }
    default:
      throw new CanonicalJsonError(path, `unsupported type ${typeof v}`);
  }
}

/** Canonical JSON string of `v` (§4.1). Throws `CanonicalJsonError` outside the domain. */
export function canonicalJson(v: unknown): string {
  return ser(v, '', new Set());
}

/** UTF-8 bytes of `canonicalJson(v)`. */
export function canonicalJsonBytes(v: unknown): Uint8Array {
  return utf8(canonicalJson(v));
}

/** `sha256(utf8(canonicalJson(v)))` as raw bytes. */
export function canonicalJsonHash(v: unknown): Uint8Array {
  return sha256(canonicalJsonBytes(v));
}

/** `sha256(utf8(canonicalJson(v)))` as lowercase hex. */
export function canonicalJsonHashHex(v: unknown): Hex32 {
  return bytesToHex(canonicalJsonHash(v));
}
