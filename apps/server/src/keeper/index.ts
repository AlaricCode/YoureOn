// The server's keeper and its registered sweeps. server.ts createDeps builds it (unless
// disabled) and startServer starts / stops it with the HTTP server. Later sweeps (lock-window
// expiry with the nonce advance, `timeout_refund`, the nonce-pool sweep, the outbox drain)
// register here.
import type { AppDeps } from '../context';
import { rpcPollFallbackMs, StreamGapReconciler } from '../chain/reconciler';
import { lifecycleOf } from '../lock/runtime';
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
 */
export function chainLifecycleTasks(deps: SweepDeps & Pick<AppDeps, 'env'>): KeeperTask[] {
  return [
    { name: 'lock-sweep', run: (now) => lifecycleOf(deps).lock.sweep(now) },
    { name: 'finalize-due', run: (now) => lifecycleOf(deps).payout.finalizeDue(now) },
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
  keeper.register(draftIdleTask(deps));
  const env = deps.env;
  if (env) {
    for (const t of chainLifecycleTasks({ ...deps, env })) keeper.register(t);
    // resolve-due reads deps.onRuling at run time (server.ts sets it on this same object).
    keeper.register(resolveDueTask(deps));
    keeper.register(streamGapsTask({ ...deps, env }));
  }
  return keeper;
}
