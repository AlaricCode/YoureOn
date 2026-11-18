// GET /v1/me/bets (B) — API-CONTRACT §2.14: see ./bets.ts.
// GET /v1/me/balance (B) — API-CONTRACT §2.14:
//   {wallet_pubkey, usdc, usdc_display, in_escrow, in_escrow_display, as_of, source: 'rpc'}
// `usdc` = the sum of getTokenAccountsByOwner(mint) (payouts may land in a fallback account,
// ESCROW §5.2). `in_escrow` = my stake in every bet between LOCKED and APPEAL_RESOLVED (deposited,
// not yet paid out), from Postgres. Cached 2 s per user. The phone already renders this shape
// (apps/mobile/src/preview/data.ts BALANCE).
// GET /v1/users/:user_id/head-to-head (B, a phone session) — API-CONTRACT §2.14: the caller's
// record against that user (HeadToHead, DATA-MODEL §7.1 with the caller as user_a: settled bets
// plus labelled is_seed history), the same face/service.ts headToHead the face-match reply
// carries. Only ever the caller's own record. 404 for a malformed or unknown user id; no row = 0-0-0.
import { eq } from 'drizzle-orm';
import { users } from '@youre-on/db';
import { formatUsd } from '@youre-on/shared/money';
import { Uuid } from '@youre-on/shared/primitives';
import type { RouteModule } from '../context';
import { HttpError } from '../errors';
import { appAuth, requireAppSession } from '../auth/middleware';
import { headToHead } from '../face/service';
import { walletBalance } from './balance';
import { listMyBets, parseMeBetsQuery } from './bets';

export const BALANCE_CACHE_MS = 2_000;

export interface BalanceResponse {
  wallet_pubkey: string;
  usdc: string;
  usdc_display: string;
  in_escrow: string;
  in_escrow_display: string;
  as_of: string;
  source: 'rpc';
}

export function createMeRoutes(): RouteModule {
  const cache = new Map<string, { at: number; body: BalanceResponse }>();
  return {
    name: 'me',
    register(app) {
      app.get('/v1/me/bets', requireAppSession, async (c) => {
        const q = parseMeBetsQuery({
          status: c.req.query('status'),
          limit: c.req.query('limit'),
          cursor: c.req.query('cursor'),
        });
        const me = appAuth(c);
        return c.json(await listMyBets(c.get('deps'), me, q), 200);
      });

      app.get('/v1/users/:user_id/head-to-head', requireAppSession, async (c) => {
        const deps = c.get('deps');
        const me = appAuth(c);
        const them = c.req.param('user_id');
        if (!Uuid.safeParse(them).success) throw new HttpError('NOT_FOUND', 'No such user.');
        const [u] = await deps.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, them))
          .limit(1);
        if (!u) throw new HttpError('NOT_FOUND', 'No such user.');
        c.header('Cache-Control', 'private, no-store');
        return c.json(await headToHead(deps.db, me.user_id, u.id), 200);
      });

      app.get('/v1/me/balance', requireAppSession, async (c) => {
        const deps = c.get('deps');
        const me = appAuth(c);
        const now = deps.now();
        const hit = cache.get(me.user_id);
        if (hit && now - hit.at < BALANCE_CACHE_MS) return c.json(hit.body, 200);

        const b = await walletBalance(deps, me.user_id);
        if (!b.ok && b.reason === 'no_wallet')
          throw new HttpError('INVALID_STATE', 'No wallet yet.', { reason: 'no_wallet' });
        if (!b.ok) throw new HttpError('RPC_UNAVAILABLE', 'Balances are unavailable right now.');
        const usdc = b.usdc;
        const inEscrow = b.in_escrow.toString();
        const body: BalanceResponse = {
          wallet_pubkey: b.wallet,
          usdc: usdc.toString(),
          usdc_display: formatUsd(usdc.toString()),
          in_escrow: inEscrow,
          in_escrow_display: formatUsd(inEscrow),
          as_of: new Date(now).toISOString(),
          source: 'rpc',
        };
        cache.set(me.user_id, { at: now, body });
        if (cache.size > 5_000) cache.clear();
        return c.json(body, 200);
      });
    },
  };
}

export const meRoutes: RouteModule = createMeRoutes();
