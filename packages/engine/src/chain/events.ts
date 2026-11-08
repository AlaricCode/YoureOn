/**
 * §9.5 events: `Program data: base64(sha256("event:<Name>")[0..8] ‖ borsh)`.
 * `decodeEvent` returns the §12.5 JSON encoding (u64/i64 as decimal strings).
 */
import { DISC_EVENT_PREFIX, EVENT_NAMES } from '../constants.js';
import type { DecodedEventJson, VerdictEvent, VerdictEventMap, VerdictEventName } from '../types.js';
import { BorshReader, BorshWriter, bytesEqual, discriminator, fromBase64, toBase64 } from './bytes.js';

type FieldType =
  | 'pubkey'
  | 'u8'
  | 'u32'
  | 'u64'
  | 'i64'
  | 'bool'
  | 'hash'
  | 'vec_pubkey'
  | 'vec_u64'
  | 'u8x8'
  | 'u64x8';

/** Field order per §9.5. */
export const EVENT_SCHEMAS: { [N in VerdictEventName]: [keyof VerdictEventMap[N] & string, FieldType][] } = {
  ProfileUpdated: [
    ['wallet', 'pubkey'],
    ['flags', 'u8'],
  ],
  BetCreated: [
    ['bet', 'pubkey'],
    ['creator', 'pubkey'],
    ['nonce', 'u64'],
    ['participants', 'vec_pubkey'],
    ['stakes', 'vec_u64'],
    ['side_b_mask', 'u8'],
    ['flags', 'u8'],
    ['program_hash', 'hash'],
    ['time_limit_s', 'u32'],
    ['fund_deadline', 'i64'],
  ],
  Funded: [
    ['bet', 'pubkey'],
    ['participant', 'pubkey'],
    ['participant_idx', 'u8'],
    ['amount', 'u64'],
    ['funded_mask', 'u8'],
    ['all_funded', 'bool'],
    ['calibration_hash', 'hash'],
  ],
  BetCancelled: [['bet', 'pubkey']],
  BetStarted: [
    ['bet', 'pubkey'],
    ['beacon_slot', 'u64'],
    ['beacon_hash', 'hash'],
    ['started_at', 'i64'],
    ['n_witnesses', 'u8'],
  ],
  EvidenceCommitted: [
    ['bet', 'pubkey'],
    ['seq', 'u32'],
    ['root', 'hash'],
    ['gap_mask', 'u8'],
    ['is_final', 'bool'],
  ],
  BetEnded: [
    ['bet', 'pubkey'],
    ['evidence_root', 'hash'],
    ['ended_at', 'i64'],
  ],
  TracksPosted: [
    ['bet', 'pubkey'],
    ['perception_root', 'hash'],
    ['tracks_hash', 'hash'],
    ['payload_len', 'u32'],
  ],
  BiometricVerified: [
    ['bet', 'pubkey'],
    ['participant_idx', 'u8'],
    ['modality', 'u8'],
    ['frame', 'u32'],
  ],
  PreRuled: [
    ['bet', 'pubkey'],
    ['preruling', 'u8'],
    ['reason', 'u8'],
    ['winner_mask', 'u8'],
    ['leg_results', 'u8x8'],
    ['consent_deadline', 'i64'],
  ],
  Consented: [
    ['bet', 'pubkey'],
    ['participant', 'pubkey'],
    ['consent_mask', 'u8'],
  ],
  Disputed: [
    ['bet', 'pubkey'],
    ['disputer', 'pubkey'],
    ['reason', 'u8'],
    ['bond', 'u64'],
  ],
  Settled: [
    ['bet', 'pubkey'],
    ['path', 'u8'],
    ['winner_mask', 'u8'],
    ['pot', 'u64'],
    ['payouts', 'u64x8'],
  ],
  Refunded: [
    ['bet', 'pubkey'],
    ['reason', 'u8'],
    ['amounts', 'u64x8'],
  ],
};

export const EVENT_DISCRIMINATORS: Record<VerdictEventName, Uint8Array> = Object.fromEntries(
  EVENT_NAMES.map((n) => [n, discriminator(DISC_EVENT_PREFIX, n)]),
) as Record<VerdictEventName, Uint8Array>;

