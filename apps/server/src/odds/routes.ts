// The odds routes: the phones' offer / accept / withdraw (./flow.ts) and the judge's suggestion
// (./suggest.ts), each a signed request from a party, plus the voice judge's suggest_odds webhook
// (./voice-tool.ts). The rules are R1–R8 in ./service.ts. The phone routes share one
// per-(bet, user) bucket (TYPED_TERMS_BUCKET, key 'odds').
// Spec: docs/planning/API-CONTRACT.md §2.19.
import type { Context } from 'hono';
import {
  OddsAcceptRequest,
  OddsOfferRequest,
  OddsSuggestRequest,
  type OddsSuggestResponse,
} from '@youre-on/shared/odds';
import { Uuid, type Party } from '@youre-on/shared/primitives';
import type { AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { partyOf, type BetRow } from '../bets/snapshot';
import { readBet } from '../lock/common';
import { betIdParam } from '../lock/routes';
import { TYPED_TERMS_BUCKET } from '../terms/routes';
import { acceptOdds, offerOdds, withdrawOdds } from './flow';
import { suggestOdds, SuggestCache } from './suggest';
import { suggestOddsHandler } from './voice-tool';

async function partyBet(c: Context<AppEnv>): Promise<{ bet: BetRow; me: Party }> {
  const deps = c.get('deps');
  const user = appAuth(c);
  const betId = betIdParam(c.req.param('bet_id') ?? '');
  deps.rateLimit?.take('odds', `${betId}:${user.user_id}`, TYPED_TERMS_BUCKET);
  const bet = await readBet(deps.db, betId);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  const me = partyOf(bet, user.user_id);
  if (!me) throw new HttpError('NOT_A_PARTY', "You're not in this bet.", { bet_id: betId });
  return { bet, me };
}

const offerIdParam = (raw: string | undefined): string => {
  if (!raw || !Uuid.safeParse(raw).success) throw new HttpError('NOT_FOUND', 'No such offer.');
  return raw;
};

export function createOddsRoutes(o: { cache?: SuggestCache } = {}): RouteModule {
  const cache = o.cache ?? new SuggestCache();
  return {
    name: 'odds',
    register(app) {
      app.post('/v1/bets/:bet_id/odds/offer', requireSignedRequest, async (c) => {
        const { bet, me } = await partyBet(c);
        const body = await readBody(c, OddsOfferRequest);
        return c.json(await offerOdds(c.get('deps'), bet, me, body), 200);
      });

      app.post('/v1/bets/:bet_id/odds/suggest', requireSignedRequest, async (c) => {
        const deps = c.get('deps');
        const { bet, me } = await partyBet(c);
        const body = await readBody(c, OddsSuggestRequest);
        if (bet.state === 'DRAFTING' && me !== 'A')
          throw new HttpError('NOT_A_PARTY', 'Only the challenger sets the terms.', {
            bet_id: bet.id,
          });
        const r = await suggestOdds(
          deps,
          bet,
          { ...body, requestedBy: me, via: 'button' },
          { cache, requestId: c.get('requestId') },
        );
        const res: OddsSuggestResponse = { offer: r.offer, say: r.say };
        return c.json(res, 200);
      });

      app.post('/v1/bets/:bet_id/odds/:offer_id/accept', requireSignedRequest, async (c) => {
        const { bet, me } = await partyBet(c);
        const offerId = offerIdParam(c.req.param('offer_id'));
        const body = await readBody(c, OddsAcceptRequest);
        return c.json(
          await acceptOdds(c.get('deps'), bet, me, offerId, body.n, {
            requestId: c.get('requestId'),
          }),
          200,
        );
      });

      app.post('/v1/bets/:bet_id/odds/:offer_id/withdraw', requireSignedRequest, async (c) => {
        const { bet, me } = await partyBet(c);
        const offerId = offerIdParam(c.req.param('offer_id'));
        return c.json(await withdrawOdds(c.get('deps'), bet, me, offerId), 200);
      });

      app.post('/el/tools/suggest_odds', suggestOddsHandler({ cache }));
    },
  };
}

export const oddsRoutes: RouteModule = createOddsRoutes();
