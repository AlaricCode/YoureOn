// ElevenLabs post-call webhook authentication (API-CONTRACT §4.6).
//
// Deviation (reported): §4.6 says to verify with the SDK, `@elevenlabs/elevenlabs-js`
// `webhooks.constructEvent(rawBody, sigHeader, secret)`. That SDK is not a dependency (node_modules
// has only @elevenlabs/client, react, react-native and types; none of them verify webhooks), so
// this is the scheme constructEvent implements, by hand:
//
//   ElevenLabs-Signature: t=<unix seconds>,v0=<hex HMAC-SHA256(secret, `${t}.${raw body}`)>
//
// - Tolerance: the SDK's, a timestamp older than 30 min is stale. The SDK does not check the
//   future; we refuse more than 5 min ahead. A replay inside the window is harmless: the handler
//   dedupes on (conversation_id, type).
// - The HMAC covers the raw bytes exactly as received; the caller parses JSON only after it
//   verified. The compare is constant-time over equal-length buffers.
// - The header is checked (present, parseable, fresh) before the body is read, so a request
//   without a plausible signature is refused without buffering it.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hono's c.req.header() is case-insensitive; ElevenLabs sends `ElevenLabs-Signature`. */
export const EL_SIGNATURE_HEADER = 'elevenlabs-signature';
/** = the SDK's constructEvent tolerance (30 minutes in the past). */
export const EL_SIGNATURE_TOLERANCE_S = 30 * 60;
/** Clock skew we accept the other way (the SDK accepts any future timestamp). */
export const EL_SIGNATURE_MAX_FUTURE_S = 5 * 60;

export type ElSignatureRejectReason = 'missing' | 'malformed' | 'stale' | 'bad_signature';

export interface ParsedElSignature {
  /** The `t` value exactly as sent: it is the HMAC prefix. */
  t: string;
  tsMs: number;
  /** Every `v0=` entry (lowercase hex); one matching is enough (a secret rotation may send two). */
  v0: string[];
}

export type ElSignatureCheck =
  { ok: true; sig: ParsedElSignature } | { ok: false; reason: ElSignatureRejectReason };

/** `t` -> unix ms: seconds (the SDK's unit); more than 11 digits is read as milliseconds. */
function timestampMs(t: string): number | null {
  if (!/^\d{1,16}$/.test(t)) return null;
  const n = Number(t);
  return t.length > 11 ? n : n * 1000;
}

/** Parses `t=…,v0=…[,v0=…]`; unknown schemes (v1=…) are ignored. null when unusable. */
export function parseElSignatureHeader(header: string): Omit<ParsedElSignature, 'tsMs'> | null {
  let t: string | null = null;
  const v0: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v0' && /^[0-9a-fA-F]{64}$/.test(v)) v0.push(v.toLowerCase());
  }
  if (t === null || v0.length === 0) return null;
  return { t, v0 };
}

/** The cheap half, before the body is read: header present, parseable, timestamp in tolerance. */
export function checkElSignatureHeader(
  header: string | undefined | null,
  nowMs: number,
): ElSignatureCheck {
  if (!header || !header.trim()) return { ok: false, reason: 'missing' };
  const p = parseElSignatureHeader(header);
  if (!p) return { ok: false, reason: 'malformed' };
  const tsMs = timestampMs(p.t);
  if (tsMs === null) return { ok: false, reason: 'malformed' };
  if (nowMs - tsMs > EL_SIGNATURE_TOLERANCE_S * 1000) return { ok: false, reason: 'stale' };
  if (tsMs - nowMs > EL_SIGNATURE_MAX_FUTURE_S * 1000) return { ok: false, reason: 'stale' };
  return { ok: true, sig: { ...p, tsMs } };
}

/** hex HMAC-SHA256(secret, `${t}.` ‖ body). */
export function elevenLabsHmac(secret: string, t: string, body: Uint8Array | string): string {
  return createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
}

/** The header value ElevenLabs would send for `body` at `tSeconds`. Tests and local simulators. */
export function elevenLabsSignatureHeader(
  secret: string,
  body: Uint8Array | string,
  tSeconds: number,
): string {
  const t = String(Math.floor(tSeconds));
  return `t=${t},v0=${elevenLabsHmac(secret, t, body)}`;
}

/** The expensive half: the HMAC over the exact bytes, constant-time against every v0. */
export function elSignatureMatches(
  sig: ParsedElSignature,
  secret: string,
  rawBody: Uint8Array,
): boolean {
  if (!secret) return false;
  const expected = Buffer.from(elevenLabsHmac(secret, sig.t, rawBody), 'hex');
  let ok = false;
  for (const v of sig.v0) if (timingSafeEqual(expected, Buffer.from(v, 'hex'))) ok = true;
  return ok;
}

/** Both halves (unit tests, scripts). The route runs them apart, around the body read. */
export function verifyElevenLabsSignature(i: {
  secret: string;
  header: string | undefined | null;
  rawBody: Uint8Array;
  nowMs: number;
}): { ok: true } | { ok: false; reason: ElSignatureRejectReason } {
  if (!i.secret) return { ok: false, reason: 'missing' };
  const h = checkElSignatureHeader(i.header, i.nowMs);
  if (!h.ok) return h;
  return elSignatureMatches(h.sig, i.secret, i.rawBody)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
