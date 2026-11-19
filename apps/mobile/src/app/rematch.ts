// Double or nothing (docs/planning/DANCE-OFF.md §7), for every bet type. Pure TS over injected
// deps, tested in node:
//   POST /v1/bets/:id/rematch (signed; either party; the bet is over) creates a new DRAFTING bet
//   in the same room with the caller as A, and B gets the usual bet.invited, carrying rematch_of
//   and suggested_stake_usd (2 x the old per-side stake, capped). This phone then opens the new
//   bet on the normal negotiate screen: the challenger picks ANY bet type there (typed, Bitcoin,
//   Dance off), with every stake picker defaulting to the suggestion.
import { suggestedRematchStakeUsd, type BetSnapshot } from '@youre-on/shared/api';
import type { BetState } from '@youre-on/shared/bet-state';
import type { Terms } from '@youre-on/shared/terms';

import type { BetModel } from '../bets/store';
import type { YoApi } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import { homeErrorLabel } from './homeErrors';

/** The server takes a rematch of a bet that is over (§7). */
const REMATCHABLE: ReadonlySet<BetState> = new Set(['PAID', 'VOIDED', 'FINALIZED', 'EXPIRED']);
export const canRematch = (state: BetState | null): boolean =>
  state !== null && REMATCHABLE.has(state);

/** The stake the new bet's pickers default to: the server's, else the same rule on this phone. */
export const rematchStakeUsd = (
  b: Pick<BetModel, 'suggestedStakeUsd'> & { envelope: { terms: Pick<Terms, 'stakes'> } | null },
): number | null =>
  b.suggestedStakeUsd ?? (b.envelope ? suggestedRematchStakeUsd(b.envelope.terms.stakes) : null);

/**
 * The chip a fixed picker (the Bitcoin panel's) starts on: the largest one at or below the
 * suggestion, else the smallest. The typed and dance pickers add the suggestion as its own chip.
 */
export function chipAtMost<T extends number>(chips: readonly T[], usd: number | null): T | null {
  if (usd === null || chips.length === 0) return null;
  let best: T | null = null;
  for (const c of chips) if (c <= usd && (best === null || c > best)) best = c;
  return best ?? chips.reduce((a, b) => (b < a ? b : a));
}

/** The new bet as this phone first knows it: A (the caller), following `of`. */
export const withRematch = (m: BetModel, of: string, suggestedStakeUsd: number): BetModel => ({
  ...m,
  my_party: m.my_party ?? 'A',
  rematchOf: m.rematchOf ?? of,
  suggestedStakeUsd: m.suggestedStakeUsd ?? suggestedStakeUsd,
});

export type RematchOutcome =
  | {
      ok: true;
      betId: string;
      suggestedStakeUsd: number;
      /** GET /v1/bets/:id of the new bet; null when that read failed (the socket fills it in). */
      snapshot: BetSnapshot | null;
    }
  /** `freshKey`: a 4xx is replayed for its Idempotency-Key, so the next tap needs a new one. */
  | { ok: false; note: string; freshKey: boolean };

/**
 * POST …/rematch under a pinned key (a double tap or a lost response is the same new bet), then
 * the new bet's snapshot so the negotiate screen can open on it at once. Never throws.
 */
export async function startRematch(
  d: { api: Pick<YoApi, 'rematch' | 'getBet'> },
  betId: string,
  idempotencyKey: string,
): Promise<RematchOutcome> {
  let r: { bet_id: string; suggested_stake_usd: number };
  try {
    r = await d.api.rematch(betId, idempotencyKey);
  } catch (e) {
    const answered = e instanceof ApiClientError && e.status >= 400 && e.status < 500;
    // pair_busy, too many open bets, slow down, offline: the challenge wording (../homeErrors).
    return { ok: false, note: homeErrorLabel('challenge', e), freshKey: answered };
  }
  const snapshot = await d.api.getBet(r.bet_id).catch(() => null);
  return {
    ok: true,
    betId: r.bet_id,
    suggestedStakeUsd: r.suggested_stake_usd,
    snapshot,
  };
}
