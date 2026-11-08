/**
 * Byte/encoding helpers for the API (§0.2): base64 (standard, padded), hex
 * (lowercase), base58 (Solana keys, signatures).
 */
import bs58 from 'bs58';

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict standard base64 with padding; throws on anything else. */
export function fromBase64(s: string): Uint8Array {
  if (typeof s !== 'string' || !B64_RE.test(s)) throw new Error('invalid base64');
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
}

export function fromHex(h: string, expectedLen?: number): Uint8Array {
  if (typeof h !== 'string' || h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(Buffer.from(h, 'hex'));
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`hex: expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
}

export function toBase58(b: Uint8Array): string {
  return bs58.encode(b);
}

export function fromBase58(s: string): Uint8Array {
  return bs58.decode(s);
}

/** True iff `s` is a base58 string decoding to exactly 32 bytes. */
export function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** JSON replacer turning bigint into a decimal string (never emitted as a float). */
export function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
