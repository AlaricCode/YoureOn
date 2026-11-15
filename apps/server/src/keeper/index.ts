// The server's keeper and its registered sweeps. server.ts createDeps builds it (unless
// disabled) and startServer starts / stops it with the HTTP server. Later sweeps (lock-window
// expiry with the nonce advance, `timeout_refund`, the nonce-pool sweep, the outbox drain)
// register here.
import type { AppDeps } from '../context';
import { draftIdleTask, type SweepDeps } from './draft-idle';
import { Keeper, type KeeperOptions } from './keeper';

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

export function createServerKeeper(
  deps: SweepDeps & Pick<AppDeps, 'now' | 'log'>,
  opts: Omit<KeeperOptions, 'now' | 'log'> = {},
): Keeper {
  const keeper = new Keeper({ now: deps.now, log: deps.log, ...opts });
  keeper.register(draftIdleTask(deps));
  return keeper;
}
