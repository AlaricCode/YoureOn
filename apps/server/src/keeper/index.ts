// The server's keeper and its registered sweeps. server.ts createDeps builds it (unless
// disabled) and startServer starts / stops it with the HTTP server. Later sweeps (lock-window
// expiry with the nonce advance, `timeout_refund`, the nonce-pool sweep, the outbox drain)
// register here.
import type { AppDeps } from '../context';
import { lifecycleOf } from '../lock/runtime';
import { ORPHAN_SWEEP_MS, REFUND_SWEEP_MS } from '../payout/refund';
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

export function createServerKeeper(
  deps: SweepDeps & Pick<AppDeps, 'now' | 'log'> & Partial<Pick<AppDeps, 'env' | 'onRuling'>>,
  opts: Omit<KeeperOptions, 'now' | 'log'> = {},
): Keeper {
  const keeper = new Keeper({ now: deps.now, log: deps.log, ...opts });
  keeper.register(draftIdleTask(deps));
  const env = deps.env;
  if (env) for (const t of chainLifecycleTasks({ ...deps, env })) keeper.register(t);
  // resolve-due reads deps.onRuling at run time (server.ts sets it on this same object).
  if (env) keeper.register(resolveDueTask(deps));
  return keeper;
}
