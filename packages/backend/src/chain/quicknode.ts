/**
 * §12.5 QuickNode Streams webhook authentication. The scheme is isolated in
 * this one function (verify the header names against QuickNode docs):
 *   headers x-qn-nonce, x-qn-timestamp, x-qn-signature
 *   signature = hex(HMAC_SHA256(QUICKNODE_SECRET, nonce ‖ timestamp ‖ raw_body))
 * Rejected if invalid or |now − timestamp| > 300 s.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const QN_HEADER_NONCE = 'x-qn-nonce';
export const QN_HEADER_TIMESTAMP = 'x-qn-timestamp';
export const QN_HEADER_SIGNATURE = 'x-qn-signature';
export const QN_MAX_SKEW_S = 300;

export interface QuickNodeSigInput {
  secret: string;
  nonce: string | undefined;
  /** unix seconds as sent in the header */
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Uint8Array;
  nowMs: number;
}

export type QuickNodeVerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'bad_signature' };

export function quickNodeSignature(secret: string, nonce: string, timestamp: string, rawBody: Uint8Array): string {
  return createHmac('sha256', secret).update(nonce).update(timestamp).update(rawBody).digest('hex');
}

export function verifyQuickNodeSignature(i: QuickNodeSigInput): QuickNodeVerifyResult {
  if (!i.nonce || !i.timestamp || !i.signature) return { ok: false, reason: 'missing' };
  if (!/^\d{1,12}$/.test(i.timestamp)) return { ok: false, reason: 'stale' };
  const ts = Number(i.timestamp);
  if (Math.abs(i.nowMs / 1000 - ts) > QN_MAX_SKEW_S) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(quickNodeSignature(i.secret, i.nonce, i.timestamp, i.rawBody), 'hex');
  const sig = i.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'bad_signature' };
  const given = Buffer.from(sig, 'hex');
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** One decoded event of the stream filter output (§12.5). */
export interface QuickNodeEvent {
  signature: string;
  slot: number;
  block_time: number | null;
  index: number;
  name: string;
  data: Record<string, unknown>;
}

/** Validates the filter output shape `{ stream, events: [...] }`; throws on malformed input. */
export function parseQuickNodePayload(body: unknown): { stream: string; events: QuickNodeEvent[] } {
  if (!body || typeof body !== 'object') throw new Error('payload: not an object');
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['events'])) throw new Error('payload: events must be an array');
  const events = b['events'].map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`events[${i}]: not an object`);
    const x = e as Record<string, unknown>;
    if (typeof x['signature'] !== 'string' || x['signature'] === '') throw new Error(`events[${i}].signature`);
    if (!Number.isSafeInteger(x['slot'])) throw new Error(`events[${i}].slot`);
    if (!Number.isSafeInteger(x['index']) || (x['index'] as number) < 0) throw new Error(`events[${i}].index`);
    if (typeof x['name'] !== 'string') throw new Error(`events[${i}].name`);
    if (!x['data'] || typeof x['data'] !== 'object') throw new Error(`events[${i}].data`);
    const bt = x['block_time'];
    return {
      signature: x['signature'],
      slot: x['slot'] as number,
      block_time: Number.isSafeInteger(bt) ? (bt as number) : null,
      index: x['index'] as number,
      name: x['name'],
      data: x['data'] as Record<string, unknown>,
    };
  });
  return { stream: typeof b['stream'] === 'string' ? b['stream'] : '', events };
}
