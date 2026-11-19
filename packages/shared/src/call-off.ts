// API-CONTRACT §2.9a — "Call it off": a mutual stop of a locked bet whose round can't happen (the
// camera fails, the judge-cam phone dies, a simulator), so neither phone is pinned on the attempt
// screens until resolve_deadline. Either party asks (POST /v1/bets/:bet_id/call-off {agree:true});
// the other party's agree completes it, a {agree:false} (either side) or CALL_OFF_TTL_MS clears it.
// Both agreeing issues a VOID 'safety_stop' Ruling (model CALLED_OFF_MODEL, ./ruling) through the
// normal ruling -> resolve(Refund) -> VOIDED path. Only while the bet is LOCKED, ATTEMPT (the
// attempt still recording) or JUDGING after a REDO: never once a ruling is in flight or issued.
// The request lives in bet_events ('bet.call_off', append-only); there is no table.
import { z } from 'zod/v4';
import { BetId, Hex32, IsoUtc } from './primitives';

/** An open request lapses this long after it was made (the other phone's prompt closes). */
export const CALL_OFF_TTL_MS = 60_000;

/** Who took a call-off step: a party, or the operator (POST /v1/demo/bets/:bet_id/void). */
export const CallOffActor = z.enum(['A', 'B', 'operator']);
export type CallOffActor = z.infer<typeof CallOffActor>;

/** POST /v1/bets/:bet_id/call-off body. */
export const CallOffRequest = z.strictObject({ agree: z.boolean() });
export type CallOffRequest = z.infer<typeof CallOffRequest>;

/**
 * POST /v1/bets/:bet_id/call-off 200: `requested` (open, waiting for the other party until
 * `expires_at`), `cleared` (this call declined or withdrew it), `agreed` (both agreed: the VOID
 * ruling is issued, `ruling_hash`), `none` (agree:false with nothing open).
 */
export const CallOffResponse = z.object({
  status: z.enum(['requested', 'cleared', 'agreed', 'none']),
  expires_at: IsoUtc.nullable(),
  ruling_hash: Hex32.nullable(),
});
export type CallOffResponse = z.infer<typeof CallOffResponse>;

/**
 * Realtime `bet.call_off` (server, to both parties): a request opened (`by` = the asker,
 * `expires_at` set), cleared (`by` = who declined or withdrew it) or agreed (`by` = the party
 * that agreed, or 'operator'; ruling.issued follows in the same commit).
 */
export const CallOffPayload = z.object({
  status: z.enum(['requested', 'cleared', 'agreed']),
  by: CallOffActor,
  expires_at: IsoUtc.nullable(),
});
export type CallOffPayload = z.infer<typeof CallOffPayload>;

/**
 * What a call-off ruling commits to: evidence_hash = hashJcs(CallOffRecord), stored verbatim in
 * rulings.evidence_canonical. Who asked and who agreed (both 'operator' for the demo void).
 */
export const CallOffRecord = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('call_off'),
  bet_id: BetId,
  terms_hash: Hex32,
  attempt_no: z.number().int().min(1),
  requested_by: CallOffActor,
  requested_at: IsoUtc,
  agreed_by: CallOffActor,
  agreed_at: IsoUtc,
});
export type CallOffRecord = z.infer<typeof CallOffRecord>;

/** The ruling reason (≤ 280) both phones and the stage read. */
export const CALLED_OFF_REASON = 'Called off by both players. Everyone gets their money back.';
/** The operator's demo void (no player asked). */
export const OPERATOR_VOID_REASON = 'Called off. Everyone gets their money back.';

export const callOffPath = (betId: string) => `/v1/bets/${encodeURIComponent(betId)}/call-off`;

/** Is a request (the latest bet.call_off payload) still open at `nowMs`? */
export function callOffOpen(
  p: Pick<CallOffPayload, 'status' | 'expires_at'> | null | undefined,
  nowMs: number,
): boolean {
  if (!p || p.status !== 'requested' || p.expires_at === null) return false;
  return Date.parse(p.expires_at) > nowMs;
}
