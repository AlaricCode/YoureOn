// The server's keeper and its registered sweeps. server.ts createDeps builds it (unless
// disabled) and startServer starts / stops it with the HTTP server. Later sweeps (lock-window
// expiry with the nonce advance, `timeout_refund`, the nonce-pool sweep, the outbox drain)
// register here.
import type { AppDeps } from '../context';
import { rpcPollFallbackMs, StreamGapReconciler } from '../chain/reconciler';
import { lifecycleOf } from '../lock/runtime';
import { HEALTH_LOG_MS, logChainHealth } from '../chain/health';
import { bootReconcile } from '../chain/reconcile';
import { ORPHAN_SWEEP_MS, REFUND_SWEEP_MS } from '../payout/refund';
import { settlementTask } from '../markets/settlement';
import { resolveDueTask } from '../payout/resolve-due';
import { draftIdleTask, type SweepDeps } from './draft-idle';
import { Keeper, type KeeperOptions, type KeeperTask } from './keeper';

export { Keeper, KEEPER_INTERVAL_MS, KEEPER_JITTER_MS, type KeeperTask } from './keeper';
export {
  DRAFT_IDLE_MS,
  DRAFT_IDLE_STATES,
  draftIdleCue,
  draftIdleTask,
  expireIdleDrafts,
  type DraftIdleOptions,
  type DraftIdleResult,
} from './draft-idle';

/**
 * Chain lifecycle sweeps (src/lock, src/payout); both no-op while the chain is not configured.
 *  - lock-sweep: lock windows past expires_at -> EXPIRED + nonce revoke; sent locks re-checked;
 *    nonce advances finished / retried (DATA-MODEL §5.20 "Boot reconcile and sweep").
 *  - finalize-due: RULED bets past appeal_deadline + 1 s -> [finalize, close_bet] (the durable
 *    backstop of the PayoutService setTimeout fast path).
 *  - timeout-refund (every 15 s): bets Locked past resolve_deadline / Appealed past
 *    appeal_resolve_deadline -> [timeout_refund, close_bet] -> EXPIRED (src/payout/refund.ts).
 *  - orphan-escrow (every 60 s): our Bets that no live bets row owns (deleted by demo reset,
 *    or terminal offchain) get their exit once due, so escrowed money never strands.
 */
export function chainLifecycleTasks(deps: SweepDeps & Pick<AppDeps, 'env'>): KeeperTask[] {
  return [
    { name: 'lock-sweep', run: (now) => lifecycleOf(deps).lock.sweep(now) },
    { name: 'finalize-due', run: (now) => lifecycleOf(deps).payout.finalizeDue(now) },
    {
      name: 'timeout-refund',
      everyMs: REFUND_SWEEP_MS,
      run: (now) => lifecycleOf(deps).refund.sweep(now),
    },
    {
      name: 'orphan-escrow',
      everyMs: ORPHAN_SWEEP_MS,
      run: (now) => lifecycleOf(deps).refund.sweepOrphans(now),
    },
  ];
}

/**
 * stream-gaps: server txs with no Stream event after rpcPollFallbackMs(env) (30 s with a Stream
 * configured, else 5 s) -> getTransaction -> chain_events (source rpc_poll) -> projector
 * (src/chain/reconciler.ts, DATA-MODEL §8.3). The only best-effort RPC poller: registered after
 * the money sweeps, so a throttled RPC delays nothing behind it (its pass is also time-boxed).
 */
export function streamGapsTask(deps: SweepDeps & Pick<AppDeps, 'env'>): KeeperTask {
  const gaps = new StreamGapReconciler({ fallbackMs: rpcPollFallbackMs(deps.env) });
  return {
    name: 'stream-gaps',
    run: async (now) => gaps.run(deps, await lifecycleOf(deps).runtime(), now),
  };
}

export function createServerKeeper(
  deps: SweepDeps & Pick<AppDeps, 'now' | 'log'> & Partial<Pick<AppDeps, 'env' | 'onRuling'>>,
  opts: Omit<KeeperOptions, 'now' | 'log'> = {},
): Keeper {
  const keeper = new Keeper({ now: deps.now, log: deps.log, ...opts });
  if (!deps.env) {
    keeper.register(draftIdleTask(deps));
    return keeper;
  }
  // Always the SAME deps object, never a spread copy: lifecycleOf() keys the chain lifecycle by
  // object identity, and a copy got a second Lock/Payout/RefundService (own in-flight sets,
  // finalize timers, RPC client and stats) that the routes and /v1/demo/health never saw.
  // server.ts sets deps.keeper / deps.markets / deps.onRuling on this object after this returns.
  const chain = deps as typeof deps &
    Pick<AppDeps, 'env'> &
    Partial<Pick<AppDeps, 'keeper' | 'markets'>>;
  // The first pass after boot reconciles everything a restart can leave half-done (once).
  keeper.register({
    name: 'boot-reconcile',
    everyMs: Number.POSITIVE_INFINITY,
    timeoutMs: 120_000,
    run: (now) => bootReconcile(chain, now),
  });
  keeper.register(draftIdleTask(deps));
  for (const t of chainLifecycleTasks(chain)) keeper.register(t);
  // resolve-due reads deps.onRuling at run time (server.ts sets it on this same object).
  keeper.register(resolveDueTask(chain));
  keeper.register(settlementTask(chain));
  // The only best-effort RPC poller: after every money sweep, so a throttled RPC delays nothing.
  keeper.register(streamGapsTask(chain));
  // Every 10 min: one chain.unhealthy line when anything needs a human. Its first run (the boot
  // pass) is skipped: boot-reconcile already logged chain.boot_health.
  let booted = false;
  keeper.register({
    name: 'chain-health',
    everyMs: HEALTH_LOG_MS,
    run: async () => {
      if (!booted) return void (booted = true);
      await logChainHealth(chain);
    },
  });
  return keeper;
}
