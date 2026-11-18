// The chain lifecycle bundle (LockService + PayoutService + RefundService over one ChainRuntime) and its
// per-deps locator. Routes, the voice tools and the keeper tasks call `lifecycleOf(deps)`; it is
// built lazily from env (SOLANA_DEVNET_RPC + FEE_PAYER_SECRET_KEY, src/chain/tx.ts). Tests and
// scripts install their own with `installLifecycle(deps, createLifecycle(deps, { runtime }))`
// (e.g. a LiteSVM-backed ChainClient). No AppDeps field is needed, so no core edit.
import type { AppDeps } from '../context';
import { chainRuntimeFromEnv, type ChainRuntime, type SendOptions } from '../chain/tx';
import { RefundService } from '../payout/refund';
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
  /** Resolves once every background send/confirm started so far has settled (tests). */
  idle(): Promise<void>;
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
  const payout = new PayoutService({
    deps,
    runtime,
    inflight,
    signer,
    send: o.send,
    timers: o.timers,
  });
  const refund = new RefundService({ deps, runtime, inflight, send: o.send });
  return {
    runtime,
    lock,
    payout,
    refund,
    idle: () => inflight.idle(),
    stop: () => payout.stop(),
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
