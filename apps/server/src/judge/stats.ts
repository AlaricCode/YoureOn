// Judge health, in memory (since boot): every vision call through deps.providers.llm (an attempt
// ruling, or POST /v1/demo/warmup) records its outcome and wall time here. GET /v1/demo/health
// (chain/health.ts `judge_llm`, `llm_last_ok`) and scripts/demo-check.ts read it: the last success,
// the last failure, p50 / p95 over the recent calls, and a WARN when nothing succeeded since boot.
// A cached ruling makes no call and records nothing. Found through `judgeStatsOf(deps)`.
import type { AppDeps } from '../context';
import { percentile } from '../chain/tx';
import { cachedRulingOn } from '../demo/toggles';

/** Who made the call. */
export type JudgeCallSource = 'ruling' | 'warmup' | 'dance';

export interface JudgeCallSample {
  at: number;
  ms: number;
  ok: boolean;
  /** The model that served (or was asked), e.g. "anthropic/claude-sonnet-5-5". */
  model: string;
  source: JudgeCallSource;
  /** Failures: the ChatFailure ('timeout', 'error', ...) and its message (truncated). */
  status?: string;
  error?: string;
}

export interface JudgeStatsSnapshot {
  /** Calls / failures since boot. */
  calls: number;
  failures: number;
  last_ok_at: string | null;
  last_ok_ms: number | null;
  last_ok_source: JudgeCallSource | null;
  last_ok_model: string | null;
  last_error_at: string | null;
  /** "<status>: <message>" of the last failed call. */
  last_error: string | null;
  last_error_source: JudgeCallSource | null;
  /** Latency over the last `window` calls (successes and failures: what the players waited). */
  window: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface JudgeHealth extends JudgeStatsSnapshot {
  /** deps.providers.llm: 'live' (Claude) or 'mock' (offline; refuses every call in production). */
  provider: 'live' | 'mock' | null;
  /** env JUDGE_MODEL. */
  model: string;
  /** The effective cached_ruling toggle: rulings make no model call while it is on. */
  cached_ruling: boolean;
}

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export class JudgeStats {
  private readonly ring: JudgeCallSample[] = [];
  private next = 0;
  private calls = 0;
  private failures = 0;
  private lastOk: JudgeCallSample | null = null;
  private lastFail: JudgeCallSample | null = null;
  constructor(readonly size = 50) {}

  record(s: JudgeCallSample): void {
    const sample = { ...s, error: s.error?.slice(0, 160) };
    this.calls++;
    if (sample.ok) this.lastOk = sample;
    else {
      this.failures++;
      this.lastFail = sample;
    }
    if (this.ring.length < this.size) this.ring.push(sample);
    else this.ring[this.next] = sample;
    this.next = (this.next + 1) % this.size;
  }

  snapshot(): JudgeStatsSnapshot {
    const ms = this.ring.map((s) => s.ms).sort((a, b) => a - b);
    const f = this.lastFail;
    return {
      calls: this.calls,
      failures: this.failures,
      last_ok_at: iso(this.lastOk?.at),
      last_ok_ms: this.lastOk?.ms ?? null,
      last_ok_source: this.lastOk?.source ?? null,
      last_ok_model: this.lastOk?.model ?? null,
      last_error_at: iso(f?.at),
      last_error: f ? `${f.status ?? 'error'}: ${f.error ?? ''}`.trim() : null,
      last_error_source: f?.source ?? null,
      window: this.ring.length,
      p50_ms: percentile(ms, 0.5),
      p95_ms: percentile(ms, 0.95),
    };
  }
}

const registry = new WeakMap<object, JudgeStats>();

/** The judge stats of this deps bag (judge pipeline, warm-up and health share it). */
export function judgeStatsOf(deps: object): JudgeStats {
  let s = registry.get(deps);
  if (!s) registry.set(deps, (s = new JudgeStats()));
  return s;
}

/** The `judge_llm` block of GET /v1/demo/health. */
export function judgeHealth(deps: Pick<AppDeps, 'env'> & Partial<Pick<AppDeps, 'providers'>>) {
  const h: JudgeHealth = {
    provider: deps.providers?.llm.name ?? null,
    model: deps.env.JUDGE_MODEL,
    cached_ruling: cachedRulingOn(deps),
    ...judgeStatsOf(deps).snapshot(),
  };
  return h;
}
