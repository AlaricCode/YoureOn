/**
 * Small byte helpers shared by the evidence and identity modules (§0.1, §0.2).
 * Internal: not re-exported from the engine's public API.
 */
import bs58 from 'bs58';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error(`non-ASCII tag character in ${JSON.stringify(s)}`);
    out[i] = c;
  }
  return out;
}

export function u8(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`u8 out of range: ${n}`);
  return Uint8Array.of(n);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`u32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

export function u64le(n: bigint | number): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${v}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export function i64le(n: bigint | number): Uint8Array {
  if (typeof n === 'number' && !Number.isSafeInteger(n)) throw new RangeError(`i64 not a safe integer: ${n}`);
  const v = BigInt(n);
  if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError(`i64 out of range: ${v}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
}

export function readU64le(b: Uint8Array, off: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true);
}

/** Asserts a byte array of exact length. */
export function expectLen(b: Uint8Array, len: number, what: string): Uint8Array {
  if (!(b instanceof Uint8Array) || b.length !== len) {
    throw new RangeError(`${what} must be ${len} bytes`);
  }
  return b;
}

/** Decodes a base58 public key (exactly 32 bytes) or passes 32 raw bytes through. */
export function pubkeyBytes(key: string | Uint8Array, what = 'public key'): Uint8Array {
  if (key instanceof Uint8Array) return expectLen(key, 32, what);
  let raw: Uint8Array;
  try {
    raw = bs58.decode(key);
  } catch {
    throw new RangeError(`${what} is not valid base58`);
  }
  return expectLen(raw, 32, what);
}

export function toHex(b: Uint8Array): string {
  return bytesToHex(b);
}

/** Lowercase hex (no 0x) → bytes, optional exact length. */
export function fromHex(h: string, len?: number, what = 'hex'): Uint8Array {
  if (typeof h !== 'string' || !/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) {
    throw new RangeError(`${what} must be lowercase hex`);
  }
  const b = hexToBytes(h);
  if (len !== undefined) expectLen(b, len, what);
  return b;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Unsigned big-endian bytes → bigint. */
export function bytesToBigIntBE(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** bigint (0 ≤ v < 2^(8·len)) → big-endian bytes of fixed length. */
export function bigIntToBytesBE(v: bigint, len: number): Uint8Array {
  if (v < 0n || v >= 1n << BigInt(8 * len)) throw new RangeError(`value does not fit in ${len} bytes`);
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Little-endian bytes → bigint. */
export function bytesToBigIntLE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
}
