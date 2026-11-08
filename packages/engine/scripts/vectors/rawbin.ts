/**
 * Independent byte-level builders for program_bin / calibration_bin /
 * track_bin / market_bin (§5), used to construct malformed inputs. The program
 * builder is checked against `encodeProgram` on the valid base case.
 */
import bs58 from 'bs58';
import { hexToBytes } from '../../src/hash/index.js';

export class W {
  private out: number[] = [];
  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }
  i8(v: number): this {
    return this.u8(v < 0 ? 256 + v : v);
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  i32(v: number): this {
    return this.u32(v >>> 0);
  }
  u64(v: number): this {
    const b = BigInt(v);
    for (let i = 0n; i < 8n; i++) this.u8(Number((b >> (8n * i)) & 0xffn));
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.u8(b[i]!);
    return this;
  }
  ascii(s: string): this {
    for (const ch of s) this.u8(ch.charCodeAt(0));
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

export const concat = (...parts: ArrayLike<number>[]): number[] => parts.flatMap((p) => Array.from(p));

// ---------------------------------------------------------------------------
// Expression code (§5.1)

export const refByte = (e: number, sub = 0): number => e | (sub << 4);
export const leaf = (code: number, a: number, b = 0, p = 0): number[] => Array.from(new W().u8(code).u8(a).u8(b).i32(p).done());
export const AND = (x: number[], y: number[]): number[] => [0x01, ...x, ...y];
export const OR = (x: number[], y: number[]): number[] => [0x02, ...x, ...y];
export const NOT = (x: number[]): number[] => [0x03, ...x];
export const THEN = (frames: number, x: number[], y: number[]): number[] => [0x04, frames & 0xff, frames >>> 8, ...x, ...y];
export const FOR = (frames: number, x: number[]): number[] => [0x05, frames & 0xff, frames >>> 8, ...x];
export const BEFORE = (frames: number, x: number[]): number[] => [0x06, ...Array.from(new W().u32(frames).done()), ...x];
export const LEG = (id: number): number[] => [0x50, id];
export const YES = [0x51];

// ---------------------------------------------------------------------------
// program_bin

export interface RawLeg {
  id: number;
  flags: number;
  rule_kind: number;
  rule_cmp: number;
  rule_k: number;
  rule_n: number;
  attempt_window: number;
  va: number[];
  succ: number[];
  /** override the encoded va_len / succ_len */
  va_len?: number;
  succ_len?: number;
}

export interface RawProgram {
  magic: string;
  version: number;
  kind: number;
  fps: number;
  /** override of the P byte (defaults to participants.length) */
  P?: number;
  json_hash: string;
  time_limit_s: number;
  participants: string[];
  stakes: number[];
  side_b_mask: number;
  entities: [number, number][];
  /** override of the E byte */
  E?: number;
  legs: RawLeg[];
  /** override of the L byte */
  L?: number;
  if_true: number;
  else: number;
  cond: number[];
  cond_len?: number;
  trailing?: number[];
}

export function rawProgram(p: RawProgram): Uint8Array {
  const w = new W()
    .ascii(p.magic)
    .u8(p.version)
    .u8(p.kind)
    .u8(p.fps)
    .u8(p.P ?? p.participants.length)
    .bytes(hexToBytes(p.json_hash))
    .u32(p.time_limit_s);
  for (const k of p.participants) w.bytes(bs58.decode(k));
  for (const s of p.stakes) w.u64(s);
  w.u8(p.side_b_mask).u8(p.E ?? p.entities.length);
  for (const [k, param] of p.entities) w.u8(k).u8(param);
  w.u8(p.L ?? p.legs.length);
  for (const l of p.legs) {
    w.u8(l.id).u8(l.flags).u8(l.rule_kind).u8(l.rule_cmp).u16(l.rule_k).u32(l.rule_n).u16(l.attempt_window);
    w.u16(l.va_len ?? l.va.length).bytes(l.va);
    w.u16(l.succ_len ?? l.succ.length).bytes(l.succ);
  }
  w.u8(p.if_true).u8(p.else).u16(p.cond_len ?? p.cond.length).bytes(p.cond);
  if (p.trailing) w.bytes(p.trailing);
  return w.done();
}

// ---------------------------------------------------------------------------
// calibration_bin

export interface RawRegion {
  entity_idx: number;
  shape: number;
  points: [number, number][];
  behind_sign: number;
  n_points?: number;
}

export function rawCalibration(c: {
  magic?: string;
  version?: number;
  R?: number;
  reserved?: number;
  scene_hash: string;
  regions: RawRegion[];
  trailing?: number[];
}): Uint8Array {
  const w = new W()
    .ascii(c.magic ?? 'VCAL')
    .u8(c.version ?? 1)
    .u8(c.R ?? c.regions.length)
    .u16(c.reserved ?? 0)
    .bytes(hexToBytes(c.scene_hash));
  for (const r of c.regions) {
    w.u8(r.entity_idx).u8(r.shape).u8(r.n_points ?? r.points.length).i8(r.behind_sign);
    for (const [x, y] of r.points) w.u16(x).u16(y);
  }
  if (c.trailing) w.bytes(c.trailing);
  return w.done();
}

// ---------------------------------------------------------------------------
// market_bin

export function rawMarket(entries: { hash: string; result: number }[], o: { magic?: string; version?: number; n?: number; reserved?: number; trailing?: number[] } = {}): Uint8Array {
  const w = new W()
    .ascii(o.magic ?? 'VMKT')
    .u8(o.version ?? 1)
    .u8(o.n ?? entries.length)
    .u16(o.reserved ?? 0);
  for (const e of entries) w.bytes(hexToBytes(e.hash)).u8(e.result);
  if (o.trailing) w.bytes(o.trailing);
  return w.done();
}

/** Copy of `b` with `patch(copy)` applied. */
export function patched(b: Uint8Array, patch: (c: Uint8Array) => void): Uint8Array {
  const c = Uint8Array.from(b);
  patch(c);
  return c;
}

export function writeU16(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
}

export function writeU32(b: Uint8Array, off: number, v: number): void {
  writeU16(b, off, v & 0xffff);
  writeU16(b, off + 2, v >>> 16);
}
