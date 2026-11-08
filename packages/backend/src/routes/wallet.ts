/**
 * §12.3 wallet routes (implemented):
 *   GET  /balance → {usdc_units}
 *   POST /faucet  → {usdc_units}   demo drip of FAUCET_UNITS, idempotent per UTC day
 */
import { FAUCET_UNITS } from '@verdict/engine';
import { ApiError } from '../errors.js';
import { COLLECTIONS, type FaucetRecord } from '../persistence/records.js';
import { currentUser, type RouteModule } from './util.js';

const DAY_MS = 86_400_000;

export const walletRoutes: RouteModule = (app, ctx) => {
  const faucet = ctx.store.collection<FaucetRecord>(COLLECTIONS.faucet);

  app.get('/v1/balance', async (req) => {
    const user = currentUser(ctx, req);
    return { usdc_units: Number(await ctx.chain.getUsdcBalance(user.wallet)) };
  });

  app.post('/v1/faucet', async (req) => {
    const user = currentUser(ctx, req);
    const now = ctx.clock.nowMs();
    const id = `${user.id}:${Math.floor(now / DAY_MS)}`;
    if (!faucet.has(id)) {
      // Reserve first so concurrent calls cannot double-drip.
      faucet.set(id, { id, user_id: user.id, amount_units: FAUCET_UNITS, signature: null, at_ms: now });
      const r = await ctx.chain.faucet(user.wallet, BigInt(FAUCET_UNITS));
      if (r.status !== 'confirmed') {
        faucet.delete(id);
        throw new ApiError(r.code, r.error);
      }
      faucet.update(id, (f) => ({ ...f, signature: r.signature }));
    }
    return { usdc_units: Number(await ctx.chain.getUsdcBalance(user.wallet)) };
  });
};
