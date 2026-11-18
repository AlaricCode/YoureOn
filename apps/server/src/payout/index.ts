// Public entry for other slices: the judge calls
//   await createPayoutService(deps).onRuling(betId, ruling)
// with a decisive or VOID shared `Ruling` / `HearingRuling` (packages/shared ruling.ts,
// hearing.ts). It returns the process-wide PayoutService of `deps` (lifecycleOf), so the
// finalize timers and the keeper sweep share one instance.
import type { LifecycleDeps } from '../lock/common';
import { lifecycleOf } from '../lock/runtime';
import type { PayoutService } from './service';

export function createPayoutService(deps: LifecycleDeps): PayoutService {
  return lifecycleOf(deps).payout;
}

export {
  PayoutService,
  PayoutRuling,
  RESOLVABLE_STATES,
  FINALIZE_DELAY_MS,
  type RuledResult,
} from './service';
