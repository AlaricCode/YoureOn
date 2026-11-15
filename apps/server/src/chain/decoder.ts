// Escrow event decoder (ESCROW §7.1–§7.2, DATA-MODEL §5.9 `payload`).
//
// Decodes `disc(8) ‖ borsh` event bytes with the IDL **compiled into the server**
// (packages/shared/idl/escrow.json, imported at build time, never fetched at runtime). The
// Stream filter's `name` is only a routing hint: this decoder looks the discriminator up again
// and ignores it.
//
// Payload encoding (DATA-MODEL §5.9): u64 → decimal string, Pubkey → base58, [u8;32] → hex,
// bet_id [u8;16] → UUID string, i64/u32 → number, bool → boolean, enums → Rust variant name.
//
// The RPC fallback (DATA-MODEL §8.3, `rpc_poll`) must reuse decodeEventBytes so both sources
// produce identical rows for the same (signature, outer_ix, inner_ix).
import { getAddressDecoder } from '@solana/kit';
import { bytesToBetId } from '@youre-on/shared';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import idlJson from '@youre-on/shared/idl/escrow.json' with { type: 'json' };

/** Anchor's `EVENT_IX_TAG` (0x1d9acb512ea545e4) little-endian: prefix of every emit_cpi! ix. */
export const EVENT_IX_TAG_LE: readonly number[] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } | string };
interface IdlField {
  name: string;
  type: IdlType;
}
type IdlTypeDef =
  | { kind: 'struct'; fields: IdlField[] }
  | { kind: 'enum'; variants: { name: string; fields?: unknown[] }[] };
interface Idl {
  address: string;
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: IdlTypeDef }[];
}

const IDL = idlJson as unknown as Idl;
if (IDL.address !== ESCROW_ID) {
  // packages/shared/test/chain-constants.test.ts pins these together; fail loudly if not.
  throw new Error(`escrow IDL address ${IDL.address} != ESCROW_ID ${ESCROW_ID}`);
}

const TYPES = new Map(IDL.types.map((t) => [t.name, t.type]));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const discKey = (b: ArrayLike<number>) => hex(Uint8Array.from(Array.from(b).slice(0, 8)));

/** Event name per 8-byte discriminator (hex), from the compiled IDL. */
export const EVENT_DISCRIMINATORS: ReadonlyMap<string, string> = new Map(
  IDL.events.map((e) => [discKey(e.discriminator), e.name]),
);
/** Every IDL event name, IDL order. */
export const IDL_EVENT_NAMES: readonly string[] = IDL.events.map((e) => e.name);
/** For the filter generator and its drift test. */
export const IDL_EVENTS: readonly { name: string; discriminator: readonly number[] }[] = IDL.events;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

const addr = getAddressDecoder();

class Reader {
  private o = 0;
  private readonly dv: DataView;
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get remaining(): number {
    return this.b.length - this.o;
  }
  private need(n: number): void {
    if (this.o + n > this.b.length) throw new DecodeError('borsh: out of bounds');
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8(): number {
    this.need(1);
    return this.dv.getUint8(this.o++);
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.dv.getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.dv.getBigInt64(this.o, true);
    this.o += 8;
    return v;
  }
}

function readType(r: Reader, t: IdlType, field: string): unknown {
  if (typeof t === 'string') {
    switch (t) {
      case 'u8':
        return r.u8();
      case 'u32':
        return r.u32();
      case 'u64':
        return r.u64().toString();
      case 'i64': {
        const v = r.i64();
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))
          throw new DecodeError(`${field}: i64 outside the safe integer range`);
        return Number(v);
      }
      case 'bool': {
        const v = r.u8();
        if (v > 1) throw new DecodeError(`${field}: bool byte ${v}`);
        return v === 1;
      }
      case 'pubkey':
        return addr.decode(r.bytes(32));
      default:
        throw new DecodeError(`${field}: unsupported IDL type ${t}`);
    }
  }
  if ('array' in t) {
    const [et, len] = t.array;
    if (et === 'u8' && len === 16 && field === 'bet_id') return bytesToBetId(r.bytes(16));
    if (et === 'u8' && len === 32) return hex(r.bytes(32));
    throw new DecodeError(`${field}: unsupported array [${JSON.stringify(et)}; ${len}]`);
  }
  if ('vec' in t) {
    const n = r.u32();
    // Every element is at least 1 byte; refuse absurd lengths before allocating.
    if (n > r.remaining) throw new DecodeError(`${field}: vec length ${n} out of bounds`);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(readType(r, t.vec, `${field}[${i}]`));
    return out;
  }
  if ('option' in t) {
    // Borsh Option: exactly 0 (None) or 1 (Some). Anything else is non-canonical, like a bool > 1.
    const tag = r.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new DecodeError(`${field}: option tag ${tag}`);
    return readType(r, t.option, field);
  }
  if ('defined' in t) {
    const name = typeof t.defined === 'string' ? t.defined : t.defined.name;
    return readDefined(r, name, field);
  }
  throw new DecodeError(`${field}: unsupported IDL type ${JSON.stringify(t)}`);
}

function readDefined(r: Reader, name: string, field: string): unknown {
  const def = TYPES.get(name);
  if (!def) throw new DecodeError(`${field}: unknown IDL type ${name}`);
  if (def.kind === 'struct') {
    const o: Record<string, unknown> = {};
    for (const f of def.fields) o[f.name] = readType(r, f.type, f.name);
    return o;
  }
  const idx = r.u8();
  const v = def.variants[idx];
  if (!v) throw new DecodeError(`${field}: bad ${name} variant ${idx}`);
  if (v.fields?.length) throw new DecodeError(`${field}: data-carrying enum ${name} unsupported`);
  return v.name;
}

export interface DecodedEvent {
  /** IDL event name, from the discriminator (never from the filter's hint). */
  name: string;
  /** DATA-MODEL §5.9 `payload` (no ChainMeta). */
  payload: Record<string, unknown>;
}

/** Event name for `disc(8) ‖ …` bytes, or null if the discriminator is not in the IDL. */
export function eventNameOf(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;
  return EVENT_DISCRIMINATORS.get(discKey(bytes)) ?? null;
}

/**
 * Decodes `disc(8) ‖ borsh` with the compiled IDL. Throws DecodeError on an unknown
 * discriminator, truncated input or trailing bytes (an exact-length decode is the integrity check).
 */
export function decodeEventBytes(bytes: Uint8Array): DecodedEvent {
  const name = eventNameOf(bytes);
  if (!name) throw new DecodeError('unknown event discriminator');
  const r = new Reader(bytes.subarray(8));
  const payload = readDefined(r, name, name) as Record<string, unknown>;
  if (r.remaining !== 0) throw new DecodeError(`${name}: ${r.remaining} trailing bytes`);
  return { name, payload };
}

/**
 * Decodes one IDL-defined type (struct or enum) exactly, with the same rules as events. Exposed for
 * tests of types no event carries yet (e.g. the Option fields of UpdateConfigArgs).
 */
export function decodeIdlDefined(bytes: Uint8Array, typeName: string): unknown {
  const r = new Reader(bytes);
  const v = readDefined(r, typeName, typeName);
  if (r.remaining !== 0) throw new DecodeError(`${typeName}: ${r.remaining} trailing bytes`);
  return v;
}

/** Strict base64 → bytes (Buffer.from silently skips bad characters, so check first). */
export function base64ToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0)
    throw new DecodeError('eventBase64 is not canonical base64');
  return new Uint8Array(Buffer.from(s, 'base64'));
}
