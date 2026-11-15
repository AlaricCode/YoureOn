/**
 * Bets routes (§12.3): create from an accepted draft, list, BetView,
 * practice and the leaderboard. Services live in src/bets/.
 *
 * Scene check, calibration, fund, witnesses, start, chunks, end, consent and
 * dispute are in lifecycle.ts; the receipt in receipt.ts; ruling and
 * announcer in booth.ts.
 */
import { betsService } from '../bets/service.js';
import { bodyObject, currentUser, param, reqString, type RouteModule } from './util.js';

export const betRoutes: RouteModule = (app, ctx) => {
  const bets = betsService(ctx);
  bets.register();

  app.post('/v1/bets', async (req) => {
    const user = currentUser(ctx, req);
    return bets.create(user, reqString(bodyObject(req), 'draft_id', 128));
  });

  app.get('/v1/bets', async (req) => {
    const user = currentUser(ctx, req);
    const q = req.query as { state?: unknown };
    return bets.list(user, typeof q.state === 'string' && q.state !== '' ? q.state : null);
  });

  app.get('/v1/bets/:id', async (req) => {
    const user = currentUser(ctx, req);
    return bets.get(user, param(req, 'id'));
  });

  app.post('/v1/bets/:id/practice', async (req) => {
    const user = currentUser(ctx, req);
    return bets.practice(user, param(req, 'id'), bodyObject(req));
  });

  app.get('/v1/leaderboard', async (req) => {
    const user = currentUser(ctx, req);
    const q = req.query as { huddle_id?: unknown };
    return bets.leaderboard(user, typeof q.huddle_id === 'string' && q.huddle_id !== '' ? q.huddle_id : null);
  });
};
