// GG / concede (API-CONTRACT §2.10):
//   GET  /v1/bets/:bet_id/concede   (B, loser)  -> 200 SignRequest (kind 'concede')
//   POST /v1/bets/:bet_id/concede   (S, loser)  -> 202 {status: 'submitted', signature}
// POST takes SCHEMAS PartySignature. With LOCK_SIGNER=server (custodial demo) the signature
// fields may be omitted: the server signs as the loser's demo key.
import { PartySignature } from '@youre-on/shared/api';
import type { RouteModule } from '../context';
import { readBody } from '../http/body';
import { appAuth, requireAppSession, requireSignedRequest } from '../auth/middleware';
import { betIdParam } from '../lock/routes';
import { lifecycleOf } from '../lock/runtime';

export const payoutRoutes: RouteModule = {
  name: 'payout',
  register(app) {
    app.get('/v1/bets/:bet_id/concede', requireAppSession, async (c) => {
      const me = appAuth(c);
      const req = await lifecycleOf(c.get('deps')).payout.concedeRequest(
        betIdParam(c.req.param('bet_id')),
        me.user_id,
      );
      return c.json(req, 200);
    });

    app.post('/v1/bets/:bet_id/concede', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const me = appAuth(c);
      const betId = betIdParam(c.req.param('bet_id'));
      // Partial: the phones path still requires party_signature + message_sha256 (the service
      // answers SIGNATURE_INVALID / MESSAGE_MISMATCH); only the custodial signer may omit them.
      const body = await readBody(c, PartySignature.partial());
      const res = await lifecycleOf(deps).payout.concede(betId, me.user_id, body);
      return c.json(res, 202);
    });
  },
};
