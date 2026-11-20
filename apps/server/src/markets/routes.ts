// The Gemini market reads for the Bitcoin closer (current contract, quote preview), for any app
// or stage session, 60/min per caller. Served from the relay (deps.markets). The quote is a
// preview only: the binding one is taken when the terms are composed (markets/quote.ts).
// Spec: docs/planning/API-CONTRACT.md §2.13.
import { z } from 'zod/v4';
import { MicroUsdc } from '@youre-on/shared/money';
import type { RouteModule } from '../context';
import { HttpError, validationError } from '../errors';
import { requireSession } from '../auth/middleware';
import { stageCors } from '../stage/cors';
import type { MarketService } from './service';

export const MARKETS_BUCKET = { limit: 60, windowMs: 60_000 } as const;

export const QuoteQuery = z.object({
  amount: MicroUsdc,
  a_side: z.enum(['YES', 'NO']),
});

function relay(markets: MarketService | undefined): MarketService {
  if (!markets)
    throw new HttpError('MARKET_UNAVAILABLE', 'The market feed is off.', {
      reason: 'MARKET_NOT_OPEN',
    });
  return markets;
}

export const marketsRoutes: RouteModule = {
  name: 'markets',
  register(app, deps) {
    app.use('/v1/markets/*', stageCors(deps.env));

    app.get('/v1/markets/btc5m/current', requireSession, (c) => {
      const auth = c.get('auth');
      deps.rateLimit?.take('markets', auth.user_id ?? auth.session_id, MARKETS_BUCKET);
      return c.json(relay(deps.markets).current(deps.now()), 200);
    });

    app.get('/v1/markets/btc5m/quote', requireSession, async (c) => {
      const auth = c.get('auth');
      deps.rateLimit?.take('markets', auth.user_id ?? auth.session_id, MARKETS_BUCKET);
      const q = QuoteQuery.safeParse({
        amount: c.req.query('amount'),
        a_side: c.req.query('a_side'),
      });
      if (!q.success) throw validationError(q.error);
      const { result, snapshot } = await relay(deps.markets).quote(q.data.amount, q.data.a_side);
      if (!result.ok)
        throw new HttpError('MARKET_UNAVAILABLE', marketMessage(result.reason), {
          reason: result.reason,
        });
      return c.json({ result, snapshot }, 200);
    });
  },
};

const MESSAGES: Record<string, string> = {
  MARKET_NOT_OPEN: 'No Bitcoin 5-minute market is open right now.',
  QUOTE_STALE: "Gemini's quote is stale. Try again in a moment.",
  TOO_CLOSE_TO_EXPIRY: 'Too late for this round. The next one opens soon.',
  STRIKE_PENDING: "Gemini hasn't set the line yet.",
  NO_TWO_SIDED_QUOTE: 'Gemini has no two-sided quote yet.',
  SPREAD_TOO_WIDE: "Gemini's spread is too wide to price fairly.",
  PRICE_OUT_OF_RANGE: 'The market is too lopsided for a fair bet.',
  STAKE_ABOVE_MAX: 'That stake is above the limit.',
  STAKE_BELOW_MIN: 'That stake is below the minimum.',
};
export const marketMessage = (reason: string) => MESSAGES[reason] ?? 'The market is unavailable.';
