// The GG moment and the spoken review request on the phones (../model), folded through the real
// bet store from parsed realtime envelopes: the review window (confirm_by, never extended),
// loser-only, "Keep ruling", a cancelled Face ID (the window runs on), the appeal confirming it,
// the GG closing it, and the GG payout numbers.
import { hashJcs } from '@youre-on/shared/jcs';
import { describe, expect, it } from 'vitest';

import { BET, envelope, ev, ruling, snapshot, stateEv } from '../../app/__tests__/fixtures';
import { routeForBet, appReducer, initialApp } from '../../app/machine';
import { applyBetEvent, emptyBet, fromSnapshot, type BetModel } from '../../bets/store';
import {
  confirmFailureOf,
  countUp,
  foldGg,
  ggWinCents,
  initialReviewUi,
  myGg,
  myRecord,
  RECORD_TICK_MS,
  recordLabel,
  reviewable,
  reviewLayer,
  reviewSheetOpen,
  reviewTag,
  reviewUiReducer,
  type ReviewUi,
  type ReviewUiEvent,
} from '../model';
import { previewGg, previewReview } from '../preview';

const DEADLINE_S = 1_795_000_100;
const CONFIRM_BY = DEADLINE_S * 1000 - 1000; // appeal_deadline − APPEAL_UI_MARGIN_MS
const REQUESTED = CONFIRM_BY - 6000;
const REVIEW_ID = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const SIG = '5'.repeat(88);

const fold = (m: BetModel, ...events: ReturnType<typeof ev>[]) => events.reduce(applyBetEvent, m);

/** `me`'s phone at RULED on an A_WINS camera ruling: B lost. */
function ruled(me: 'A' | 'B', outcome: 'A_WINS' | 'B_WINS' | 'REDO' = 'A_WINS'): BetModel {
  const m = fromSnapshot(
    snapshot({
      state: 'JUDGING',
      my_party: me,
      envelope: envelope(),
      last_seq: 10,
      deadlines: {
        accept_deadline: null,
        resolve_deadline: null,
        appeal_deadline: DEADLINE_S,
        appeal_resolve_deadline: null,
      },
    }),
  );
  const r = ruling(outcome);
  return fold(
    m,
    ev('ruling.issued', { ruling: r, ruling_hash: hashJcs(r) }, 11),
    stateEv('RULED', 12),
  );
}

const requested = (seq: number, forParty: 'A' | 'B' = 'B', id = REVIEW_ID) =>
  ev(
    'review.requested',
    {
      review_id: id,
      for_party: forParty,
      source: 'voice',
      requested_at: new Date(REQUESTED).toISOString(),
      confirm_by: new Date(CONFIRM_BY).toISOString(),
    },
    seq,
  );
const closed = (seq: number, reason: 'declined' | 'lapsed', id = REVIEW_ID) =>
  ev('review.closed', { review_id: id, reason }, seq);
const ggEv = (seq: number) =>
  ev(
    'bet.gg',
    {
      by: 'B',
      winner: 'A',
      to_a: '10000000',
      to_b: '0',
      record: previewGg().record,
      conceded_at: '2026-11-21T18:08:05.000Z',
    },
    seq,
  );
const transition = (state: string, prev: string, seq: number, reason: string | null = null) =>
  ev(
    'bet.state',
    { state, prev, onchain_status: null, chain_ack: 'none', pending_tx: null, reason },
    seq,
  );

const ui = (...events: ReviewUiEvent[]): ReviewUi =>
  events.reduce((s, e) => reviewUiReducer(s, REVIEW_ID, e), initialReviewUi);

