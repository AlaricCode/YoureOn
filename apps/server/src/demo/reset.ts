// POST /v1/demo/reset: back to a clean demo pair between rehearsals, without stranding a cent.
// The escrow of every non-seed bet comes back (a decisive ruling stands: its winner is paid), the
// non-seed bets are deleted, which frees pair_busy and the 3-open-bets cap, and the nonce pool is
// re-synced from chain. Users, devices, api_sessions (the phones stay signed in), rooms,
// face_enrollments and seed bets are untouched. The keeper pauses meanwhile, so no sweep races
// the deletes. `{rebalance: true}` then evens out the demo wallets, right away or once the
// escrow is back.
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import { auditLog, bets, noncePool } from '@youre-on/db';
import { BetStatus, findBetPda } from '@youre-on/shared/escrow-client';
import { betIdToBytes } from '@youre-on/shared/primitives';
import type { AppDeps } from '../context';
import { listOurBets, type LiveBet } from '../chain/exits';
import { readBetAccount } from '../lock/common';
import { lifecycleOf } from '../lock/runtime';
import { syncNoncePool } from '../lock/service';
import { FINALIZE_DELAY_MS } from '../payout/service';
import { rebalanceDemoWallets, type RebalanceResult } from './rebalance';

/** After the armed orphan sweep, how often (and how far apart) to re-sweep before rebalancing. */
const RESET_SETTLE_TRIES = 5;
const RESET_SETTLE_RETRY_MS = 2_000;

export const DemoResetRequest = z.object({
  /** Even out demo-a / demo-b after the reset (default false). */
  rebalance: z.boolean().optional(),
});

export interface ResetResult {
  deleted_bets: number;
  nonces_synced: number;
  nonces_revoked: number;
  escrow: {
    /** Live Bets of reset bets (and orphans) found on chain. */
    live: number;
    actions: Array<{ bet_id: string; action: string; signature: string }>;
    /** Still in escrow; the orphan sweep returns them (see settles_at). */
    pending: Array<{ bet_id: string; status: string }>;
    /** When the follow-up orphan sweep runs (ISO), or null. */
    settles_at: string | null;
    errors: string[];
  };
  rebalance: RebalanceResult | 'scheduled' | 'skipped_escrow_pending' | { error: string } | null;
}

/** The live Bets the reset must look after: ours, whose row is non-seed or gone. */
async function liveBetsToVoid(
  deps: Pick<AppDeps, 'db'>,
  rt: NonNullable<Awaited<ReturnType<ReturnType<typeof lifecycleOf>['runtime']>>>,
): Promise<LiveBet[]> {
  const seed = new Set(
    (
      await deps.db
        .select({ id: bets.id })
        .from(bets)
        .where(sql`${bets.is_seed}`)
    ).map((r) => r.id),
  );
  const listed = await listOurBets(rt);
  if (listed) return listed.filter((l) => !seed.has(l.betId));
  // No getProgramAccounts: read the PDA of every non-seed bet from AWAITING_LOCK on.
  const rows = await deps.db
    .select({ id: bets.id })
    .from(bets)
    .where(sql`NOT ${bets.is_seed} AND ${bets.state} >= 'AWAITING_LOCK'`);
  const out: LiveBet[] = [];
  for (const r of rows) {
    const bet = await readBetAccount(rt, r.id);
    if (!bet) continue;
    const [address] = await findBetPda({ betId: betIdToBytes(r.id) });
    out.push({ address, bet, betId: r.id });
  }
  return out;
}

