// SCHEMAS §1.2–§1.3 — parties, ids, time, hashes, keys, normalized text.
import { z } from 'zod/v4';
import { isAddress } from '@solana/kit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** A = challenger/proposer, B = challenged. */
export const Party = z.enum(['A', 'B']);
export type Party = z.infer<typeof Party>;
export const otherParty = (p: Party): Party => (p === 'A' ? 'B' : 'A');

export const Uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'lowercase UUIDv4',
  );
export const BetId = Uuid;

/** 16 bytes in RFC 4122 textual order (same as npm `uuid.parse()`); the Bet/vault PDA seed. */
export const betIdToBytes = (id: string): Uint8Array => {
  const bytes = hexToBytes(id.replaceAll('-', ''));
  if (bytes.length !== 16) throw new Error(`bet_id must be 16 bytes: ${id}`);
  return bytes;
};
export const bytesToBetId = (b: Uint8Array): string => {
  if (b.length !== 16) throw new Error(`bet_id must be 16 bytes, got ${b.length}`);
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, '32 bytes as lowercase hex');
export const Pubkey = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .refine((s) => isAddress(s), 'not a 32-byte base58 key');
/** Transaction signature, base58. */
export const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

export const IsoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Date#toISOString() format')
  .refine((s) => {
    const d = new Date(s);
    return !Number.isNaN(d.getTime()) && d.toISOString() === s;
  }, 'not a real instant');
/** Maps 1:1 to i64 seconds. */
export const IsoUtcWholeSecond = IsoUtc.refine((s) => s.endsWith('.000Z'), 'whole seconds only');
export const UnixSeconds = z.number().int().nonnegative();
/** Gemini prices/strikes, as sent. */
export const DecimalStr = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

/** NFC, then collapse whitespace runs to one space, then trim. */
export const normText = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * Applies normText to every string in a JSON value (server-side, before a strict parse).
 * Object.fromEntries defines own data properties, so a JSON `"__proto__"` key stays an own
 * (unknown, rejected-by-strictObject) key instead of becoming the result's prototype, through
 * which required fields could otherwise be inherited past the strict parse.
 */
export function normTextDeep<T>(value: T): T {
  if (typeof value === 'string') return normText(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => normTextDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]: [string, unknown]) => [k, normTextDeep(v)]),
    ) as T;
  }
  return value;
}

/**
 * Same semantics as ES2024 `String#isWellFormed` (no lone surrogates). Hand-written so the
 * check does not depend on the engine (Hermes) or on the ES2024 lib typings.
 */
export function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (n < 0xdc00 || n > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Normalized free text: NFC, trimmed, single-spaced, no control chars, no lone surrogates. Rejects, never fixes. */
export const NText = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (s) => isWellFormedUtf16(s) && !CONTROL.test(s) && s === normText(s),
      'text must be NFC, trimmed, single-spaced, no control chars',
    );
export const DisplayName = NText(32);

export const sha256Hex = (s: string | Uint8Array): string =>
  bytesToHex(sha256(typeof s === 'string' ? utf8ToBytes(s) : s));

/** API and realtime payloads. Inside Terms a party is only TermsParty {pubkey, display_name}. */
export const UserRef = z.object({
  user_id: Uuid,
  pubkey: Pubkey,
  display_name: DisplayName,
  /** Opt-in profile photo; never the enrollment selfie. */
  avatar_url: z.url().nullable(),
});
export type UserRef = z.infer<typeof UserRef>;
