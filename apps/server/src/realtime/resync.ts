// REST resync: GET /v1/bets/:bet_id/events?after=<seq>&limit=200 -> {events, last_seq} from
// bet_events. A phone calls it when a seq gap stays open 2 s, after a reconnect, and on cold start
// to rebuild a bet from its log (B's invite answer, the lock request, authorizations...).
// Spec: docs/planning/API-CONTRACT.md §2.14.
//
// It reads through the WS hub's own HubAccess (hub.access): the same canSeeBet as `subscribe`
// and the same replay query, so a session sees here exactly the envelopes, verbatim, that
// subscribing with after_seq would send it; there is no second copy of the rules. Neither path
// filters or redacts per recipient: the bet channel carries every event of the bet to everyone
// who may see it, and the envelopes hold no secrets.
//
// An envelope that fails the shared RealtimeEvent schema is left out with a log line: every client
// drops it anyway, and failing the whole page would strand the bet on its snapshot.
import { BET_EVENTS_LIMIT } from '@youre-on/shared/api';
import { BetId } from '@youre-on/shared/primitives';
import { BetEventsResponse, RealtimeEvent } from '@youre-on/shared/realtime';
import type { AppDeps, AuthContext } from '../context';
import { HttpError, validationError } from '../errors';

/** bet_events.seq is a Postgres integer. */
const MAX_SEQ = 2_147_483_647;

export interface BetEventsQuery {
  after: number;
  limit: number;
}

function invalid(path: string, message: string): HttpError {
  return new HttpError('VALIDATION_FAILED', undefined, { issues: [{ path, message }] });
}

/** `after` defaults to 0 (the whole log), `limit` to the contract's 200 (also its cap). */
export function parseBetEventsQuery(q: { after?: string; limit?: string }): BetEventsQuery {
  let after = 0;
  if (q.after !== undefined) {
    after = /^\d{1,10}$/.test(q.after) ? Number(q.after) : NaN;
    if (!(after >= 0 && after <= MAX_SEQ)) throw invalid('after', 'a seq: an integer >= 0');
  }
  let limit = BET_EVENTS_LIMIT;
  if (q.limit !== undefined) {
    limit = /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!(limit >= 1 && limit <= BET_EVENTS_LIMIT))
      throw invalid('limit', `an integer 1..${BET_EVENTS_LIMIT}`);
  }
  return { after, limit };
}

/** The page for one session: null when it may not see the bet (or there is no such bet). */
export async function betEventsFor(
  deps: Pick<AppDeps, 'hub' | 'log'>,
  auth: AuthContext,
  betId: string,
  q: BetEventsQuery,
): Promise<BetEventsResponse | null> {
  const access = deps.hub.access;
  if (!(await access.canSeeBet(auth, betId))) return null;
  const r = await access.replay(betId, q.after, q.limit);
  const events = r.events.filter((env) => {
    const ok = RealtimeEvent.safeParse(env).success;
    if (!ok) deps.log.warn('bet_events.invalid_envelope', { bet_id: betId, seq: env.seq });
    return ok;
  });
  // Verbatim rows (not the parsed copies): what the socket replay sends, byte for byte.
  return { events: events as unknown as BetEventsResponse['events'], last_seq: r.last_seq };
}

export function parseBetIdParam(raw: string): string {
  const id = BetId.safeParse(raw);
  if (!id.success) throw validationError(id.error);
  return id.data;
}
