/**
 * Signed, short-lived chunk URLs for perception workers (CONTRACTS-ERRATA
 * bet-lifecycle-8 → backend-audit-media). A worker on io.net / Nosana has no
 * bearer token, so §6.0 `video_urls` point at
 *   GET {PUBLIC_URL}/v1/media/chunks/:bet/:witness/:index?exp=<unix ms>&sig=<hex>
 * where sig = HMAC-SHA256(K, "verdict/media/v1|bet|witness|index|exp") and
 * K = SHA-256("verdict/media-url-key" ‖ BIOMETRIC_KEY) (never leaves the
 * backend). The URL grants read access to that one chunk body until `exp`.
 *
 * One-shot workers (Nosana) upload their result the same way:
 *   POST {PUBLIC_URL}/v1/media/perception/:bet/:nonce?exp=…&sig=…
 * with sig over "verdict/media/v1|perception|bet|nonce|exp".
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { PerceptionResultSink, PerceptionUpload } from '../providers/real/perception.js';

/** Long enough for a queued GPU job (Nosana markets can queue) plus the 30-minute run deadline. */
export const MEDIA_URL_TTL_MS = 6 * 3_600_000;

function mediaKey(ctx: AppContext): Buffer {
  return createHash('sha256').update('verdict/media-url-key').update(ctx.config.biometricKey).digest();
}

function mac(ctx: AppContext, bet: string, witness: string, index: number, exp: number): Buffer {
  return createHmac('sha256', mediaKey(ctx)).update(`verdict/media/v1|${bet}|${witness}|${index}|${exp}`).digest();
}

export function signedChunkUrl(ctx: AppContext, bet: string, witness: string, index: number, ttlMs = MEDIA_URL_TTL_MS): string {
  const exp = ctx.clock.nowMs() + ttlMs;
  const sig = mac(ctx, bet, witness, index, exp).toString('hex');
  return `${ctx.config.publicUrl}/v1/media/chunks/${bet}/${witness}/${index}?exp=${exp}&sig=${sig}`;
}

/** True when `sig` authorizes (bet, witness, index) and `exp` has not passed. */
export function verifyChunkUrl(ctx: AppContext, bet: string, witness: string, index: number, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig || !/^\d{1,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const e = Number(exp);
  if (ctx.clock.nowMs() > e) return false;
  return timingSafeEqual(mac(ctx, bet, witness, index, e), Buffer.from(sig, 'hex'));
}

function uploadMac(ctx: AppContext, bet: string, nonce: string, exp: number): Buffer {
  return createHmac('sha256', mediaKey(ctx)).update(`verdict/media/v1|perception|${bet}|${nonce}|${exp}`).digest();
}

export function signedPerceptionUploadUrl(ctx: AppContext, bet: string, nonce: string, ttlMs = MEDIA_URL_TTL_MS): string {
  const exp = ctx.clock.nowMs() + ttlMs;
  return `${ctx.config.publicUrl}/v1/media/perception/${bet}/${nonce}?exp=${exp}&sig=${uploadMac(ctx, bet, nonce, exp).toString('hex')}`;
}

export function verifyPerceptionUploadUrl(ctx: AppContext, bet: string, nonce: string, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig || !/^\d{1,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const e = Number(exp);
  if (ctx.clock.nowMs() > e) return false;
  return timingSafeEqual(uploadMac(ctx, bet, nonce, e), Buffer.from(sig, 'hex'));
}

export const BLOB_NS_PERCEPTION_UPLOADS = 'perception-uploads';
const uploadKey = (bet: string, nonce: string) => `${bet}-${nonce}.json`;

/** The backend side of one-shot worker uploads (NosanaPerception's result sink). */
export function perceptionResultSink(ctx: AppContext): PerceptionResultSink {
  return {
    uploadUrl: (bet, nonce) => signedPerceptionUploadUrl(ctx, bet, nonce),
    take: (bet, nonce) => {
      const b = ctx.blobs.getBlob(BLOB_NS_PERCEPTION_UPLOADS, uploadKey(bet, nonce));
      return b ? (JSON.parse(Buffer.from(b).toString('utf8')) as PerceptionUpload) : null;
    },
  };
}

/** Validates and stores a worker upload (route handler). */
export function storePerceptionUpload(ctx: AppContext, bet: string, nonce: string, body: unknown): void {
  const u = body as Partial<PerceptionUpload> | null;
  if (!u || typeof u !== 'object') throw new Error('upload must be a JSON object');
  if (typeof u.model_hash !== 'string' || !/^[0-9a-f]{64}$/.test(u.model_hash)) throw new Error('model_hash must be 64 hex chars');
  if (!Number.isSafeInteger(u.flags) || (u.flags as number) < 0 || (u.flags as number) > 0xffff) throw new Error('flags must be a u16');
  if (typeof u.detections_jsonl !== 'string') throw new Error('detections_jsonl must be a string');
  const frame =
    u.frame && Number.isSafeInteger(u.frame.width_px) && Number.isSafeInteger(u.frame.height_px) && u.frame.width_px > 0 && u.frame.height_px > 0
      ? { width_px: u.frame.width_px, height_px: u.frame.height_px }
      : undefined;
  const rec: PerceptionUpload = { model_hash: u.model_hash, flags: u.flags as number, detections_jsonl: u.detections_jsonl, ...(frame ? { frame } : {}) };
  ctx.blobs.putBlob(BLOB_NS_PERCEPTION_UPLOADS, uploadKey(bet, nonce), new TextEncoder().encode(JSON.stringify(rec)));
}
