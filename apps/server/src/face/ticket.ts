// Match tickets: a short-lived HMAC token from POST /v1/rooms/:id/face-match that binds
// {room, challenger (the scanner), target (the matched member), exp}. Its only use is
// POST /v1/bets with challenge_method 'face'. It addresses a challenge; it authorizes nothing.
// Spec: docs/planning/API-CONTRACT.md §2.4.
//
//   mt1.<base64url(JSON {r, a, b, e})>.<base64url(HMAC-SHA256(key, "mt1." + payload))>
//
// The key is already domain-separated (src/face/config.ts). Verification is constant time on
// the MAC and checks the MAC before reading the payload, then the binding, then the expiry.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import { MATCH_TICKET_TTL_MS } from '@youre-on/shared/face';
import { Uuid } from '@youre-on/shared/primitives';

const PREFIX = 'mt1.';
const TICKET_RE = /^mt1\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/;

const Payload = z.object({
  r: Uuid,
  a: Uuid,
  b: Uuid,
  e: z.number().int().positive(),
});

export interface MatchTicketBinding {
  /** The scanner, who becomes party A (the challenger). */
  scanner_user_id: string;
  /** The matched member, who becomes party B (the target). */
  candidate_user_id: string;
  room_id: string;
}

export type MatchTicketVerdict =
  { ok: true; expires_at_ms: number } | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

const mac = (key: Uint8Array, payloadB64: string): Buffer =>
  createHmac('sha256', key).update(`${PREFIX}${payloadB64}`).digest();

/** Issues a ticket valid until `nowMs + ttlMs`. */
export function issueMatchTicket(
  key: Uint8Array,
  binding: MatchTicketBinding,
  nowMs: number,
  ttlMs: number = MATCH_TICKET_TTL_MS,
): { ticket: string; expires_at_ms: number } {
  const e = nowMs + ttlMs;
  const payload = Buffer.from(
    JSON.stringify({
      r: binding.room_id,
      a: binding.scanner_user_id,
      b: binding.candidate_user_id,
      e,
    }),
    'utf8',
  ).toString('base64url');
  return {
    ticket: `${PREFIX}${payload}.${mac(key, payload).toString('base64url')}`,
    expires_at_ms: e,
  };
}

/** Checks `ticket` against the binding the caller is about to act on. Never throws. */
export function verifyMatchTicketWithKey(
  key: Uint8Array,
  ticket: string | null | undefined,
  binding: MatchTicketBinding,
  nowMs: number,
): MatchTicketVerdict {
  if (!ticket) return { ok: false, reason: 'missing' };
  const m = TICKET_RE.exec(ticket);
  if (!m) return { ok: false, reason: 'invalid' };
  const [, payloadB64, sigB64] = m as unknown as [string, string, string];
  const given = Buffer.from(sigB64, 'base64url');
  const want = mac(key, payloadB64);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const p = Payload.safeParse(parsed);
  if (!p.success) return { ok: false, reason: 'invalid' };
  if (
    p.data.r !== binding.room_id ||
    p.data.a !== binding.scanner_user_id ||
    p.data.b !== binding.candidate_user_id
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (nowMs >= p.data.e) return { ok: false, reason: 'expired' };
  return { ok: true, expires_at_ms: p.data.e };
}
