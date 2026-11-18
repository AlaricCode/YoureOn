// GET /v1/me/balance (B) — API-CONTRACT §2.14:
//   {wallet_pubkey, usdc, usdc_display, in_escrow, in_escrow_display, as_of, source: 'rpc'}
// `usdc` = the sum of getTokenAccountsByOwner(mint) (payouts may land in a fallback account,
// ESCROW §5.2). `in_escrow` = my stake in every bet between LOCKED and APPEAL_RESOLVED (deposited,
// not yet paid out), from Postgres. Cached 2 s per user. The phone already renders this shape
// (apps/mobile/src/preview/data.ts BALANCE).
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import { address } from '@solana/kit';
import { bets, users } from '@youre-on/db';
import { formatUsd } from '@youre-on/shared/money';
import type { RouteModule } from '../context';
import { HttpError } from '../errors';
import { appAuth, requireAppSession } from '../auth/middleware';
import { lifecycleOf } from '../lock/runtime';

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
      app.get('/v1/me/balance', requireAppSession, async (c) => {
        const deps = c.get('deps');
        const me = appAuth(c);
        const now = deps.now();
        const hit = cache.get(me.user_id);
        if (hit && now - hit.at < BALANCE_CACHE_MS) return c.json(hit.body, 200);

        const [u] = await deps.db
          .select({ wallet: users.wallet_pubkey })
          .from(users)
          .where(eq(users.id, me.user_id))
          .limit(1);
        if (!u?.wallet)
          throw new HttpError('INVALID_STATE', 'No wallet yet.', { reason: 'no_wallet' });
        const rt = await lifecycleOf(deps).runtime();
        if (!rt) throw new HttpError('RPC_UNAVAILABLE', 'Balances are unavailable right now.');

        let usdc: bigint;
        try {
          usdc = await rt.client.tokenBalanceByOwner(address(u.wallet), rt.mint);
        } catch (err) {
          deps.log.warn('balance.rpc_failed', { err });
          throw new HttpError('RPC_UNAVAILABLE', 'Balances are unavailable right now.');
        }
        const [esc] = await deps.db
          .select({
            micro: sql<string>`coalesce(sum(CASE WHEN ${bets.party_a_id} = ${me.user_id}
              THEN ${bets.stake_a} ELSE ${bets.stake_b} END), 0)::text`,
          })
          .from(bets)
          .where(
            and(
              or(eq(bets.party_a_id, me.user_id), eq(bets.party_b_id, me.user_id)),
              gte(bets.state, 'LOCKED'),
              lt(bets.state, 'PAID'),
              eq(bets.is_seed, false),
            ),
          );
        const inEscrow = esc?.micro ?? '0';
        const body: BalanceResponse = {
          wallet_pubkey: u.wallet,
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
