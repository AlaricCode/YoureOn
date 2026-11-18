// GET /v1/ws (API-CONTRACT §3.1). The bearer token arrives in the first frame (`hello`), never
// in the URL. Requires the server to be started through startServer() (server.ts), which
// attaches the `ws` WebSocketServer to @hono/node-server.
//
// GET /v1/bets/:bet_id/events?after=<seq>&limit=200 (§2.14): the REST resync of the same log,
// through the hub's own access rules and replay (./resync.ts).
import { upgradeWebSocket } from '@hono/node-server';
import { WS_PATH } from '@youre-on/shared/api';
import type { RouteModule } from '../context';
import { HttpError } from '../errors';
import { requireSession } from '../auth/middleware';
import { stageCors } from '../stage/cors';
import { betEventsFor, parseBetEventsQuery, parseBetIdParam } from './resync';

export const realtimeRoutes: RouteModule = {
  name: 'realtime',
  register(app, deps) {
    app.get(
      WS_PATH,
      upgradeWebSocket(() => deps.hub.events()),
    );

    // The stage reads it too (cross-origin in development), like GET /v1/bets/:bet_id.
    app.use('/v1/bets/:bet_id/events', stageCors(deps.env));
    app.get('/v1/bets/:bet_id/events', requireSession, async (c) => {
      const betId = parseBetIdParam(c.req.param('bet_id'));
      const q = parseBetEventsQuery({ after: c.req.query('after'), limit: c.req.query('limit') });
      const page = await betEventsFor(deps, c.get('auth'), betId, q);
      // 404 for both "missing" and "not yours", so bet ids can't be probed.
      if (!page) throw new HttpError('NOT_FOUND', 'No such bet.');
      return c.json(page, 200);
    });
  },
};
