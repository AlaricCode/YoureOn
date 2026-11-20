// Atomic-lock authorization (API-CONTRACT §2.8):
//   GET  /v1/bets/:bet_id/lock                  (B+P)  -> 200 AuthorizeRequest (recovery after a reconnect)
//   POST /v1/bets/:bet_id/lock/authorizations   (S+P)  -> 202 AuthorizationResult
//   POST /v1/bets/:bet_id/lock/decline          (S+P)  -> 200 {ok: true}
import { z } from 'zod/v4';
import { PartyAuthorization, PartyDecline } from '@youre-on/shared/authorization';
import { Uuid } from '@youre-on/shared/primitives';
import type { RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireAppSession, requireSignedRequest } from '../auth/middleware';
import { lifecycleOf } from './runtime';

export function betIdParam(raw: string): string {
  if (!Uuid.safeParse(raw).success) throw new HttpError('NOT_FOUND', 'No such bet.');
  return raw;
}

/** PartyAuthorization + the optional `client_metrics` sibling (logged only). */
const AuthorizationBody = PartyAuthorization.extend({
  client_metrics: z
    .object({
      hold_started_at: z.string().optional(),
      faceid_ms: z.number().optional(),
      sign_ms: z.number().optional(),
    })
    .optional(),
});

export const lockRoutes: RouteModule = {
  name: 'lock',
  register(app) {
    app.get('/v1/bets/:bet_id/lock', requireAppSession, async (c) => {
      const me = appAuth(c);
      const req = await lifecycleOf(c.get('deps')).lock.getLock(
        betIdParam(c.req.param('bet_id')),
        me.user_id,
      );
      return c.json(req, 200);
    });

    app.post('/v1/bets/:bet_id/lock/authorizations', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const me = appAuth(c);
      const betId = betIdParam(c.req.param('bet_id'));
      const { client_metrics, ...body } = await readBody(c, AuthorizationBody);
      if (client_metrics)
        deps.log.info('lock.client_metrics', {
          bet_id: betId,
          party: body.party,
          ...client_metrics,
        });
      const res = await lifecycleOf(deps).lock.authorize(
        betId,
        me.user_id,
        body,
        c.get('requestId'),
      );
      return c.json(res, 202);
    });

    app.post('/v1/bets/:bet_id/lock/decline', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const me = appAuth(c);
      const betId = betIdParam(c.req.param('bet_id'));
      const body = await readBody(c, PartyDecline);
      if (body.bet_id !== betId)
        throw new HttpError('VALIDATION_FAILED', undefined, {
          issues: [{ path: 'bet_id', message: 'must equal the path bet_id' }],
        });
      await lifecycleOf(deps).lock.decline(betId, me.user_id, body, c.get('requestId'));
      return c.json({ ok: true }, 200);
    });
  },
};