describe('store folds (bet.gg, review.requested / review.closed, tx.submitted appeal)', () => {
  it('starts empty', () => {
    expect(emptyBet(BET)).toMatchObject({ gg: null, review: null });
  });

  it('a review request is kept open, then closed by its review.closed', () => {
    let m = fold(ruled('B'), requested(13));
    expect(m.review).toMatchObject({
      payload: { review_id: REVIEW_ID, for_party: 'B' },
      closed: null,
      confirmed: false,
    });
    m = fold(m, closed(14, 'lapsed'));
    expect(m.review?.closed).toBe('lapsed');
  });

  it('a replayed request (resync) keeps what is known; a close for another review is ignored', () => {
    let m = fold(ruled('B'), requested(13), closed(14, 'declined'));
    m = applyBetEvent(m, requested(13));
    expect(m.review?.closed).toBe('declined');
    const other = applyBetEvent(
      fold(ruled('B'), requested(13)),
      closed(14, 'declined', '00000000-0000-4000-8000-000000000001'),
    );
    expect(other.review?.closed).toBeNull();
  });

  it('the appeal going out confirms the review; other submissions do not', () => {
    const m = fold(ruled('B'), requested(13));
    expect(
      applyBetEvent(m, ev('tx.submitted', { kind: 'concede', signature: SIG }, 14)).review
        ?.confirmed,
    ).toBe(false);
    expect(
      applyBetEvent(m, ev('tx.submitted', { kind: 'appeal', signature: SIG }, 14)).review
        ?.confirmed,
    ).toBe(true);
  });

  it('bet.gg is kept; a reverted concede (RULED after CONCEDED) drops it', () => {
    let m = fold(ruled('A'), ggEv(13), transition('CONCEDED', 'RULED', 14));
    expect(m.gg?.by).toBe('B');
    expect(m.state).toBe('CONCEDED');
    m = applyBetEvent(m, transition('RULED', 'CONCEDED', 15, 'concede_failed'));
    expect(m.gg).toBeNull();
    expect(m.state).toBe('RULED');
  });

  it('the cold-start replay of the log rebuilds both (same reducer)', () => {
    const m = fold(ruled('A'), requested(13), ggEv(14), transition('CONCEDED', 'RULED', 15));
    expect(m.review?.payload.review_id).toBe(REVIEW_ID);
    expect(m.gg?.winner).toBe('A');
  });

  it('foldGg leaves unrelated events alone', () => {
    expect(foldGg({ gg: null, review: null }, stateEv('PAID', 20))).toEqual({});
    expect(
      foldGg(
        { gg: null, review: null },
        ev('tx.submitted', { kind: 'appeal', signature: SIG }, 21),
      ),
    ).toEqual({});
  });
});

describe('the review window: loser only, confirm_by, never extended', () => {
  it('opens the sheet on the loser phone only', () => {
    const before = CONFIRM_BY - 3000;
    expect(reviewSheetOpen(fold(ruled('B'), requested(13)), 'B', before)).toBe(true);
    // The winner (and the voice host, A here) only sees the tag.
    expect(reviewSheetOpen(fold(ruled('A'), requested(13)), 'A', before)).toBe(false);
    expect(reviewTag(fold(ruled('A'), requested(13)), before)).toBe('asked');
  });

  it('a request naming the other party never opens this phone', () => {
    expect(reviewSheetOpen(fold(ruled('B'), requested(13, 'A')), 'B', CONFIRM_BY - 3000)).toBe(
      false,
    );
  });

  it('closes at confirm_by on the server clock (the appeal cutoff), with or without review.closed', () => {
    const m = fold(ruled('B'), requested(13));
    expect(reviewSheetOpen(m, 'B', CONFIRM_BY - 1)).toBe(true);
    expect(reviewSheetOpen(m, 'B', CONFIRM_BY)).toBe(false);
    // No review.closed arrived (a server restart lost the lapse timer): the tag still says it stands.
    expect(reviewTag(m, CONFIRM_BY)).toBe('stands');
  });

  it('uses the server clock: a phone 2 s behind still closes at confirm_by', () => {
    const m = fold(ruled('B'), requested(13));
    const offsetMs = 2000; // server − local
    const localJustBefore = CONFIRM_BY - offsetMs - 1;
    const open = reviewLayer(m, 'B', initialReviewUi, localJustBefore, offsetMs);
    expect(open).toMatchObject({ kind: 'sheet', confirmByMs: CONFIRM_BY - offsetMs, spanMs: 6000 });
    expect(reviewLayer(m, 'B', initialReviewUi, localJustBefore + 1, offsetMs)).toEqual({
      kind: 'tag',
      tag: 'stands',
    });
  });

  it('only while RULED: GG, APPEALED and a payout all close it', () => {
    const now = CONFIRM_BY - 3000;
    const base = fold(ruled('B'), requested(13));
    expect(
      reviewSheetOpen(fold(base, ggEv(14), transition('CONCEDED', 'RULED', 15)), 'B', now),
    ).toBe(false);
    expect(reviewTag(fold(base, ggEv(14), transition('CONCEDED', 'RULED', 15)), now)).toBeNull();
    expect(reviewSheetOpen(fold(base, transition('APPEALED', 'RULED', 14)), 'B', now)).toBe(false);
    expect(reviewSheetOpen(fold(base, transition('FINALIZED', 'RULED', 14)), 'B', now)).toBe(false);
  });

  it('the route stays the ruling screen under the sheet (GG and I appeal come back after it)', () => {
    const m = fold(ruled('B'), requested(13));
    const app = appReducer(initialApp, {
      type: 'signed_in',
      me: {
        user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        pubkey: envelope().terms.party_b.pubkey,
        display_name: 'Jake',
        avatar_url: null,
      },
      deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd0b',
    });
    expect(routeForBet(app, m)).toBe('ruling');
  });
});

