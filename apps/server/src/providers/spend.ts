// Spend guard: a provider mode that costs money refuses to start unless ALLOW_SPEND=true.
// Tests and CI never set it, so they can only reach the mocks (or live adapters handed a fake
// transport explicitly).
// Adapted from Verdict's packages/backend/src/config/spend.ts (docs/MERGE-PLAN.md).
import type { Env } from '../env';

export const PROVIDER_VARS = ['LLM_PROVIDER', 'STT_PROVIDER', 'SFX_PROVIDER'] as const;
export type ProviderVar = (typeof PROVIDER_VARS)[number];

export type SpendEnv = Pick<Env, 'ALLOW_SPEND' | ProviderVar>;

export class SpendDisabledError extends Error {
  readonly code = 'SPEND_DISABLED';
  constructor(readonly modes: readonly string[]) {
    super(
      `SPEND_DISABLED: ${modes.join(', ')} can incur cost; set ALLOW_SPEND=true to allow it ` +
        `(never in tests or CI), or use mock.`,
    );
    this.name = 'SpendDisabledError';
  }
}

/** Every configured provider variable whose mode is paid, as "VAR=live". */
export function spendingModes(env: SpendEnv): string[] {
  return PROVIDER_VARS.filter((v) => env[v] === 'live').map((v) => `${v}=live`);
}

/** Call before constructing any paid provider (live factories do). */
export function assertSpendAllowed(env: Pick<Env, 'ALLOW_SPEND'>, what: string): void {
  if (env.ALLOW_SPEND !== true) throw new SpendDisabledError([what]);
}

/**
 * Boot check: throws listing every paid mode when ALLOW_SPEND is not true. `skip` = overridden
 * capabilities.
 */
export function enforceSpendGuard(env: SpendEnv, skip: readonly ProviderVar[] = []): void {
  if (env.ALLOW_SPEND === true) return;
  const modes = spendingModes(env).filter((m) => !skip.some((s) => m.startsWith(`${s}=`)));
  if (modes.length > 0) throw new SpendDisabledError(modes);
}