function writeField(w: BorshWriter, t: FieldType, v: unknown): void {
  switch (t) {
    case 'pubkey':
      w.pubkey(v as string);
      return;
    case 'u8':
      w.u8(v as number);
      return;
    case 'u32':
      w.u32(v as number);
      return;
    case 'u64':
      w.u64(v as bigint);
      return;
    case 'i64':
      w.i64(v as bigint);
      return;
    case 'bool':
      w.bool(v as boolean);
      return;
    case 'hash':
      w.hash(v as string);
      return;
    case 'vec_pubkey':
      w.vec(v as string[], (x, k) => x.pubkey(k));
      return;
    case 'vec_u64':
      w.vec(v as bigint[], (x, n) => x.u64(n));
      return;
    case 'u8x8':
      w.array(v as number[], 8, (x, n) => x.u8(n));
      return;
    case 'u64x8':
      w.array(v as bigint[], 8, (x, n) => x.u64(n));
      return;
  }
}

function readField(r: BorshReader, t: FieldType): unknown {
  switch (t) {
    case 'pubkey':
      return r.pubkey();
    case 'u8':
      return r.u8();
    case 'u32':
      return r.u32();
    case 'u64':
      return r.u64();
    case 'i64':
      return r.i64();
    case 'bool':
      return r.bool();
    case 'hash':
      return r.hash();
    case 'vec_pubkey':
      return r.vec((x) => x.pubkey(), 255);
    case 'vec_u64':
      return r.vec((x) => x.u64(), 255);
    case 'u8x8':
      return r.array(8, (x) => x.u8());
    case 'u64x8':
      return r.array(8, (x) => x.u64());
  }
}

/** Encodes an event as `disc ‖ borsh(data)`. */
export function encodeEvent<N extends VerdictEventName>(name: N, data: VerdictEventMap[N]): Uint8Array {
  const schema = EVENT_SCHEMAS[name] as [string, FieldType][] | undefined;
  if (!schema) throw new Error(`unknown event ${String(name)}`);
  const w = new BorshWriter(128);
  w.raw(EVENT_DISCRIMINATORS[name]);
  for (const [field, t] of schema) writeField(w, t, (data as Record<string, unknown>)[field]);
  return w.toBytes();
}

/** Decodes `disc ‖ borsh` into a typed event (bigints for u64/i64). */
export function decodeEventTyped(bytes: Uint8Array | string): VerdictEvent {
  const b = typeof bytes === 'string' ? fromBase64(bytes) : bytes;
  if (b.length < 8) throw new Error('event: too short');
  for (const name of EVENT_NAMES) {
    if (!bytesEqual(b.subarray(0, 8), EVENT_DISCRIMINATORS[name])) continue;
    const r = new BorshReader(b.subarray(8));
    const data: Record<string, unknown> = {};
    for (const [field, t] of EVENT_SCHEMAS[name] as [string, FieldType][]) data[field] = readField(r, t);
    r.end();
    return { name, data } as VerdictEvent;
  }
  throw new Error('event: unknown discriminator');
}

/** Converts typed event data to the §12.5 JSON encoding. */
export function eventToJson(ev: VerdictEvent): DecodedEventJson {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev.data)) {
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'bigint' ? x.toString() : x));
    else out[k] = v;
  }
  return { name: ev.name, data: out } as unknown as DecodedEventJson;
}

/**
 * Decodes event bytes (or the base64 payload of a `Program data:` log line)
 * into the §12.5 JSON shape.
 */
export function decodeEvent(bytes: Uint8Array | string): DecodedEventJson {
  return eventToJson(decodeEventTyped(bytes));
}

/** `Program data: <base64>` log line for an event. */
export function eventLogLine(ev: VerdictEvent): string {
  return `Program data: ${toBase64(encodeEvent(ev.name, ev.data as never))}`;
}

/** Parses a `Program data: …` log line; returns null for other lines or non-Verdict data. */
export function parseEventLogLine(line: string): DecodedEventJson | null {
  const m = /^Program data: ([A-Za-z0-9+/=]+)\s*$/.exec(line);
  if (!m) return null;
  try {
    return decodeEvent(m[1]!);
  } catch {
    return null;
  }
}
