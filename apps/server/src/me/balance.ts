// A user's USDC balance (RPC) and what is theirs in escrow (Postgres): the body of
// GET /v1/me/balance (./routes.ts), and the odds soft-check (odds/service.ts: can the side that
// puts in more cover it?). The lock preflight stays the hard check.
import { and, eq, gte, lt, or, sql } from 'drizzle-orm';
import { address } from '@solana/kit';
import { bets, users } from '@youre-on/db';
import type { AppDeps } from '../context';
import { lifecycleOf } from '../lock/runtime';

export type WalletBalance =
  | { ok: true; wallet: string; usdc: bigint; in_escrow: bigint }
  | { ok: false; reason: 'no_wallet' | 'rpc_unavailable' };

/** My stake in every bet between LOCKED and APPEAL_RESOLVED (deposited, not yet paid out). */
export async function inEscrowMicro(db: AppDeps['db'], userId: string): Promise<bigint> {
  const [esc] = await db
    .select({
      micro: sql<string>`coalesce(sum(CASE WHEN ${bets.party_a_id} = ${userId}
        THEN ${bets.stake_a} ELSE ${bets.stake_b} END), 0)::text`,
    })
    .from(bets)
    .where(
      and(
        or(eq(bets.party_a_id, userId), eq(bets.party_b_id, userId)),
        gte(bets.state, 'LOCKED'),
        lt(bets.state, 'PAID'),
        eq(bets.is_seed, false),
      ),
    );
  return BigInt(esc?.micro ?? '0');
}

export async function walletBalance(deps: AppDeps, userId: string): Promise<WalletBalance> {
  const [u] = await deps.db
    .select({ wallet: users.wallet_pubkey })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.wallet) return { ok: false, reason: 'no_wallet' };
  const rt = await lifecycleOf(deps).runtime();
  if (!rt) return { ok: false, reason: 'rpc_unavailable' };
  let usdc: bigint;
  try {
    usdc = await rt.client.tokenBalanceByOwner(address(u.wallet), rt.mint);
  } catch (err) {
    deps.log.warn('balance.rpc_failed', { err });
    return { ok: false, reason: 'rpc_unavailable' };
  }
  return { ok: true, wallet: u.wallet, usdc, in_escrow: await inEscrowMicro(deps.db, userId) };
}

/**
 * What the user can still put in: the wallet's USDC. (USDC already in escrow has left the wallet,
 * so it is not subtracted again.) null when unknown (no wallet, RPC down): the caller skips.
 */
export async function spendableMicro(deps: AppDeps, userId: string): Promise<bigint | null> {
  const b = await walletBalance(deps, userId);
  return b.ok ? b.usdc : null;
}
