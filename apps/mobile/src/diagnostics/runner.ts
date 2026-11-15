// Runs one diagnostics check and turns its outcome into a CheckResult. Pure TS (no native
// imports): the clock is injectable, so it is tested in Node.
import { CHECKS, REQUIRED_CHECK_IDS, type CheckId } from './catalog';

export type CheckStatus = 'idle' | 'running' | 'awaiting-confirm' | 'pass' | 'fail';

export interface CheckResult {
  status: CheckStatus;
  /** What happened, in one or two short lines. */
  detail: string;
  /** Wall time of the check itself, in ms. */
  ms?: number;
  /** ISO UTC time the result was recorded. */
  at?: string;
}

export type CheckResults = Partial<Record<CheckId, CheckResult>>;

/**
 * A check body resolves with its detail line when it passes and throws when it fails.
 * A body that needs the user to confirm (haptics) resolves with `{ confirm: detail }`.
 */
export type CheckBody = () => Promise<string | { confirm: string }>;

export interface RunOptions {
  timeoutMs?: number;
  now?: () => number;
  clock?: () => Date;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

const defaultNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

export class CheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'CheckTimeoutError';
  }
}

/** Formats anything thrown into one readable line (native errors often carry a code). */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const prefix = typeof code === 'string' && code.length > 0 ? `[${code}] ` : '';
    return `${prefix}${e.message || e.name}`;
  }
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

export async function runCheck(body: CheckBody, options: RunOptions = {}): Promise<CheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? defaultNow;
  const clock = options.clock ?? (() => new Date());
  const t0 = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeoutError(timeoutMs)), timeoutMs);
    });
    const outcome = await Promise.race([Promise.resolve().then(body), timeout]);
    const ms = now() - t0;
    if (typeof outcome === 'string') {
      return { status: 'pass', detail: outcome, ms, at: clock().toISOString() };
    }
    return { status: 'awaiting-confirm', detail: outcome.confirm, ms, at: clock().toISOString() };
  } catch (e) {
    return { status: 'fail', detail: describeError(e), ms: now() - t0, at: clock().toISOString() };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolves an awaiting-confirm result once the person says whether they felt / saw it. */
export function confirmResult(prev: CheckResult, confirmed: boolean, clock = () => new Date()) {
  const result: CheckResult = {
    status: confirmed ? 'pass' : 'fail',
    detail: `${prev.detail} | ${confirmed ? 'confirmed by user' : 'user did NOT confirm'}`,
    at: clock().toISOString(),
  };
  if (prev.ms !== undefined) result.ms = prev.ms;
  return result;
}

export interface Summary {
  requiredTotal: number;
  requiredPassed: number;
  /** Required checks that failed. */
  failed: CheckId[];
  /** Required checks not yet passed or failed (idle, running, awaiting confirmation). */
  pending: CheckId[];
  allRequiredGreen: boolean;
}

export function summarize(results: CheckResults): Summary {
  const failed: CheckId[] = [];
  const pending: CheckId[] = [];
  let requiredPassed = 0;
  for (const id of REQUIRED_CHECK_IDS) {
    const status = results[id]?.status ?? 'idle';
    if (status === 'pass') requiredPassed++;
    else if (status === 'fail') failed.push(id);
    else pending.push(id);
  }
  return {
    requiredTotal: REQUIRED_CHECK_IDS.length,
    requiredPassed,
    failed,
    pending,
    allRequiredGreen: requiredPassed === REQUIRED_CHECK_IDS.length,
  };
}

export interface ReportMeta {
  /** e.g. "iOS 26.1" */
  os?: string;
  /** e.g. "iPhone17,1" or the device name, if known */
  device?: string;
  appVersion?: string;
}

/**
 * A JSON report for the build #1 log and docs/measurements.md: every check in catalog order with
 * its status, detail and timing, plus the summary.
 */
export function buildReport(
  results: CheckResults,
  meta: ReportMeta = {},
  clock = () => new Date(),
) {
  return {
    kind: 'youreon.diagnostics.v1',
    at: clock().toISOString(),
    ...meta,
    summary: summarize(results),
    checks: CHECKS.map((c) => {
      const r = results[c.id];
      return {
        id: c.id,
        required: c.required,
        status: r?.status ?? 'idle',
        detail: r?.detail ?? '',
        ms: r?.ms === undefined ? null : Math.round(r.ms * 10) / 10,
      };
    }),
  };
}
