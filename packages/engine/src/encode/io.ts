/**
 * Little-endian byte writer / bounds-checked reader (§0.1).
 * The reader throws `EngineError(code)` on truncation so each decoder reports
 * its own §9.6 error name.
 */
import type { ErrorCode } from '../types.js';
import { EngineError } from './errors.js';

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  get length(): number {
    return this.len;
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.ensure(1);
    this.buf[this.len++] = v;
    return this;
  }

  i8(v: number): this {
    if (!Number.isInteger(v) || v < -128 || v > 127) throw new RangeError(`i8 out of range: ${v}`);
    return this.u8(v & 0xff);
  }

  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    this.ensure(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
    this.ensure(4);
    this.view.setUint32(this.len, v, true);
    this.len += 4;
    return this;
  }

  i32(v: number): this {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new RangeError(`i32 out of range: ${v}`);
    this.ensure(4);
    this.view.setInt32(this.len, v, true);
    this.len += 4;
    return this;
  }

  u64(v: number | bigint): this {
    const b = BigInt(v);
    if (b < 0n || b > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${v}`);
    this.ensure(8);
    this.view.setBigUint64(this.len, b, true);
    this.len += 8;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Overwrite a u16 at an earlier offset (length back-patching). */
  patchU16(offset: number, v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    this.view.setUint16(offset, v, true);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  readonly bin: Uint8Array;
  private readonly view: DataView;
  private readonly end: number;
  pos: number;

  constructor(
    bin: Uint8Array,
    readonly code: ErrorCode,
    start = 0,
    end = bin.length,
  ) {
    if (!(bin instanceof Uint8Array)) throw new EngineError(code, 'input is not a Uint8Array');
    this.bin = bin;
    this.view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    this.pos = start;
    this.end = end;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number, what: string): void {
    if (this.pos + n > this.end) {
      throw new EngineError(this.code, `truncated: need ${n} byte(s) for ${what} at offset ${this.pos}`);
    }
  }

  u8(what = 'u8'): number {
    this.need(1, what);
    return this.bin[this.pos++]!;
  }

  i8(what = 'i8'): number {
    this.need(1, what);
    return this.view.getInt8(this.pos++);
  }

  u16(what = 'u16'): number {
    this.need(2, what);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(what = 'u32'): number {
    this.need(4, what);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(what = 'i32'): number {
    this.need(4, what);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u64(what = 'u64'): bigint {
    this.need(8, what);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** A copy of the next `n` bytes. */
  bytes(n: number, what = 'bytes'): Uint8Array {
    this.need(n, what);
    const out = this.bin.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Reject trailing bytes. */
  expectEnd(what: string): void {
    if (this.pos !== this.end) {
      throw new EngineError(this.code, `${this.end - this.pos} trailing byte(s) after ${what}`);
    }
  }
}
