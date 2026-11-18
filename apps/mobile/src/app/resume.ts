// Back into an open bet after the app restarts (a crash, a swipe-away, a reinstall): before this
// a restarted phone came back to home and the bet was stranded until the server expired it
// (B's invite, A's terms; after the lock, the ruling, GG and payout screens). On sign-in the
// app asks GET /v1/me/bets?status=active, rebuilds each bet (BetHub.restore), follows it on the
// socket and opens the newest. Pure TS: tested in node.
import { BetSnapshot } from '@youre-on/shared/api';
import { isTerminalBetState } from '@youre-on/shared/bet-state';

/** Open bets to look for: a phone has at most a few (the server caps pre-lock bets at 3). */
export const RESUME_LIMIT = 5;

/**
 * The snapshots of the open bets in a GET /v1/me/bets page (each item is a whole BetSnapshot),
 * newest first as the server sends them. Items that do not parse, or are already over, are left
 * out.
 */
export function resumable(items: readonly unknown[]): BetSnapshot[] {
  return items.flatMap((raw) => {
    const p = BetSnapshot.safeParse(raw);
    return p.success && !isTerminalBetState(p.data.state) ? [p.data] : [];
  });
}
