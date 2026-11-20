// Demo runtime toggles, read at call time so a fallback goes on mid-demo with no restart (a
// `fly secrets set` or `fly deploy` restarts the machine): cached_ruling (the judge rules from
// the stored demo verdict; env CACHED_RULING is the boot default) and checks (the camera checks,
// on by default; it can only switch off what env CHECKS_ENABLED allows). A runtime value wins
// until it is cleared (`null`) or the process restarts. In-process, like the claim tokens (one
// Fly machine), and found through `togglesOf(deps)`, so no AppDeps field is needed.
// Spec: docs/planning/API-CONTRACT.md §2.17.
import { z } from 'zod/v4';
import type { Env } from '../env';

type ToggleEnv = Pick<Env, 'CACHED_RULING' | 'CHECKS_ENABLED'>;

/**
 * Strict on purpose (unlike the tolerant request bodies elsewhere): a typo such as
 * {"cached": true} must be a 422, not a 200 that leaves the fallback off while the operator
 * thinks it is on.
 */
export const DemoTogglesRequest = z.strictObject({
  /** true / false = runtime value; null = back to env CACHED_RULING. */
  cached_ruling: z.boolean().nullable().optional(),
  /** false = camera checks off now; true / null = back on (still needs env CHECKS_ENABLED). */
  checks: z.boolean().nullable().optional(),
});
export type DemoTogglesRequest = z.infer<typeof DemoTogglesRequest>;

export type ToggleName = keyof DemoTogglesRequest;
export type ToggleSource = 'env' | 'runtime';

export interface DemoTogglesView {
  /** What the judge pipeline uses right now. */
  cached_ruling: boolean;
  /** 'env' = CACHED_RULING (the boot default); 'runtime' = set by POST /v1/demo/toggles. */
  cached_ruling_source: ToggleSource;
  /** env CACHED_RULING: what a restart (or `cached_ruling: null`) goes back to. */
  cached_ruling_env: boolean;
  /** The checks toggle (default true). Checks also need env CHECKS_ENABLED + SAM3_URL/TOKEN. */
  checks: boolean;
  checks_source: ToggleSource;
  /** env CHECKS_ENABLED (the kill switch the toggle can never override). */
  checks_env: boolean;
  /** The last POST /v1/demo/toggles that set something (ISO), or null. */
  updated_at: string | null;
}

export interface ToggleChange {
  toggle: ToggleName;
  from: boolean;
  to: boolean;
  source: ToggleSource;
}

export class DemoToggles {
  private cachedRuling: boolean | null = null;
  private checks: boolean | null = null;
  private updatedAt: number | null = null;

  /** The effective cached_ruling: the runtime value, else env CACHED_RULING (read at call time). */
  cachedRulingOn(env: Pick<Env, 'CACHED_RULING'>): boolean {
    return this.cachedRuling ?? env.CACHED_RULING;
  }

  /** The checks toggle: the runtime value, else on (env CHECKS_ENABLED gates it separately). */
  checksOn(): boolean {
    return this.checks ?? true;
  }

  /** Applies the toggles named in `req`; one change per named toggle (even when unchanged). */
  apply(req: DemoTogglesRequest, env: ToggleEnv, nowMs: number): ToggleChange[] {
    const out: ToggleChange[] = [];
    if (req.cached_ruling !== undefined) {
      const from = this.cachedRulingOn(env);
      this.cachedRuling = req.cached_ruling;
      out.push({
        toggle: 'cached_ruling',
        from,
        to: this.cachedRulingOn(env),
        source: req.cached_ruling === null ? 'env' : 'runtime',
      });
    }
    if (req.checks !== undefined) {
      const from = this.checksOn();
      this.checks = req.checks;
      out.push({
        toggle: 'checks',
        from,
        to: this.checksOn(),
        source: req.checks === null ? 'env' : 'runtime',
      });
    }
    if (out.length) this.updatedAt = nowMs;
    return out;
  }

  view(env: ToggleEnv): DemoTogglesView {
    return {
      cached_ruling: this.cachedRulingOn(env),
      cached_ruling_source: this.cachedRuling === null ? 'env' : 'runtime',
      cached_ruling_env: env.CACHED_RULING,
      checks: this.checksOn(),
      checks_source: this.checks === null ? 'env' : 'runtime',
      checks_env: env.CHECKS_ENABLED,
      updated_at: this.updatedAt === null ? null : new Date(this.updatedAt).toISOString(),
    };
  }
}

const registry = new WeakMap<object, DemoToggles>();

/** The toggles of this deps bag (the routes, the judge pipeline and the health report share it). */
export function togglesOf(deps: object): DemoToggles {
  let t = registry.get(deps);
  if (!t) registry.set(deps, (t = new DemoToggles()));
  return t;
}

/** Whether the judge rules from the stored verdict right now (runtime toggle, else env). */
export const cachedRulingOn = (deps: { env: Pick<Env, 'CACHED_RULING'> }): boolean =>
  togglesOf(deps).cachedRulingOn(deps.env);
