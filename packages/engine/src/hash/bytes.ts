/**
 * Byte helpers shared by the hash and encode modules (§0.1, §0.2).
 *
 * Pure: no I/O. Hex is lowercase without `0x` (§0.2); pubkeys are base58.
 */
import bs58 from 'bs58';
import type { Hex32, Pubkey } from '../types.js';

const HEX_RE = /^[0-9a-f]*$/;

/** Lowercase hex of `bytes` (no `0x`). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

/**
 * Parse lowercase hex (even length, no `0x`). Uppercase is rejected because the
 * JSON encoding of hashes is lowercase only (§0.2).
 */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new TypeError(`invalid lowercase hex string`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** True iff `s` is a 64-char lowercase hex digest. */
export function isHex32(s: unknown): s is Hex32 {
  return typeof s === 'string' && s.length === 64 && HEX_RE.test(s);
}

/** A 32-byte value given as raw bytes or as lowercase hex (§0.2). */
export type Bytes32Input = Uint8Array | Hex32;

/** Coerce a 32-byte value (bytes or lowercase hex) to bytes; throws on wrong length. */
export function toBytes32(v: Bytes32Input, what = 'value'): Uint8Array {
  const b = typeof v === 'string' ? (isHex32(v) ? hexToBytes(v) : null) : v;
  if (!(b instanceof Uint8Array) || b.length !== 32) {
    throw new TypeError(`${what} must be 32 bytes (Uint8Array or 64-char lowercase hex)`);
  }
  return b;
}

/** Concatenate byte arrays (`‖`). */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Byte-wise equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ENCODER = new TextEncoder();

/** UTF-8 bytes of a string (ASCII tags are their raw bytes, §0.3). */
export function utf8(s: string): Uint8Array {
  return ENCODER.encode(s);
}

/** Decode a base58 Solana public key to its 32 raw bytes; throws if not exactly 32 bytes. */
export function pubkeyToBytes(pk: Pubkey | Uint8Array): Uint8Array {
  if (pk instanceof Uint8Array) {
    if (pk.length !== 32) throw new TypeError('pubkey must be 32 bytes');
    return pk;
  }
  let raw: Uint8Array;
  try {
    raw = bs58.decode(pk);
  } catch {
    throw new TypeError(`invalid base58 pubkey: ${String(pk)}`);
  }
  if (raw.length !== 32) throw new TypeError(`pubkey must decode to 32 bytes: ${pk}`);
  // Canonical base58 only (no leading-zero ambiguity): must round-trip.
  if (bs58.encode(raw) !== pk) throw new TypeError(`non-canonical base58 pubkey: ${pk}`);
  return raw;
}

/** Encode 32 raw bytes as a base58 pubkey. */
export function bytesToPubkey(b: Uint8Array): Pubkey {
  if (b.length !== 32) throw new TypeError('pubkey must be 32 bytes');
  return bs58.encode(b);
}

/** 32 zero bytes (calibration_hash for ai_judged/market, typed-dictation h_0, …). */
export function zero32(): Uint8Array {
  return new Uint8Array(32);
}

/** `"00" × 32`. */
export const ZERO_HASH_HEX: Hex32 = '0'.repeat(64);
