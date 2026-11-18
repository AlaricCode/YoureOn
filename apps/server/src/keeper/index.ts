// The server's keeper and its registered sweeps. server.ts createDeps builds it (unless
// disabled) and startServer starts / stops it with the HTTP server. Later sweeps (lock-window
// expiry with the nonce advance, `timeout_refund`, the nonce-pool sweep, the outbox drain)
// register here.
import type { AppDeps } from '../context';
import { lifecycleOf } from '../lock/runtime';
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
 */
export function chainLifecycleTasks(deps: SweepDeps & Pick<AppDeps, 'env'>): KeeperTask[] {
  return [
    { name: 'lock-sweep', run: (now) => lifecycleOf(deps).lock.sweep(now) },
    { name: 'finalize-due', run: (now) => lifecycleOf(deps).payout.finalizeDue(now) },
  ];
}

export function createServerKeeper(
  deps: SweepDeps & Pick<AppDeps, 'now' | 'log'> & Partial<Pick<AppDeps, 'env' | 'onRuling'>>,
  opts: Omit<KeeperOptions, 'now' | 'log'> = {},
): Keeper {
  const keeper = new Keeper({ now: deps.now, log: deps.log, ...opts });
  keeper.register(draftIdleTask(deps));
  if (!deps.env) return keeper;
  // Every task gets THIS deps object, never a copy: lifecycleOf / settlementOf are keyed on it,
  // so the sweeps share the routes' LockService / PayoutService / SettlementService, and they
  // read fields server.ts sets after this call (deps.markets, deps.onRuling) at run time.
  // (A spread copy made before deps.markets was set gave a lock landed by the sweep its own
  // SettlementService without a Gemini client.)
  const withEnv = deps as typeof deps & { env: NonNullable<typeof deps.env> };
  for (const t of chainLifecycleTasks(withEnv)) keeper.register(t);
  keeper.register(resolveDueTask(deps));
  keeper.register(settlementTask(withEnv));
  return keeper;
}
