// The GG moment and the spoken review request on the phones (shared ./gg, API-CONTRACT §3.4
// bet.gg / review.requested / review.closed). Pure TS, tested in node; ../bets/store folds the
// events through foldGg, ./GgScreens renders what the selectors below decide.
//
//   bet.gg            the loser's GG went out: the winner's phone shows "Jake said GG" and the
//                     payout counting up, the loser's a calm "Good game". A concede the server
//                     reverts (bet.state RULED, prev CONCEDED) drops it again.
//   review.requested  someone asked the judge to check the ruling again. Only the loser's phone
//                     (for_party) is asked: it opens the appeal confirmation (tap + Face ID, device
//                     policy 'appeal'); a spoken request never files anything by itself.
//   review.closed     the loser kept the ruling, or confirm_by passed unconfirmed. A confirmed
//                     review is the appeal itself (tx.submitted kind 'appeal'; then APPEALED).
//
// The window is never extended on the phone either: confirm_by is the server's appeal cutoff
// (appeal_deadline − 1 s, ESCROW I10). Past it the sheet closes and the ruling screen (GG until
// the deadline, finalize after) is back exactly as it was.
import {
  reviewOpen,
  type BetGgPayload,
  type PairRecord,
  type ReviewClosedReason,
  type ReviewRequestedPayload,
} from '@youre-on/shared/gg';
import { toMicro } from '@youre-on/shared/money';
import { otherParty, type Party } from '@youre-on/shared/primitives';
import type { RealtimeEvent } from '@youre-on/shared/realtime';

export interface ReviewModel {
  payload: ReviewRequestedPayload;
  closed: ReviewClosedReason | null;
  /** The loser's appeal went out (tx.submitted kind 'appeal'): the panel takes it from here. */
  confirmed: boolean;
}

/** The two fields ../bets/store BetModel carries for this feature. */
export interface GgFields {
  gg: BetGgPayload | null;
  review: ReviewModel | null;
}

/**
 * The GG / review part of one event (already in seq order), as a patch for the bet model; {} when
 * the event does not touch it. `m` is the model before the event.
 */