describe('the loser sheet (local state over the server review)', () => {
  const now = CONFIRM_BY - 4000;
  const m = () => fold(ruled('B'), requested(13));

  it('Check it again: busy while Face ID runs, then the appeal confirms and the sheet goes', () => {
    const s = ui({ type: 'confirm_start' });
    expect(reviewLayer(m(), 'B', s, now, 0)).toMatchObject({ kind: 'sheet', busy: 'confirm' });
    // A double tap while busy changes nothing.
    expect(reviewUiReducer(s, REVIEW_ID, { type: 'confirm_start' })).toBe(s);
    const sent = reviewUiReducer(s, REVIEW_ID, { type: 'confirm_sent' });
    const after = fold(m(), ev('tx.submitted', { kind: 'appeal', signature: SIG }, 14));
    expect(reviewLayer(after, 'B', sent, now, 0)).toBeNull();
    expect(
      reviewLayer(fold(after, transition('APPEALED', 'RULED', 15)), 'B', sent, now, 0),
    ).toBeNull();
  });

  it('a cancelled Face ID files nothing: the sheet stays and the window runs on to confirm_by', () => {
    const s = ui({ type: 'confirm_start' }, { type: 'confirm_failed', reason: 'cancelled' });
    expect(reviewLayer(m(), 'B', s, now, 0)).toMatchObject({
      kind: 'sheet',
      busy: null,
      failure: 'cancelled',
    });
    // They can try again …
    expect(reviewUiReducer(s, REVIEW_ID, { type: 'confirm_start' })).toMatchObject({
      busy: 'confirm',
      failure: null,
    });
    // … but at confirm_by it is over: the plain ruling screen (GG until the deadline) is back.
    expect(reviewLayer(m(), 'B', s, CONFIRM_BY, 0)).toEqual({ kind: 'tag', tag: 'stands' });
  });

  it('an appeal still in flight at confirm_by keeps its sheet (spinner, then its error)', () => {
    const busy = ui({ type: 'confirm_start' });
    expect(reviewLayer(m(), 'B', busy, CONFIRM_BY + 200, 0)).toMatchObject({
      kind: 'sheet',
      busy: 'confirm',
    });
    const late = reviewUiReducer(busy, REVIEW_ID, { type: 'confirm_failed', reason: 'too_late' });
    expect(reviewLayer(m(), 'B', late, CONFIRM_BY + 400, 0)).toEqual({
      kind: 'tag',
      tag: 'stands',
    });
  });

  it('Keep ruling: gone at once on this phone, the ruling stands; review.closed follows', () => {
    const s = ui({ type: 'decline_start' });
    expect(reviewLayer(m(), 'B', s, now, 0)).toEqual({ kind: 'tag', tag: 'stands' });
    const done = reviewUiReducer(s, REVIEW_ID, { type: 'decline_done' });
    expect(reviewLayer(fold(m(), closed(14, 'declined')), 'B', done, now, 0)).toEqual({
      kind: 'tag',
      tag: 'stands',
    });
    // The winner sees it stand too, once the server closed it.
    expect(reviewTag(fold(ruled('A'), requested(13), closed(14, 'declined')), now)).toBe('stands');
  });

  it('local state for an older review never leaks into a new one', () => {
    const s = reviewUiReducer(initialReviewUi, 'old-review', { type: 'decline_start' });
    expect(reviewLayer(m(), 'B', s, now, 0)).toMatchObject({ kind: 'sheet', busy: null });
  });

  it('maps the confirm errors (wallet, policy, server cutoff)', () => {
    expect(confirmFailureOf({ code: 'AUTH_CANCELLED' })).toBe('cancelled');
    expect(confirmFailureOf({ code: 'AUTH_FAILED' })).toBe('faceid');
    expect(confirmFailureOf({ code: 'POLICY_REJECTED' })).toBe('refused');
    expect(confirmFailureOf({ code: 'APPEAL_WINDOW_CLOSED' })).toBe('too_late');
    expect(confirmFailureOf(new Error('network'))).toBe('failed');
    expect(confirmFailureOf(null)).toBe('failed');
  });
});

