// Fetches a bet's slow-mo replay (GET /v1/bets/:bet_id/replay) for the payout screen. On mount
// (when enabled) and on refresh(); a newer call wins over a slower older one. A failed fetch keeps
// the button hidden (no dead button) and is retried by the next refresh(). The hide/show rule is
// model.replayViewOf, tested in node.
import type { ReplayMoment, ReplayWhy } from '@youre-on/shared/replay';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getReplay } from '../net/replay';
import type { ApiClient } from '../net/signedFetch';
import { EMPTY_REPLAY_VIEW, replayViewOf, type ReplayView } from './model';

export interface UseReplay {
  /** Set iff there is something to play: render ReplayButton / SlowMoPlayer with it. */
  moment: ReplayMoment | null;
  why: ReplayWhy | null;
  final: boolean;
  /** Fetch again (e.g. on the payout landing, or when the player opens). */
  refresh: () => void;
}

export function useReplay(
  api: Pick<ApiClient, 'request'> | null,
  betId: string | null,
  enabled = true,
): UseReplay {
  const [view, setView] = useState<ReplayView>(EMPTY_REPLAY_VIEW);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    if (!api || !betId || !enabled) return;
    const mine = ++seq.current;
    getReplay(api, betId).then(
      (res) => {
        if (mine === seq.current) setView(replayViewOf(res, Date.now()));
      },
      () => {
        if (mine === seq.current) setView(EMPTY_REPLAY_VIEW);
      },
    );
  }, [api, betId, enabled]);

  useEffect(() => {
    setView(EMPTY_REPLAY_VIEW);
    refresh();
    return () => {
      seq.current++;
    };
  }, [refresh]);

  return { ...view, refresh };
}
