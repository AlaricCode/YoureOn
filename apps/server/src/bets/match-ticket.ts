// The `challenge_method:'face'` ticket check (API-CONTRACT §2.4, §2.5). PENDING: TASKS D4-M1.
//
// A match_ticket is the opaque 60 s token from POST /v1/rooms/:room_id/face-match that binds
// {scanner, candidate, room}. The face-match route does not exist yet, so no valid ticket can
// exist and every 'face' challenge is refused with VALIDATION_FAILED ("a bad or expired
// ticket", §2.5). D4-M1 replaces `verifyMatchTicket` (one function; the route already calls
// it with the binding it must check) — no other change to bets/routes.ts is needed.
export interface MatchTicketBinding {
  scanner_user_id: string;
  candidate_user_id: string;
  room_id: string;
  now_ms: number;
}

export type MatchTicketVerdict =
  { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'not_issued' };

export function verifyMatchTicket(
  ticket: string | null | undefined,
  binding: MatchTicketBinding,
): MatchTicketVerdict {
  void binding;
  if (!ticket) return { ok: false, reason: 'missing' };
  return { ok: false, reason: 'not_issued' }; // D4-M1: verify the ticket against `binding`
}
