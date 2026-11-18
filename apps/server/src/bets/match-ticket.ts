// The `challenge_method:'face'` ticket (API-CONTRACT §2.4, §2.5; TASKS D4-M1).
//
// POST /v1/rooms/:room_id/face-match issues a match_ticket: an opaque, 60 s token that binds
// {scanner, candidate, room}. Its only use is POST /v1/bets with challenge_method 'face', which
// calls `verifyMatchTicket` with the binding it must check.
//
// Format: `mt1.<payload>.<mac>`, both base64url. payload = JSON {s, c, r, exp, n} (scanner,
// candidate, room, expiry ms, random nonce); mac = HMAC-SHA256(secret, "yo.match-ticket.v1|" +
// payload). No score, embedding or face data is in a ticket.
//
// The secret is MATCH_TICKET_SECRET (32+ bytes) when set, so every server machine accepts every
// other machine's tickets. Unset, each process makes a random one at first use: tickets then only
// verify on the machine that issued them, which is fine for one Fly machine and for tests.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { MATCH_TICKET_TTL_MS } from '@youre-on/shared/face';

export interface MatchTicketBinding {
  scanner_user_id: string;
  candidate_user_id: string;
  room_id: string;
  now_ms: number;
}

export type MatchTicketVerdict =
  { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'not_issued' };

const PREFIX = 'mt1';
const MAC_LABEL = 'yo.match-ticket.v1|';

let secret: Buffer | null = null;

/** Sets the HMAC key from MATCH_TICKET_SECRET (base64, base64url or hex of ≥ 32 bytes). */
export function configureMatchTicketSecret(value: string | undefined): void {
  if (!value) return;
  const decoded = /^[0-9a-f]+$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
  if (decoded.length < 32) throw new Error('MATCH_TICKET_SECRET must be at least 32 bytes');
  secret = decoded;
}

function key(): Buffer {
  secret ??= randomBytes(32);
  return secret;
}

const mac = (payload: string): Buffer =>
  createHmac('sha256', key())
    .update(MAC_LABEL + payload)
    .digest();

interface Payload {
  s: string;
  c: string;
  r: string;
  exp: number;
  n: string;
}

export function issueMatchTicket(
  b: Omit<MatchTicketBinding, 'now_ms'> & { now_ms: number },
  ttlMs = MATCH_TICKET_TTL_MS,
): { ticket: string; expires_at_ms: number } {
  const exp = b.now_ms + ttlMs;
  const body: Payload = {
    s: b.scanner_user_id,
    c: b.candidate_user_id,
    r: b.room_id,
    exp,
    n: randomBytes(9).toString('base64url'),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return {
    ticket: `${PREFIX}.${payload}.${mac(payload).toString('base64url')}`,
    expires_at_ms: exp,
  };
}

export function verifyMatchTicket(
  ticket: string | null | undefined,
  binding: MatchTicketBinding,
): MatchTicketVerdict {
  if (!ticket) return { ok: false, reason: 'missing' };
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'invalid' };
  const [, payload, sig] = parts as [string, string, string];
  const given = Buffer.from(sig, 'base64url');
  const want = mac(payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: 'invalid' };
  }
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Payload;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    p.s !== binding.scanner_user_id ||
    p.c !== binding.candidate_user_id ||
    p.r !== binding.room_id ||
    typeof p.exp !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (binding.now_ms >= p.exp) return { ok: false, reason: 'expired' };
  return { ok: true };
}
