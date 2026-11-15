/**
 * World Mode routes (§11, §12.3) — owned by booth-world-events:
 *   GET  /world/events ?q=&limit=      {events: WorldEvent[]}
 *   GET  /world/events/:id             WorldEvent
 *   POST /world/quote                  §11.2/§11.3 split (QuoteView)
 *   POST /world/bets                   {bet: BetView, sign} (create_bet; QUOTE_EXPIRED)
 *   POST /world/bets/:id/hedge         §11.6 {order_id, status}
 * Live prices: WS topic `world:<event_id>` (snapshot + relay, world/prices.ts).
 * Resolution oracle: keeper task "world" (world/service.ts).
 */
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { createQuote, quoteView } from '../world/quotes.js';
import { WorldService } from '../world/service.js';
import { isPubkey } from '../util/bytes.js';
import { boothService } from './replayBooth.js';
import { eventLog } from './receipt.js';
import { bodyObject, currentUser, param, reqString, type RouteModule } from './util.js';

const MAX_LIMIT = 100;
const services = new WeakMap<AppContext, WorldService>();

export function worldService(ctx: AppContext): WorldService {
  let s = services.get(ctx);
  if (!s) {
    s = new WorldService(ctx);
    s.boothStatusOf = (bet) => boothService(ctx).get(bet)?.status ?? null;
    s.settlementOf = (bet) => {
      const ev = eventLog(ctx)
        .of(bet)
        .filter((e) => e.name === 'Settled' || e.name === 'Refunded')
        .at(-1);
      if (!ev) return null;
      const raw = ev.data['payouts'] ?? ev.data['amounts'];
      return { signature: ev.signature, amounts: Array.isArray(raw) ? raw.map((x) => Number(x)) : [] };
    };
    services.set(ctx, s);
  }
  return s;
}

export const worldRoutes: RouteModule = (app, ctx) => {
  const world = worldService(ctx);
  world.register();
  app.addHook('onClose', async () => world.prices.stopAll());

  app.get('/v1/world/events', async (req) => {
    const q = req.query as { q?: string; limit?: string };
    const n = q.limit === undefined ? 20 : Number(q.limit);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : 20;
    return { events: await ctx.providers.gemini.listEvents(typeof q.q === 'string' ? q.q : null, limit) };
  });

  app.get('/v1/world/events/:id', async (req) => {
    const ev = await ctx.providers.gemini.getEvent(param(req, 'id'));
    if (!ev) throw new ApiError('NOT_FOUND');
    return ev;
  });

  app.post('/v1/world/quote', async (req) => {
    const user = currentUser(ctx, req);
    const q = await createQuote(ctx, user.id, bodyObject(req));
    for (const l of q.legs) world.prices.want(l.event_id);
    return quoteView(q);
  });

  app.post('/v1/world/bets', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return world.createBet(user, reqString(b, 'quote_id', 64), reqString(b, 'counterparty_user_id', 128));
  });

  app.post('/v1/world/bets/:id/hedge', async (req) => {
    const user = currentUser(ctx, req);
    const id = param(req, 'id');
    if (!isPubkey(id)) throw new ApiError('NOT_FOUND');
    return world.hedge(user, id, bodyObject(req));
  });
};
