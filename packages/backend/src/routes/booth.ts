/**
 * Ruling screen routes (§12.3, §12.10):
 *   GET /bets/:id/ruling        {outcome_text, preruling, readback, legs, amount_units, can_respond, bond_units}
 *   GET /bets/:id/announce.mp3  TTS of the verdict ("{Names} win{s} $x" / "No contest")
 * The booth record and exhibits are in replayBooth.ts.
 */
import { betsService } from '../bets/service.js';
import { currentUser, param, type RouteModule } from './util.js';

export const boothRoutes: RouteModule = (app, ctx) => {
  const bets = betsService(ctx);

  app.get('/v1/bets/:id/ruling', async (req) => {
    const user = currentUser(ctx, req);
    return bets.ruling(user, param(req, 'id'));
  });

  app.get('/v1/bets/:id/announce.mp3', async (req, reply) => {
    const user = currentUser(ctx, req);
    const a = await bets.announce(user, param(req, 'id'));
    return reply.header('content-type', a.mime).header('cache-control', 'private, max-age=60').send(Buffer.from(a.bytes));
  });
};
