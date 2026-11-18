// The head-to-head as the rivalry overlay shows it (pure). `statsOf` takes the server's
// HeadToHead, old or new: a server without the streak fields still gives a record, a net and the
// "Rivals" chip (computed from the counts), just no streak.
import { signedUsd } from '../bets/view';
import { rivalryFill } from './copy';
import type { RivalryStats } from './types';

/** Settled bets between two people that make them "Rivals" (packages/shared RIVAL_MIN_SETTLED). */
export const RIVAL_MIN_SETTLED = 3;

/** HeadToHead (packages/shared api.ts), with the fields older servers lack made optional. */
export interface HeadToHeadLike {
  readonly wins: number;
  readonly losses: number;
  readonly pushes?: number | undefined;
  readonly net: string;
  readonly net_display?: string | undefined;
  readonly total?: number | undefined;
  readonly last_result?: 'win' | 'loss' | 'push' | null | undefined;
  readonly streak?: { readonly holder: 'me' | 'them'; readonly length: number } | null | undefined;
  readonly rival?: boolean | undefined;
}

export function statsOf(h: HeadToHeadLike): RivalryStats {
  const pushes = h.pushes ?? 0;
  const total = h.total ?? h.wins + h.losses + pushes;
  return {
    wins: h.wins,
    losses: h.losses,
    pushes,
    net: h.net,
    netDisplay: h.net_display ?? signedUsd(h.net),
    total,
    streak: h.streak && h.streak.length >= 1 ? { ...h.streak } : null,
    rival: h.rival ?? total >= RIVAL_MIN_SETTLED,
    lastResult: h.last_result ?? null,
  };
}

/** "4-7", or "4-7-1" with pushes. */
export const recordText = (s: Pick<RivalryStats, 'wins' | 'losses' | 'pushes'>): string =>
  s.pushes > 0 ? `${s.wins}-${s.losses}-${s.pushes}` : `${s.wins}-${s.losses}`;

/** "Won 3 straight" / "Lost 2 straight" for a run of 2 or more; null otherwise. */
export const streakLabel = (s: Pick<RivalryStats, 'streak'>): string | null =>
  s.streak && s.streak.length >= 2 ? rivalryFill.streak(s.streak.holder, s.streak.length) : null;