export async function resetDemo(
  deps: AppDeps,
  o: { rebalance?: boolean; requestId?: string } = {},
): Promise<ResetResult> {
  const lc = lifecycleOf(deps);
  const keeperWasOn = deps.keeper?.isStarted ?? false;
  if (keeperWasOn) await deps.keeper!.stop();
  const result: ResetResult = {
    deleted_bets: 0,
    nonces_synced: 0,
    nonces_revoked: 0,
    escrow: { live: 0, actions: [], pending: [], settles_at: null, errors: [] },
    rebalance: null,
  };
  try {
    const rt = await lc.runtime();

    // 1. Revoke every leased nonce first (best effort): stored lock signatures become useless,
    //    and once these advances and every in-flight confirm settle, no lock can land anymore,
    //    so the escrow scan below sees every Bet there will ever be.
    if (rt) {
      const leased = await deps.db
        .select()
        .from(noncePool)
        .where(inArray(noncePool.status, ['leased']));
      for (const n of leased) {
        if (!n.leased_bet_id) continue;
        await lc.lock
          .revokeNonce(rt, n, n.leased_bet_id)
          .then(() => result.nonces_revoked++)
          .catch((err: unknown) =>
            deps.log.warn('demo.reset_revoke_failed', { seed_index: n.seed_index, err }),
          );
      }
    }
    await lc.idle();

    // 2. Escrow: every live Bet our fee payer created whose row is non-seed (or already gone)
    //    gets its money back (RefundService.voidForReset): a Locked one gets resolve(Refund) by
    //    the judge key, a due one its exit now, an Open one cancel_open_bet. A Resolved one is
    //    finalized by the orphan sweep after its appeal window (step 6, or the keeper's 60 s
    //    sweep); a decisive ruling stands.
    let settleAtMs: number | null = null;
    if (rt) {
      const live = await liveBetsToVoid(deps, rt).catch((err: unknown) => {
        result.escrow.errors.push(`list: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
        return [] as LiveBet[];
      });
      result.escrow.live = live.length;
      for (const l of live) {
        try {
          const done = await lc.refund.voidForReset(rt, l, deps.now());
          if (done)
            result.escrow.actions.push({
              bet_id: l.betId,
              action: done.action,
              signature: done.signature,
            });
          // A resolve(Refund) (or an untouched Resolved / Appealed Bet) still holds the money.
          const after =
            done?.action === 'resolve_refund' || !done ? await readBetAccount(rt, l.betId) : null;
          if (after) {
            result.escrow.pending.push({ bet_id: l.betId, status: BetStatus[after.status] });
            const at =
              after.status === BetStatus.Resolved
                ? Number(after.appealDeadline) * 1000 + FINALIZE_DELAY_MS + 1_000
                : null;
            if (at !== null) settleAtMs = Math.max(settleAtMs ?? 0, at);
          }
        } catch (err) {
          result.escrow.errors.push(
            `${l.betId}: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
          );
          deps.log.warn('demo.reset_void_failed', { bet_id: l.betId, err });
        }
      }
    }

    // 3. Drop the pool's references to bets / txs about to be deleted.
    await deps.db
      .update(noncePool)
      .set({
        status: 'retired',
        retired_at: new Date(deps.now()),
        leased_bet_id: null,
        leased_tx_id: null,
        leased_at: null,
        advance_tx_id: null,
      })
      .where(inArray(noncePool.status, ['leased', 'advancing']));

    // 4. Non-seed bets (chain_txs, bet_terms_versions, bet_events, voice_sessions, outbox cascade).
    const deleted = await deps.db
      .delete(bets)
      .where(sql`NOT ${bets.is_seed}`)
      .returning({ id: bets.id });
    result.deleted_bets = deleted.length;
    lc.payout.forget(deleted.map((d) => d.id));
    lc.review.forget(deleted.map((d) => d.id));

    // 5. Re-read the pool from chain: every account that is fine is free again.
    if (rt) {
      await deps.db
        .update(noncePool)
        .set({ status: 'free', retired_at: null, failures: 0 })
        .where(sql`${noncePool.status} = 'retired' AND ${noncePool.nonce_value} IS NOT NULL`);
      await deps.db.delete(noncePool).where(sql`${noncePool.status} = 'retired'`);
      result.nonces_synced = await syncNoncePool(deps, rt);
    }

    // 6. The follow-up orphan sweep, then the rebalance.
    const rebalance = async () => {
      if (!rt) return null;
      return rebalanceDemoWallets(deps, rt, {
        requestId: o.requestId,
        send: lc.sendOptions,
      }).catch((err: unknown) => ({
        error: String((err as Error)?.message ?? err).slice(0, 160),
      }));
    };
    // Rebalance only once the Resolved rehearsal bets are paid out (their Bet PDAs closed): the
    // devnet clock can trail ours (finalize then answers AppealWindowOpen), so re-sweep a few
    // times; if they are still in escrow after that, skip the rebalance rather than even the
    // wallets on pre-payout balances.
    const resolvedIds = result.escrow.pending
      .filter((p) => p.status === 'Resolved')
      .map((p) => p.bet_id);
    const settleThenRebalance = async () => {
      if (!rt) return;
      for (let i = 0; ; i++) {
        const open: string[] = [];
        for (const id of resolvedIds) if (await readBetAccount(rt, id)) open.push(id);
        if (!open.length) break;
        if (i >= RESET_SETTLE_TRIES) {
          deps.log.warn('demo.reset_rebalance_skipped', { reason: 'escrow_pending', bets: open });
          return;
        }
        await new Promise((r) => setTimeout(r, RESET_SETTLE_RETRY_MS));
        await lc.refund.sweepOrphans(deps.now());
      }
      deps.log.info('demo.reset_rebalanced', { r: await rebalance() });
    };
    if (settleAtMs !== null) {
      const armed = lc.refund.armOrphanSweep(
        settleAtMs,
        o.rebalance ? settleThenRebalance : undefined,
      );
      result.escrow.settles_at = armed ? new Date(settleAtMs).toISOString() : null;
      if (o.rebalance) result.rebalance = armed ? 'scheduled' : 'skipped_escrow_pending';
    } else if (o.rebalance) {
      result.rebalance = result.escrow.pending.length
        ? 'skipped_escrow_pending'
        : await rebalance();
    }

    await deps.db.insert(auditLog).values({
      actor_kind: 'system',
      action: 'demo.reset',
      request_id: o.requestId ?? null,
      details: {
        deleted_bets: result.deleted_bets,
        nonces_synced: result.nonces_synced,
        nonces_revoked: result.nonces_revoked,
        escrow_live: result.escrow.live,
        escrow_actions: result.escrow.actions.length,
        escrow_pending: result.escrow.pending.length,
      },
    });
    deps.log.info('demo.reset', {
      deleted_bets: result.deleted_bets,
      nonces_synced: result.nonces_synced,
      escrow_live: result.escrow.live,
      escrow_pending: result.escrow.pending.length,
    });
    return result;
  } finally {
    if (keeperWasOn) deps.keeper!.start();
  }
}
