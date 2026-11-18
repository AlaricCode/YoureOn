// The GG moment and the spoken review request (API-CONTRACT §3.4 bet.gg / review.requested /
// review.closed, §4.3 request_review, §4.5 PAID via / REVIEW_CLOSED; SCHEMAS §10.1).
//
//   bet.gg            the loser's concede was accepted and sent (same commit as bet.state CONCEDED):
//                     who said GG, what it pays, and the pair's record before / after this bet.
//   review.requested  someone in the room asked the judge to check the ruling again (the voice
//                     agent's request_review tool, or the operator's demo route). It is never an
//                     appeal: the loser's phone opens the appeal confirmation (tap + Face ID, device
//                     policy 'appeal') and only that files one. The mic can't tell who spoke, so the
//                     loser is always the one asked.
//   review.closed     the loser kept the ruling ('declined'), or confirm_by passed unconfirmed
//                     ('lapsed'). A confirmed review is the appeal (tx.submitted kind 'appeal');
//                     a GG closes it with bet.gg. Neither gets its own review.closed.
//
// confirm_by = appeal_deadline − 1 s (APPEAL_UI_MARGIN_MS): the server's appeal cutoff. It can't be
// extended: the program refuses an appeal at or after appeal_deadline (ESCROW I10).
import { z } from 'zod/v4';
import { MicroUsdc } from './money';
import { IsoUtc, Party, Uuid } from './primitives';

/** A pair is a rivalry from this many settled bets (= RIVAL_MIN_SETTLED on feat/rivalry-scan). */
export const GG_RIVAL_MIN = 3;

/**
 * The pair's record in party terms (A = challenger). Same fields as feat/rivalry-scan's
 * StageRivalry minus challenge_method: after that merge, PairRecord = StageRivalry.omit({challenge_method: true}).
 */
export const PairRecord = z.object({
  a_wins: z.number().int().nonnegative(),
  b_wins: z.number().int().nonnegative(),
  pushes: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Run of same-winner results ending at the latest settled bet; null if that was a push / none. */
  streak: z.object({ party: Party, length: z.number().int().min(1) }).nullable(),
  rival: z.boolean(),
  includes_seed: z.boolean(),
});
export type PairRecord = z.infer<typeof PairRecord>;

export const GgRecord = z.object({ before: PairRecord, after: PairRecord });
export type GgRecord = z.infer<typeof GgRecord>;

/** bet.gg: the loser's concede was accepted and sent (same commit as bet.state CONCEDED). */
export const BetGgPayload = z
  .object({
    /** The party that said GG (the ruling's loser). */
    by: Party,
    winner: Party,
    /** What the concede pays: shared payout() over the deposited stakes (micro-USDC). */
    to_a: MicroUsdc,
    to_b: MicroUsdc,
    /** null when the record could not be read (never blocks the GG). */
    record: GgRecord.nullable(),
    conceded_at: IsoUtc,
  })
  .refine((p) => p.by !== p.winner, { message: 'winner must be the other party' });
export type BetGgPayload = z.infer<typeof BetGgPayload>;

/** Who started the review request. 'demo' = POST /v1/demo/bets/:id/review (laptop fallback). */
export const ReviewSource = z.enum(['voice', 'demo']);
export type ReviewSource = z.infer<typeof ReviewSource>;

/**
 * review.requested: someone asked the judge to check the ruling again. Never an appeal: only the
 * loser's phone can file one (tap + Face ID, device policy 'appeal'). No speech text, no speaker.
 */
export const ReviewRequestedPayload = z.object({
  review_id: Uuid,
  /** The ruling's loser (decisive camera rulings only): the only phone that is asked. */
  for_party: Party,
  source: ReviewSource,
  requested_at: IsoUtc,
  /** appeal_deadline − 1 s (APPEAL_UI_MARGIN_MS): the appeal cutoff. Not extendable (ESCROW I10). */
  confirm_by: IsoUtc,
});
export type ReviewRequestedPayload = z.infer<typeof ReviewRequestedPayload>;

/** Confirmed = the appeal (tx.submitted kind 'appeal'); GG = bet.gg. Neither has its own close. */
export const ReviewClosedReason = z.enum(['declined', 'lapsed']);
export type ReviewClosedReason = z.infer<typeof ReviewClosedReason>;
export const ReviewClosedPayload = z.object({ review_id: Uuid, reason: ReviewClosedReason });
export type ReviewClosedPayload = z.infer<typeof ReviewClosedPayload>;

/** request_review answers {ok:false, fix, say} with one of these. */
export const ReviewFix = z.enum([
  'NO_RULING',
  'GG_CALLED',
  'FINAL',
  'WINDOW_CLOSED',
  'WITH_PANEL',
  'ONE_REVIEW',
  'NO_LOSER',
  'MARKET',
  'NO_APPEALS_LEFT',
  'WRONG_BET',
  'SLOW_DOWN',
  'INVALID',
  'SERVER',
]);
export type ReviewFix = z.infer<typeof ReviewFix>;
/** A request with less than this left before confirm_by is WINDOW_CLOSED (Face ID needs it). */
export const REVIEW_MIN_LEAD_MS = 1_500;
/** `heard` is kept (audit only, never broadcast) up to this length. */
export const REVIEW_HEARD_MAX = 80;
export const PayoutVia = z.enum(['gg', 'timeout', 'appeal']);
export type PayoutVia = z.infer<typeof PayoutVia>;

/** Record after one decisive result. */
export function recordAfter(before: PairRecord, winner: Party): PairRecord {
  const total = before.total + 1;
  return {
    ...before,
    a_wins: before.a_wins + (winner === 'A' ? 1 : 0),
    b_wins: before.b_wins + (winner === 'B' ? 1 : 0),
    total,
    streak:
      before.streak?.party === winner
        ? { party: winner, length: before.streak.length + 1 }
        : { party: winner, length: 1 },
    rival: total >= GG_RIVAL_MIN,
  };
}

/** "Logan 5-7 Jake" (ASCII hyphen; for [EVENT] values and the stage). */
export const recordLine = (r: PairRecord, n: Record<Party, string>) =>
  `${n.A} ${r.a_wins}-${r.b_wins} ${n.B}`;

/** Client rule: the review sheet / banner is open. */
export const reviewOpen = (
  rv: { confirm_by: string; closed: ReviewClosedReason | null; confirmed: boolean } | null,
  state: string | null,
  nowMs: number,
) => !!rv && !rv.closed && !rv.confirmed && state === 'RULED' && nowMs < Date.parse(rv.confirm_by);
