// The `challenge_method:'face'` ticket check.
// Spec: docs/planning/API-CONTRACT.md §2.4.
//
// A match_ticket is the 60 s HMAC token from POST /v1/rooms/:room_id/face-match that binds
// {room, scanner (A), candidate (B), exp} (src/face/ticket.ts). POST /v1/bets accepts a 'face'
// challenge only with a ticket for exactly this room, challenger and opponent that has not
// expired. The ticket only addresses the challenge; B still authorizes on B's own phone.
import type { Env } from '../env';
import { faceConfigOf } from '../face/config';
import { verifyMatchTicketWithKey, type MatchTicketBinding as TicketBinding } from '../face/ticket';

export interface MatchTicketBinding extends TicketBinding {
  now_ms: number;
}

export type MatchTicketVerdict =
  { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'not_issued' };

export function verifyMatchTicket(
  ticket: string | null | undefined,
  binding: MatchTicketBinding,
  env: Env,
): MatchTicketVerdict {
  const v = verifyMatchTicketWithKey(faceConfigOf(env).ticketKey, ticket, binding, binding.now_ms);
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}
