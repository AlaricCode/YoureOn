// Stand-in data for the design preview (src/preview/PreviewApp "GG moment" entries): the GG
// payload (Logan beats Jake 4-7 -> 5-7, $5 each) and a review asked of the loser, parsed through
// the shared schemas like the socket does.
import { BetGgPayload, ReviewRequestedPayload, type PairRecord } from '@youre-on/shared/gg';

import type { GgFields, ReviewModel } from './model';

const BEFORE: PairRecord = {
  a_wins: 4,
  b_wins: 7,
  pushes: 0,
  total: 11,
  streak: { party: 'A', length: 1 },
  rival: true,
  includes_seed: true,
};

/** Jake (B) said GG on Logan's (A) $5-each bottle flip. */
export const previewGg = (): BetGgPayload =>
  BetGgPayload.parse({
    by: 'B',
    winner: 'A',
    to_a: '10000000',
    to_b: '0',
    record: {
      before: BEFORE,
      after: { ...BEFORE, a_wins: 5, total: 12, streak: { party: 'A', length: 2 } },
    },
    conceded_at: new Date().toISOString(),
  });

/** A review asked of B, with `windowMs` until confirm_by (server time = local in the preview). */
export function previewReview(windowMs: number, nowMs = Date.now()): ReviewModel {
  return {
    payload: ReviewRequestedPayload.parse({
      review_id: '7e57a11e-5e1f-4a9b-8c3d-2f1e0d9c8b7a',
      for_party: 'B',
      source: 'voice',
      requested_at: new Date(nowMs).toISOString(),
      confirm_by: new Date(nowMs + windowMs).toISOString(),
    }),
    closed: null,
    confirmed: false,
  };
}

/** The ruling-route bet the review preview renders (state RULED, no GG yet). */
export const previewReviewBet = (review: ReviewModel | null): GgFields & { state: string } => ({
  state: 'RULED',
  gg: null,
  review,
});
