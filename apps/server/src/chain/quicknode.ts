// QuickNode Streams webhook authentication (API-CONTRACT §5.3, FINDINGS §3.12, spike 06).
//
// Ported from Verdict packages/backend/src/chain/quicknode.ts (HMAC over the raw body,
// timing-safe compare, timestamp skew window). Our contract differs in two places, and ours wins:
//   - the HMAC covers the **decompressed** body; we gunzip only when the bytes start with 1f 8b
//     (whatever Content-Encoding says);
//   - X-QN-Timestamp is unix seconds per the spike simulator, but values with > 11 digits are
//     read as milliseconds (PENDING-KEY: confirm with `test_filter --probe`).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const gunzipAsync = promisify(gunzip);

export const QN_HEADER_NONCE = 'x-qn-nonce';
export const QN_HEADER_TIMESTAMP = 'x-qn-timestamp';
export const QN_HEADER_SIGNATURE = 'x-qn-signature';
/** Batch headers (spike simulator names; PENDING-KEY). Logged into chain_events.delivery_id. */
export const QN_HEADER_BATCH_START = 'batch-start-range';
export const QN_HEADER_BATCH_END = 'batch-end-range';
export const QN_HEADER_DATASET = 'stream-dataset';
/** Reject |now − timestamp| > 300 s (API-CONTRACT §5.3). */
export const QN_MAX_SKEW_S = 300;
/** Optional source-IP allowlist entry (API-CONTRACT §5.3). Not enforced: Fly's proxy rewrites. */
export const QN_SOURCE_IP = '141.148.40.227';
/**
 * Decompression cap. The HMAC covers the decompressed body, so an unauthenticated caller can make
 * us inflate up to this much before the signature check: keep it near the real batch size (a
 * 5-block filtered batch is a few KB; our Stream is configured with compression none).
 */
export const QN_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;

export type QuickNodeRejectReason = 'missing' | 'stale' | 'bad_signature' | 'bad_body';
export type QuickNodeVerifyResult =
  { ok: true; body: Uint8Array } | { ok: false; reason: QuickNodeRejectReason };

export interface QuickNodeSigInput {
  secret: string;
  nonce: string | undefined | null;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
  /** The bytes exactly as received (possibly gzip). */
  rawBody: Uint8Array;
  nowMs: number;
}

/** hex HMAC-SHA256(secret, nonce ‖ timestamp ‖ body). Also used by tests and the local simulator. */
export function quickNodeSignature(
  secret: string,
  nonce: string,
  timestamp: string,
  body: Uint8Array,
): string {
  return createHmac('sha256', secret).update(nonce).update(timestamp).update(body).digest('hex');
}

/** True iff the bytes carry the gzip magic number. */
export const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * Gunzip only when the bytes are gzip (some proxies decode already and leave the header). Async,
 * so a hostile body inflating to the cap does not block the event loop.
 */
export async function decompressBody(raw: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(raw)) return raw;
  return new Uint8Array(await gunzipAsync(raw, { maxOutputLength: QN_MAX_DECOMPRESSED_BYTES }));
}

/** X-QN-Timestamp → unix ms. Seconds normally; > 11 digits means milliseconds. null if malformed. */
export function parseQnTimestampMs(ts: string): number | null {
  if (!/^\d{1,16}$/.test(ts)) return null;
  const n = Number(ts);
  return ts.length > 11 ? n : n * 1000;
}

/**
 * Verifies the X-QN-* headers against the (decompressed) body. The cheap checks (headers present,
 * timestamp fresh) run before the HMAC; the compare is constant-time over equal-length buffers.
 * Returns the decompressed body on success so the caller parses exactly the bytes that were signed.
 */
export async function verifyQuickNodeSignature(
  i: QuickNodeSigInput,
): Promise<QuickNodeVerifyResult> {
  if (!i.secret || !i.nonce || !i.timestamp || !i.signature)
    return { ok: false, reason: 'missing' };
  const tsMs = parseQnTimestampMs(i.timestamp);
  if (tsMs === null || Math.abs(i.nowMs - tsMs) > QN_MAX_SKEW_S * 1000)
    return { ok: false, reason: 'stale' };
  const sig = i.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'bad_signature' };
  let body: Uint8Array;
  try {
    body = await decompressBody(i.rawBody);
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  const expected = Buffer.from(quickNodeSignature(i.secret, i.nonce, i.timestamp, body), 'hex');
  const given = Buffer.from(sig, 'hex');
  return timingSafeEqual(expected, given)
    ? { ok: true, body }
    : { ok: false, reason: 'bad_signature' };
}
