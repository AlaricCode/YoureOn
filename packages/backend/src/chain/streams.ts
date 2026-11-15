/**
 * §12.5 QuickNode Streams intake: payload unwrapping, per-event schema
 * validation of the decoded encoding, and ordering. The HMAC check lives in
 * quicknode.ts (one function); this module turns a verified body into the
 * ordered `ChainEventJson[]` the handler consumes.
 *
 * Ordering: events are applied by (slot, delivery order); within a
 * transaction by `index`. Duplicates (same signature:index) are dropped here
 * and again by the idempotent handler.
 */
import { EVENT_NAMES, type VerdictEventName } from '@verdict/engine';
import type { ChainEventJson } from './events.js';
import { parseQuickNodePayload, type QuickNodeEvent } from './quicknode.js';

type T = 'pubkey' | 'hash' | 'u8' | 'u32' | 'dec' | 'bool' | 'vec_pubkey' | 'vec_dec' | 'u8x8' | 'decx8';

/** §9.5 fields in the §12.5 decoded encoding. */
export const DECODED_EVENT_FIELDS: Record<VerdictEventName, [string, T][]> = {
  ProfileUpdated: [['wallet', 'pubkey'], ['flags', 'u8']],
  BetCreated: [
    ['bet', 'pubkey'], ['creator', 'pubkey'], ['nonce', 'dec'], ['participants', 'vec_pubkey'], ['stakes', 'vec_dec'],
    ['side_b_mask', 'u8'], ['flags', 'u8'], ['program_hash', 'hash'], ['time_limit_s', 'u32'], ['fund_deadline', 'dec'],
  ],
  Funded: [
    ['bet', 'pubkey'], ['participant', 'pubkey'], ['participant_idx', 'u8'], ['amount', 'dec'], ['funded_mask', 'u8'],
    ['all_funded', 'bool'], ['calibration_hash', 'hash'],
  ],
  BetCancelled: [['bet', 'pubkey']],
  BetStarted: [['bet', 'pubkey'], ['beacon_slot', 'dec'], ['beacon_hash', 'hash'], ['started_at', 'dec'], ['n_witnesses', 'u8']],
  EvidenceCommitted: [['bet', 'pubkey'], ['seq', 'u32'], ['root', 'hash'], ['gap_mask', 'u8'], ['is_final', 'bool']],
  BetEnded: [['bet', 'pubkey'], ['evidence_root', 'hash'], ['ended_at', 'dec']],
  TracksPosted: [['bet', 'pubkey'], ['perception_root', 'hash'], ['tracks_hash', 'hash'], ['payload_len', 'u32']],
  BiometricVerified: [['bet', 'pubkey'], ['participant_idx', 'u8'], ['modality', 'u8'], ['frame', 'u32']],
  PreRuled: [['bet', 'pubkey'], ['preruling', 'u8'], ['reason', 'u8'], ['winner_mask', 'u8'], ['leg_results', 'u8x8'], ['consent_deadline', 'dec']],
  Consented: [['bet', 'pubkey'], ['participant', 'pubkey'], ['consent_mask', 'u8']],
  Disputed: [['bet', 'pubkey'], ['disputer', 'pubkey'], ['reason', 'u8'], ['bond', 'dec']],
  Settled: [['bet', 'pubkey'], ['path', 'u8'], ['winner_mask', 'u8'], ['pot', 'dec'], ['payouts', 'decx8']],
  Refunded: [['bet', 'pubkey'], ['reason', 'u8'], ['amounts', 'decx8']],
};

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DEC_RE = /^-?\d{1,20}$/;
const isU8 = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 0xff;

function valid(t: T, v: unknown): boolean {
  switch (t) {
    case 'pubkey':
      return typeof v === 'string' && PUBKEY_RE.test(v);
    case 'hash':
      return typeof v === 'string' && HASH_RE.test(v);
    case 'u8':
      return isU8(v);
    case 'u32':
      return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff;
    case 'dec':
      return typeof v === 'string' && DEC_RE.test(v);
    case 'bool':
      return typeof v === 'boolean';
    case 'vec_pubkey':
      return Array.isArray(v) && v.length <= 255 && v.every((x) => valid('pubkey', x));
    case 'vec_dec':
      return Array.isArray(v) && v.length <= 255 && v.every((x) => valid('dec', x));
    case 'u8x8':
      return Array.isArray(v) && v.length === 8 && v.every(isU8);
    case 'decx8':
      return Array.isArray(v) && v.length === 8 && v.every((x) => valid('dec', x));
  }
}

/** Null if the event matches its §9.5 schema in the decoded encoding, else the first bad field. */
export function eventSchemaError(name: string, data: Record<string, unknown>): string | null {
  const schema = DECODED_EVENT_FIELDS[name as VerdictEventName];
  if (!schema) return `unknown event ${name}`;
  for (const [f, t] of schema) if (!valid(t, data[f])) return `${name}.${f}`;
  return null;
}

/** Accepts the filter output directly or wrapped by the destination (`{data: …}` / `[…]`). */
export function unwrapStreamBody(body: unknown): unknown[] {
  if (Array.isArray(body)) return body.flatMap(unwrapStreamBody);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b['events'])) return [b];
    if ('data' in b) return unwrapStreamBody(b['data']);
  }
  if (body === null) return [];
  throw new Error('payload: no events');
}

export interface StreamBatch {
  events: ChainEventJson[];
  /** events dropped because of an unknown name or a schema mismatch */
  rejected: { key: string; reason: string }[];
}

/** Parses, validates and orders a webhook body. Throws on a malformed envelope. */
export function streamEvents(body: unknown): StreamBatch {
  const all: { ev: QuickNodeEvent; seq: number }[] = [];
  const rejected: StreamBatch['rejected'] = [];
  let seq = 0;
  for (const part of unwrapStreamBody(body)) {
    for (const ev of parseQuickNodePayload(part).events) all.push({ ev, seq: seq++ });
  }
  const seen = new Set<string>();
  const out: { ev: ChainEventJson; seq: number }[] = [];
  for (const { ev, seq: s } of all) {
    const key = `${ev.signature}:${ev.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(EVENT_NAMES as readonly string[]).includes(ev.name)) {
      rejected.push({ key, reason: `unknown event ${ev.name}` });
      continue;
    }
    const err = eventSchemaError(ev.name, ev.data);
    if (err) {
      rejected.push({ key, reason: err });
      continue;
    }
    out.push({ ev: { ...ev, name: ev.name as VerdictEventName }, seq: s });
  }
  // Stable: slot ascending, then delivery order (the filter emits block/tx order), then index.
  out.sort((a, b) => a.ev.slot - b.ev.slot || (a.ev.signature === b.ev.signature ? a.ev.index - b.ev.index : a.seq - b.seq));
  return { events: out.map((x) => x.ev), rejected };
}
