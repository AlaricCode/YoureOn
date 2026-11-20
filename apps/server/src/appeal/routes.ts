// The appeal: the loser of a ruling asks the three-model panel to judge it again.
//   GET  /v1/bets/:bet_id/appeal   (B, loser)  -> 200 SignRequest (kind 'appeal')
//   POST /v1/bets/:bet_id/appeal   (S, loser)  -> 202 {status: 'submitted', signature, appeal_id}
// POST takes a PartySignature (kind 'appeal'). With LOCK_SIGNER=server (custodial demo) the
// signature fields may be omitted: the server signs as the appellant's demo key. The operator's
// custodial appeal is POST /v1/demo/bets/:bet_id/appeal (demo/routes.ts).
// Rate limit: 3/h per user, spent only by an accepted filing (every check passed, and the chain's
// preflight did not refuse it).
// Spec: docs/planning/API-CONTRACT.md §2.12.
import { PartySignature } from '@youre-on/shared/api';
import type { RouteModule } from '../context';
import { readBody } from '../http/body';
import { appAuth, requireAppSession, requireSignedRequest } from '../auth/middleware';
import { betIdParam } from '../lock/routes';
import { lifecycleOf } from '../lock/runtime';
import { APPEAL_BUCKET } from './service';

export const appealRoutes: RouteModule = {
  name: 'appeal',
  register(app) {
    app.get('/v1/bets/:bet_id/appeal', requireAppSession, async (c) => {
      const me = appAuth(c);
      const req = await lifecycleOf(c.get('deps')).appeal.appealRequest(
        betIdParam(c.req.param('bet_id')),
        me.user_id,
      );
      return c.json(req, 200);
    });

    app.post('/v1/bets/:bet_id/appeal', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const me = appAuth(c);
      const betId = betIdParam(c.req.param('bet_id'));
      // Partial, as for concede: the phones path still needs party_signature + message_sha256
      // (the service answers SIGNATURE_INVALID / MESSAGE_MISMATCH); only the custodial signer
      // may omit them.
      const body = await readBody(c, PartySignature.partial());
      const res = await lifecycleOf(deps).appeal.appeal(betId, me.user_id, body, {
        bucket: {
          take: () => deps.rateLimit?.take('appeal', me.user_id, APPEAL_BUCKET),
          refund: () => deps.rateLimit?.refund('appeal', me.user_id, APPEAL_BUCKET),
        },
        requestId: c.get('requestId'),
      });
      return c.json(res, 202);
    });
  },
};
