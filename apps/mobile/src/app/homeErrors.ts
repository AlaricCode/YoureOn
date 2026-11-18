// What home shows when "New room", "Challenge" or turning on the judge cam fails (API-CONTRACT
// §2.3, §2.5, §2.15, §1.5). Before this, all three failures were swallowed and the button simply
// did nothing: the likeliest demo-day case is the server's cap of 3 open pre-lock bets per user
// (RATE_LIMITED too_many_open_bets), since A's "Back out" leaves a bet open until the 5-minute
// draft expiry.
// Pure TS: tested in node.
import { ApiClientError } from '../net/signedFetch';
import { COPY, t } from '../screens/copy';

export type HomeAction = 'create' | 'challenge' | 'judgeCam';

const FALLBACK = {
  create: COPY.home.createFailed,
  challenge: COPY.home.challengeFailed,
  judgeCam: COPY.home.judgeCamFailed,
} as const;

export function homeErrorLabel(action: HomeAction, e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'NETWORK') return t(COPY.app.offline);
    const reason = e.details?.reason;
    if (action === 'challenge') {
      if (reason === 'too_many_open_bets') return t(COPY.home.tooManyBets);
      if (reason === 'pair_busy') return t(COPY.home.pairBusy);
    }
    if (action !== 'create' && e.code === 'NOT_IN_ROOM') return t(COPY.home.notInRoom);
    if (e.code === 'RATE_LIMITED') return t(COPY.home.slowDown);
  }
  return t(FALLBACK[action]);
}

/** How long a home error stays up before it clears itself. */
export const HOME_NOTE_MS = 4_000;
