/**
 * Byte helpers for the chain model (§0.1, §0.2): hex / base58 conversion,
 * a Borsh writer and a strict Borsh reader, and sha256.
 *
 * Kept local to the chain module so it has no dependency on modules that are
 * implemented separately; all formats are fully specified by the contract.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

export const ZERO_KEY = '11111111111111111111111111111111';
export const ZERO_HASH = '0'.repeat(64);

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function sha256(...parts: Uint8Array[]): Uint8Array {
  return nobleSha256(concatBytes(...parts));
}

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

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error('ascii: non-ASCII character');
    out[i] = c;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string, expectedLen?: number): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) throw new Error(`invalid hex: ${h.slice(0, 16)}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`expected ${expectedLen} bytes of hex, got ${out.length}`);
  }
  return out;
}

/** 32-byte hash from hex or raw bytes. */
export function hash32(h: string | Uint8Array): Uint8Array {
  const b = typeof h === 'string' ? fromHex(h.toLowerCase(), 32) : h;
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return b;
}

export function pubkeyBytes(k: string | Uint8Array): Uint8Array {
  const b = typeof k === 'string' ? bs58.decode(k) : k;
  if (b.length !== 32) throw new Error(`invalid pubkey: ${typeof k === 'string' ? k : '<bytes>'}`);
  return b;
}

export function pubkeyString(b: Uint8Array): string {
  if (b.length !== 32) throw new Error('pubkey must be 32 bytes');
  return bs58.encode(b);
}

/** Normalizes a base58 key (e.g. canonical form) for comparisons. */
export function isValidPubkey(k: string): boolean {
  try {
    return bs58.decode(k).length === 32;
  } catch {
    return false;
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (no Buffer dependency). */
export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    s += i + 1 < b.length ? B64[(n >> 6) & 63]! : '=';
    s += i + 2 < b.length ? B64[n & 63]! : '=';
  }
  return s;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('invalid base64');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = clean[i + j]!;
      n = (n << 6) | (c === '=' ? 0 : B64.indexOf(c));
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Borsh writer (little-endian, packed). */
export class BorshWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  private uint(v: number | bigint, bytes: number, label: string): this {
    const x = BigInt(v);
    if (x < 0n || x >= 1n << BigInt(8 * bytes)) throw new Error(`${label} out of range: ${x}`);
    this.ensure(bytes);
    let y = x;
    for (let i = 0; i < bytes; i++) {
      this.buf[this.len++] = Number(y & 0xffn);
      y >>= 8n;
    }
    return this;
  }

  u8(v: number): this {
    return this.uint(v, 1, 'u8');
  }
  u16(v: number): this {
    return this.uint(v, 2, 'u16');
  }
  u32(v: number): this {
    return this.uint(v, 4, 'u32');
  }
  u64(v: bigint | number): this {
    if (BigInt(v) > U64_MAX) throw new Error('u64 out of range');
    return this.uint(v, 8, 'u64');
  }
  i64(v: bigint | number): this {
    const x = BigInt(v);
    if (x < I64_MIN || x > I64_MAX) throw new Error('i64 out of range');
    return this.uint(x < 0n ? x + (1n << 64n) : x, 8, 'i64');
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  raw(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  fixed(b: Uint8Array, n: number): this {
    if (b.length !== n) throw new Error(`expected ${n} bytes, got ${b.length}`);
    return this.raw(b);
  }
  pubkey(k: string | Uint8Array): this {
    return this.raw(pubkeyBytes(k));
  }
  hash(h: string | Uint8Array): this {
    return this.raw(hash32(h));
  }
  /** Vec<u8> */
  bytes(b: Uint8Array): this {
    this.u32(b.length);
    return this.raw(b);
  }
  string(s: string): this {
    return this.bytes(utf8(s));
  }
  vec<T>(items: readonly T[], f: (w: this, item: T) => void): this {
    this.u32(items.length);
    for (const it of items) f(this, it);
    return this;
  }
  array<T>(items: readonly T[], n: number, f: (w: this, item: T) => void): this {
    if (items.length !== n) throw new Error(`expected array of ${n}, got ${items.length}`);
    for (const it of items) f(this, it);
    return this;
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Strict Borsh reader: throws on short reads, invalid bools and invalid UTF-8. */
export class BorshReader {
  offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.buf.length) throw new Error('borsh: unexpected end of data');
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private uint(bytes: number): bigint {
    const b = this.take(bytes);
    let x = 0n;
    for (let i = bytes - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
    return x;
  }

  u8(): number {
    return Number(this.uint(1));
  }
  u16(): number {
    return Number(this.uint(2));
  }
  u32(): number {
    return Number(this.uint(4));
  }
  u64(): bigint {
    return this.uint(8);
  }
  i64(): bigint {
    const x = this.uint(8);
    return x >= 1n << 63n ? x - (1n << 64n) : x;
  }
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new Error('borsh: invalid bool');
    return v === 1;
  }
  raw(n: number): Uint8Array {
    return this.take(n).slice();
  }
  pubkey(): string {
    return pubkeyString(this.take(32));
  }
  hash(): string {
    return toHex(this.take(32));
  }
  bytes(): Uint8Array {
    const n = this.u32();
    return this.raw(n);
  }
  string(): string {
    const b = this.bytes();
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  }
  vec<T>(f: (r: this) => T, maxLen = 1 << 16): T[] {
    const n = this.u32();
    if (n > maxLen) throw new Error('borsh: vec too long');
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(f(this));
    return out;
  }
  array<T>(n: number, f: (r: this) => T): T[] {
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(f(this));
    return out;
  }
  end(): void {
    if (this.remaining !== 0) throw new Error(`borsh: ${this.remaining} trailing bytes`);
  }
}

/** Anchor discriminator: sha256(prefix + name)[0..8]. */
export function discriminator(prefix: string, name: string): Uint8Array {
  return sha256(ascii(prefix + name)).slice(0, 8);
}
