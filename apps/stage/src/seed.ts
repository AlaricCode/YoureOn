// Loading a bet the page was told about (?bet=, or a reloaded tab's remembered bets) rather than
// one it saw in the room. The snapshot comes first and the socket subscription only after it
// loads: the hub closes the whole socket with 4403 for a bet the stage may not see (a typo, or a
// bet a demo reset deleted), which would throw the projector back to the connect form. A bet that
// does not load is let go (unfocus); a network failure is retried a few times first.
import type { BetSnapshot } from '@youre-on/shared/api';
import type { TickerAction } from './ticker';

/** Waits before each retry of a snapshot that failed for another reason than 404. */
export const SEED_RETRY_MS = [2_000, 5_000, 10_000] as const;

export interface SeedDeps {
  fetchSnapshot: (betId: string) => Promise<BetSnapshot>;
  dispatch: (a: TickerAction) => void;
  /** Subscribe from seq 0 (replays the bet's history; duplicates are dropped by seq). */
  subscribe: (betId: string) => void;
  /** False once the page moved to another connection: late answers are dropped. */
  current: () => boolean;
  /** Called when the bet could not be loaded (the App may seed it again if the room shows it). */
  failed?: (betId: string) => void;
  setTimer?: (fn: () => void, ms: number) => void;
}

const isNotFound = (err: unknown) => /HTTP 404\b/.test(String(err));

/** `quiet`: a remembered bet that is gone is not an error worth showing on the projector. */
export function seedBet(
  betId: string,
  d: SeedDeps,
  opts: { quiet?: boolean; attempt?: number } = {},
): Promise<void> {
  const attempt = opts.attempt ?? 0;
  return d.fetchSnapshot(betId).then(
    (bet) => {
      if (!d.current()) return;
      d.dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() });
      d.subscribe(betId);
    },
    (err: unknown) => {
      if (!d.current()) return;
      const retry = SEED_RETRY_MS[attempt];
      if (!isNotFound(err) && retry !== undefined) {
        const again = () => {
          if (d.current()) void seedBet(betId, d, { ...opts, attempt: attempt + 1 });
        };
        (d.setTimer ?? ((fn, ms) => void setTimeout(fn, ms)))(again, retry);
        return;
      }
      d.dispatch({ kind: 'unfocus', bet_id: betId });
      if (!opts.quiet)
        d.dispatch({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      d.failed?.(betId);
    },
  );
}