describe('the voice host mic in RULED: decisive camera rulings only', () => {
  it('A_WINS / B_WINS on a camera bet', () => {
    expect(reviewable(ruled('A'))).toBe(true);
    expect(reviewable(ruled('A', 'B_WINS'))).toBe(true);
    expect(reviewable(ruled('A', 'REDO'))).toBe(false);
    expect(reviewable(emptyBet(BET))).toBe(false);
  });
  it('never a Gemini bet', () => {
    const m = ruled('A');
    const gemini = { ...m, envelope: { terms: { evidence_source: 'gemini' } } };
    expect(reviewable(gemini)).toBe(false);
  });
});

describe('the GG payout', () => {
  const gg = previewGg();

  it('who said it', () => {
    expect(myGg({ gg }, 'A')).toBe('winner');
    expect(myGg({ gg }, 'B')).toBe('loser');
    expect(myGg({ gg: null }, 'A')).toBeNull();
  });

  it("the winner's +$ is the pot minus their own stake; the loser's is 0", () => {
    expect(ggWinCents(gg, 'A', '5000000')).toBe(500);
    expect(ggWinCents(gg, 'B', '5000000')).toBe(0);
  });

  it('the record ticks over after RECORD_TICK_MS, mine first', () => {
    expect(myRecord(gg, 'A', 0)).toMatchObject({ mine: 4, theirs: 7, ticked: false, streak: 0 });
    const after = myRecord(gg, 'A', RECORD_TICK_MS);
    expect(after).toMatchObject({ mine: 5, theirs: 7, ticked: true, first: false, streak: 2 });
    expect(recordLabel(after!)).toBe('5–7');
    expect(myRecord(gg, 'B', RECORD_TICK_MS)).toMatchObject({ mine: 7, theirs: 5, streak: 0 });
    expect(myRecord({ ...gg, record: null }, 'A', 5000)).toBeNull();
  });

  it('a first meeting is flagged', () => {
    const zero = {
      a_wins: 0,
      b_wins: 0,
      pushes: 0,
      total: 0,
      streak: null,
      rival: false,
      includes_seed: false,
    };
    const first = {
      ...gg,
      record: {
        before: zero,
        after: { ...zero, a_wins: 1, total: 1, streak: { party: 'A' as const, length: 1 } },
      },
    };
    expect(myRecord(first, 'A', 1000)).toMatchObject({
      first: true,
      mine: 1,
      theirs: 0,
      streak: 1,
    });
  });

  it('counts up with an ease-out, clamped at both ends', () => {
    expect(countUp(0, 1000, 100, 50)).toBe(0);
    expect(countUp(0, 1000, 100, 100)).toBe(0);
    const mid = countUp(0, 1000, 100, 700);
    expect(mid).toBeGreaterThan(500); // ease-out: past halfway at half time
    expect(mid).toBeLessThan(1000);
    expect(countUp(0, 1000, 100, 1300)).toBe(1000);
    expect(countUp(0, 1000, 100, 99_999)).toBe(1000);
    expect(countUp(250, 250, 0, 10)).toBe(250);
  });

  it('the preview data parses and opens the sheet in its window', () => {
    const rv = previewReview(5000, 1_000_000);
    const m = { state: 'RULED', gg: null, review: rv };
    expect(reviewSheetOpen(m, 'B', 1_004_999)).toBe(true);
    expect(reviewSheetOpen(m, 'B', 1_005_000)).toBe(false);
  });
});
