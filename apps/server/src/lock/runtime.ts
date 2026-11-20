// The chain lifecycle bundle (LockService, PayoutService, RefundService and AppealService over one
// ChainRuntime, plus the ReviewService) and its per-deps locator. Routes, the voice tools and the
// keeper tasks call `lifecycleOf(deps)`; it is built lazily from env (SOLANA_DEVNET_RPC +
// FEE_PAYER_SECRET_KEY, src/chain/tx.ts). Tests and scripts install their own with
// `installLifecycle(deps, createLifecycle(deps, { runtime }))` (e.g. a LiteSVM-backed ChainClient).
// The registry is a WeakMap keyed by the deps bag, so AppDeps needs no lifecycle field.
import type { AppDeps } from '../context';
import { AppealService, type AppealDeps } from '../appeal/service';
import { chainRuntimeFromEnv, type ChainRuntime, type SendOptions } from '../chain/tx';
import { ggPayoutHooks } from '../gg/service';
import { RefundService } from '../payout/refund';
import { ReviewService } from '../review/service';
import { PayoutService } from '../payout/service';
import { Inflight, type LifecycleDeps } from './common';
import { LockService } from './service';

export interface Lifecycle {
  /** null when the chain is not configured (every chain action then fails soft). */
  runtime(): Promise<ChainRuntime | null>;
  lock: LockService;
  payout: PayoutService;
  /** timeout_refund of stuck bets, orphan escrow exits (src/payout/refund.ts). */
  refund: RefundService;
  /** The loser's appeal, the three-vendor panel, resolve_appeal (src/appeal). */
  appeal: AppealService;
  /** The spoken "check that again": asks the loser's phone to confirm an appeal (src/review). */
  review: ReviewService;
  /** Resolves once every background send/confirm started so far has settled (tests). */
  idle(): Promise<void>;
  /** The send / confirm options of every tx this lifecycle sends (tests shorten them). */
  readonly sendOptions: SendOptions | undefined;
  /** Fire-and-forget work tracked like the lifecycle's own (idle() waits for it). */
  run(name: string, fn: () => Promise<unknown>): void;
  stop(): void;
}

export interface LifecycleOptions {
  /** Default: chainRuntimeFromEnv(deps.env), memoized. */
  runtime?: () => Promise<ChainRuntime | null>;
  /** Default deps.env.LOCK_SIGNER. */
  signer?: 'phones' | 'server';
  send?: SendOptions;
  /** Arm the finalize setTimeout fast path (default true). */
  timers?: boolean;
  /** The appeal panel's per-vote budget (default 8 s, PANEL_VOTE_TIMEOUT_MS); tests shorten it. */
  appealVoteTimeoutMs?: number;
}

export function createLifecycle(deps: LifecycleDeps, o: LifecycleOptions = {}): Lifecycle {
  let memo: Promise<ChainRuntime | null> | null = null;
  const runtime =
    o.runtime ??
    (() => {
      memo ??= chainRuntimeFromEnv(deps.env)
        .then((rt) => {
          if (rt && rt.feePayerPinned === false && deps.env.LOCK_SIGNER === 'phones')
            deps.log.warn('chain.fee_payer_not_pinned', {
              fee_payer: rt.keys.feePayer.address,
              hint: 'phones refuse locks whose fee payer is not packages/shared FEE_PAYER_PUBKEY',
            });
          return rt;
        })
        .catch((err: unknown) => {
          deps.log.error('chain.runtime_failed', { err });
          memo = null;
          return null;
        });
      return memo;
    });
  const inflight = new Inflight(deps.log);
  const signer = o.signer ?? deps.env.LOCK_SIGNER;
  const lock = new LockService({ deps, runtime, inflight, signer, send: o.send });
  // eslint-disable-next-line prefer-const -- assigned right below; the payout push reads it lazily
  let appeal: AppealService;
  const payout = new PayoutService({
    deps,
    runtime,
    inflight,
    signer,
    send: o.send,
    timers: o.timers,
    appealRequest: (rt, bet, loser) => appeal.pushRequest(rt, bet, loser),
    // The GG moment: bet.gg with the CONCEDED commit, the PAID cue says GG / timeout (src/gg).
    ...ggPayoutHooks(deps),
  });
  const refund = new RefundService({ deps, runtime, inflight, send: o.send, timers: o.timers });
  // The route deps bag carries the LLM providers (AppDeps); a bare LifecycleDeps has none, and
  // then every panel seat abstains (the original ruling stands).
  appeal = new AppealService({
    deps: deps as AppealDeps,
    runtime,
    inflight,
    signer,
    payout,
    send: o.send,
    ...(o.appealVoteTimeoutMs !== undefined ? { voteTimeoutMs: o.appealVoteTimeoutMs } : {}),
  });
  const review = new ReviewService({ deps, timers: o.timers });
  return {
    runtime,
    lock,
    payout,
    refund,
    appeal,
    review,
    idle: () => inflight.idle(),
    sendOptions: o.send,
    run: (name, fn) => inflight.run(name, fn),
    stop: () => {
      payout.stop();
      refund.stop();
      review.stop();
    },
  };
}

const registry = new WeakMap<object, Lifecycle>();

/** The lifecycle of this deps bag (built from env on first use). */
export function lifecycleOf(deps: LifecycleDeps): Lifecycle {
  let lc = registry.get(deps);
  if (!lc) registry.set(deps, (lc = createLifecycle(deps)));
  return lc;
}

/** Replaces the lifecycle of `deps` (tests, scripts). */
export function installLifecycle(deps: LifecycleDeps | AppDeps, lc: Lifecycle): Lifecycle {
  registry.get(deps)?.stop();
  registry.set(deps, lc);
  return lc;
}