export function foldGg(m: GgFields, e: RealtimeEvent): Partial<GgFields> {
  switch (e.type) {
    case 'bet.gg':
      return { gg: e.payload };
    case 'review.requested':
      // Once per ruling on the server; a replay of the same request keeps what we know of it.
      return m.review?.payload.review_id === e.payload.review_id
        ? {}
        : { review: { payload: e.payload, closed: null, confirmed: false } };
    case 'review.closed':
      return m.review && m.review.payload.review_id === e.payload.review_id
        ? { review: { ...m.review, closed: e.payload.reason } }
        : {};
    case 'tx.submitted':
      return e.payload.kind === 'appeal' && m.review && !m.review.closed
        ? { review: { ...m.review, confirmed: true } }
        : {};
    case 'bet.state':
      // The concede was reverted (concede_failed): the GG did not go through.
      return e.payload.state === 'RULED' && e.payload.prev === 'CONCEDED' && m.gg
        ? { gg: null }
        : {};
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------

type BetLike = GgFields & { state: string | null };

/** This phone's side of the GG: 'winner' heard it, 'loser' said it; null without one. */
export function myGg(b: Pick<GgFields, 'gg'>, me: Party | null): 'winner' | 'loser' | null {
  if (!b.gg || !me) return null;
  return b.gg.by === me ? 'loser' : 'winner';
}

/** The review sheet is up on this phone: an open review, asked of this phone's party. */
export function reviewSheetOpen(b: BetLike, me: Party | null, nowServerMs: number): boolean {
  const rv = b.review;
  if (!rv || !me || rv.payload.for_party !== me) return false;
  return reviewOpen(
    { confirm_by: rv.payload.confirm_by, closed: rv.closed, confirmed: rv.confirmed },
    b.state,
    nowServerMs,
  );
}

/**
 * The small tag every other view of the ruling shows (the winner, the voice host, a loser who
 * already chose): 'asked' while the review is open, 'stands' once it closed unconfirmed (kept or
 * lapsed), null otherwise (none, confirmed: the appeal screen takes over, or the GG).
 */
export function reviewTag(b: BetLike, nowServerMs: number): 'asked' | 'stands' | null {
  const rv = b.review;
  if (!rv || rv.confirmed || b.gg) return null;
  if (rv.closed) return 'stands';
  if (b.state !== 'RULED') return null;
  return nowServerMs < Date.parse(rv.payload.confirm_by) ? 'asked' : 'stands';
}

/** Ease-out count from `from` to `to` over `ms`, started at `t0` (integer cents). */
export function countUp(from: number, to: number, t0: number, now: number, ms = 1200): number {
  if (ms <= 0 || now >= t0 + ms) return to;
  if (now <= t0) return from;
  const k = (now - t0) / ms;
  const eased = 1 - (1 - k) ** 3;
  return Math.round(from + (to - from) * eased);
}

/** Micro-USDC to whole cents (floor). */
export const microToCents = (micro: bigint): number => Number(micro / 10_000n);

/**
 * What the GG pays this phone beyond its own stake, in cents: the winner's "+$" (the pot minus
 * what they put in), 0 for the loser. Never negative.
 */
export function ggWinCents(gg: BetGgPayload, me: Party, myStakeMicro: string): number {
  const toMe = toMicro(me === 'A' ? gg.to_a : gg.to_b);
  const win = toMe - BigInt(myStakeMicro);
  return win > 0n ? microToCents(win) : 0;
}

/** How long the old record shows before the winner's number ticks over. */
export const RECORD_TICK_MS = 700;

/**
 * The head-to-head on this phone, mine first ("5–7"): `before` until RECORD_TICK_MS after the
 * GG reached the screen, then `after`. null when the server could not read the record.
 */
export function myRecord(
  gg: BetGgPayload,
  me: Party,
  elapsedMs: number,
): { mine: number; theirs: number; ticked: boolean; first: boolean; streak: number } | null {
  if (!gg.record) return null;
  const ticked = elapsedMs >= RECORD_TICK_MS;
  const r: PairRecord = ticked ? gg.record.after : gg.record.before;
  const wins = (p: Party) => (p === 'A' ? r.a_wins : r.b_wins);
  const s = gg.record.after.streak;
  return {
    mine: wins(me),
    theirs: wins(otherParty(me)),
    ticked,
    first: gg.record.before.total === 0,
    streak: ticked && s && s.party === me ? s.length : 0,
  };
}

/** "5–7" (en dash; data). */
export const recordLabel = (r: { mine: number; theirs: number }) => `${r.mine}–${r.theirs}`;

// ---------------------------------------------------------------------------------------
// The loser's review sheet (local UI state on top of the server's review)
// ---------------------------------------------------------------------------------------

/** Why "Check it again" did not go out (DemoApp maps its errors here). */
export type ConfirmFailure = 'cancelled' | 'faceid' | 'refused' | 'too_late' | 'failed';

/**
 * A failed "Check it again" by its error's `code` (duck-typed: WalletError, ApiClientError,
 * ActionError all carry one), so this stays testable without the native modules.
 */
export function confirmFailureOf(e: unknown): ConfirmFailure {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'AUTH_CANCELLED') return 'cancelled';
  if (code === 'AUTH_FAILED' || code === 'BUSY') return 'faceid';
  if (code === 'POLICY_REJECTED') return 'refused';
  if (code === 'APPEAL_WINDOW_CLOSED') return 'too_late';
  return 'failed';
}

export interface ReviewUi {
  /** The review this state is about; a new review_id starts fresh. */
  review_id: string | null;
  busy: 'confirm' | 'decline' | null;
  /** "Keep ruling" was tapped: the sheet is gone on this phone even before review.closed. */
  kept: boolean;
  /** The last confirm failure, shown in the sheet; the sheet stays up (the window runs on). */
  failure: ConfirmFailure | null;
}

export const initialReviewUi: ReviewUi = {
  review_id: null,
  busy: null,
  kept: false,
  failure: null,
};

export type ReviewUiEvent =
  | { type: 'confirm_start' }
  | { type: 'confirm_sent' }
  | { type: 'confirm_failed'; reason: ConfirmFailure }
  | { type: 'decline_start' }
  | { type: 'decline_done' };

/** Local sheet state for `review_id` (state for another review is reset first). */
export function reviewUiReducer(s: ReviewUi, reviewId: string, e: ReviewUiEvent): ReviewUi {
  const cur = s.review_id === reviewId ? s : { ...initialReviewUi, review_id: reviewId };
  switch (e.type) {
    case 'confirm_start':
      return cur.busy ? cur : { ...cur, busy: 'confirm', failure: null };
    case 'confirm_sent':
      return { ...cur, busy: null, failure: null };
    case 'confirm_failed':
      // Face ID cancelled / failed, refused by policy, or a send error: nothing was filed, the
      // sheet stays up until confirm_by and the ruling's window runs on unchanged.
      return { ...cur, busy: null, failure: e.reason };
    case 'decline_start':
      return cur.busy ? cur : { ...cur, busy: 'decline', kept: true, failure: null };
    case 'decline_done':
      return { ...cur, busy: null, kept: true };
  }
}

/** What the ruling route layers on top of the ruling screen for this phone. */
export type ReviewLayer =
  | {
      kind: 'sheet';
      review_id: string;
      /** Local ms (server time − offset) when the sheet closes by itself. */
      confirmByMs: number;
      /** The whole confirm span, for the countdown bar. */
      spanMs: number;
      busy: 'confirm' | 'decline' | null;
      failure: ConfirmFailure | null;
    }
  | { kind: 'tag'; tag: 'asked' | 'stands' }
  | null;

/**
 * Sheet, tag or nothing for this phone now. `nowMs` is local; `offsetMs` = server − local (the
 * runtime clock's offset). The sheet needs: the review asked of me, still open on the server's
 * clock, not kept locally. An appeal in flight on this phone (busy 'confirm') keeps the sheet up
 * past confirm_by until it settles, so its spinner and error stay where the tap was.
 */
export function reviewLayer(
  b: BetLike,
  me: Party | null,
  ui: ReviewUi,
  nowMs: number,
  offsetMs: number,
): ReviewLayer {
  const rv = b.review;
  if (!rv) return null;
  const local = ui.review_id === rv.payload.review_id ? ui : initialReviewUi;
  const serverNow = nowMs + offsetMs;
  const confirming = local.busy === 'confirm' && b.state === 'RULED' && !rv.confirmed && !b.gg;
  if (!local.kept && (reviewSheetOpen(b, me, serverNow) || confirming)) {
    const confirmBy = Date.parse(rv.payload.confirm_by);
    return {
      kind: 'sheet',
      review_id: rv.payload.review_id,
      confirmByMs: confirmBy - offsetMs,
      spanMs: Math.max(1, confirmBy - Date.parse(rv.payload.requested_at)),
      busy: local.busy,
      failure: local.failure,
    };
  }
  const tag = reviewTag(b, serverNow);
  // The loser who tapped "Keep ruling" sees it stand at once (review.closed follows).
  if (tag === 'asked' && local.kept && rv.payload.for_party === me)
    return { kind: 'tag', tag: 'stands' };
  return tag ? { kind: 'tag', tag } : null;
}

/**
 * The voice host's mic opens in RULED only for a ruling that can be reviewed: a decisive camera
 * ruling, never a Dance Off's (its score is deterministic: no "check it again", DANCE-OFF §5).
 */
export function reviewable(b: {
  ruling: { ruling: { outcome: string } } | null;
  envelope: { terms: { evidence_source: string; type?: string } } | null;
}): boolean {
  const o = b.ruling?.ruling.outcome;
  return (
    (o === 'A_WINS' || o === 'B_WINS') &&
    b.envelope?.terms.evidence_source === 'camera' &&
    b.envelope.terms.type !== 'dance_off'
  );
}
