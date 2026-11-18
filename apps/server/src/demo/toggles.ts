// Demo runtime toggles (API-CONTRACT §2.17 GET / POST /v1/demo/toggles, ARCHITECTURE §7.2): flags
// the server reads at call time, so a fallback goes on mid-demo with no restart (a `fly secrets
// set` or `fly deploy` restarts the machine). The env value is the boot default; a runtime value
// set here wins until it is cleared (`null`) or the process restarts. In-process, like the claim
// tokens (one Fly machine), and found through `togglesOf(deps)`, so no AppDeps field is needed.
//
//   cached_ruling   judge/ruling.ts judgeFrames rules from the stored demo verdict instead of
//                   calling the model (env CACHED_RULING is the default). Each such ruling has
//                   `model` CACHED_RULING_MODEL ('cache/demo-bottle@1', shared isCachedRuling), so
//                   the stage can label it.
//
// Every change is audited ('demo.toggle'); the current values are in GET /v1/demo/health
// `toggles`. The other §2.17 toggles are not here: the Gemini fallback is POST /v1/demo/gemini
// {feed}, the voice fallback is the phone's "Type it instead", the face pick list is the phone's
// room list.
import { z } from 'zod/v4';
import type { Env } from '../env';

/**
 * Strict on purpose (unlike the tolerant §1.4 bodies): a typo such as {"cached": true} must be a
 * 422, not a 200 that leaves the fallback off while the operator thinks it is on.
 */
export const DemoTogglesRequest = z.strictObject({
  /** true / false = runtime value; null = back to env CACHED_RULING. */
  cached_ruling: z.boolean().nullable().optional(),
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
  private updatedAt: number | null = null;

  /** The effective cached_ruling: the runtime value, else env CACHED_RULING (read at call time). */
  cachedRulingOn(env: Pick<Env, 'CACHED_RULING'>): boolean {
    return this.cachedRuling ?? env.CACHED_RULING;
  }

  /** Applies the toggles named in `req`; one change per named toggle (even when unchanged). */
  apply(req: DemoTogglesRequest, env: Pick<Env, 'CACHED_RULING'>, nowMs: number): ToggleChange[] {
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
    if (out.length) this.updatedAt = nowMs;
    return out;
  }

  view(env: Pick<Env, 'CACHED_RULING'>): DemoTogglesView {
    return {
      cached_ruling: this.cachedRulingOn(env),
      cached_ruling_source: this.cachedRuling === null ? 'env' : 'runtime',
      cached_ruling_env: env.CACHED_RULING,
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
