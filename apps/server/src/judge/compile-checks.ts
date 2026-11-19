// compile_checks (design final.md §1 "Compilation"): the agreed terms -> a canonical CheckSpec, or
// judge_only. One Claude structured-output call (prompt: compile-checks-prompt.ts, examples:
// checks-fewshots.ts); the spec is canonicalized and CheckSpec-parsed in code, with ONE retry that
// shows the model the zod issues. Never throws: any failure is judge_only with status 'fallback'
// (the readback then says "Judge only, no ref cam"), so a compiler outage can never block a bet.
//
// No call at all for real_world bets or multi-attempt rules (§1 V2 rules: checks need type 'skill'
// and attempts.rule 'single'). Results are cached in memory by
// sha256(JCS(input) + prompt version + model); fallbacks are not cached, so a transient outage
// does not stick.
import { jcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { CompileInput } from '@youre-on/shared/checks/compile';
import {
  canonicalizeCheckSpec,
  CheckSpec,
  describeChecks,
  type CompiledChecks,
  type Entity,
  type Assertion,
} from '@youre-on/shared/checks/spec';
import type { AppDeps } from '../context';
import type { ChatFailure, ChatPart } from '../providers/types';
import type { SelectFewShotsOptions } from './checks-fewshots';
import { buildCompilePrompt, COMPILE_CHECKS_OUTPUT } from './compile-checks-prompt';

/** Off the voice webhook's critical path, so longer than the design's 6 s (Opus thinks first). */
export const COMPILE_CHECKS_TIMEOUT_MS = 20_000;
/** Thinking counts against it (Opus 5.5 thinking cannot be disabled). */
export const COMPILE_CHECKS_MAX_OUTPUT_TOKENS = 8_000;
const CACHE_MAX = 500;

export interface CompileChecksResult {
  decision: CompiledChecks['decision'];
  /** Canonical and CheckSpec-parsed; null for judge_only. */
  spec: CheckSpec | null;
  why: string;
  /** "anthropic/<served model>", or null when no call was needed. */
  model: string | null;
  prompt_version: string;
  /** Model calls made (0, 1 or 2). */
  attempts: number;
  latency_ms: number;
  status: 'ok' | 'fallback';
  /** Why it fell back (never a secret). */
  error?: string;
  /** True when served from the in-memory cache (no call made now). */
  cached?: boolean;
}

export type CompileChecksDeps = Pick<AppDeps, 'env' | 'providers' | 'log'>;

export interface CompileChecksOptions {
  /** Few-shot selection (default: all, in order). */
  fewShots?: SelectFewShotsOptions;
  /** Override env.CHECKS_MODEL. */
  model?: string;
  timeoutMs?: number;
  /** Default: a process-wide cache. Pass a Map for isolation, or null to disable. */
  cache?: Map<string, CompileChecksResult> | null;
  now?: () => number;
}

const DEFAULT_CACHE = new Map<string, CompileChecksResult>();
export const clearCompileChecksCache = (): void => DEFAULT_CACHE.clear();

/** Canonicalize when the shape allows it, then the full CheckSpec parse (lints + order). */
export function acceptSpec(
  raw: unknown,
): { ok: true; spec: CheckSpec } | { ok: false; issues: string[] } {
  let candidate = raw;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as { entities?: unknown }).entities) &&
    Array.isArray((raw as { assertions?: unknown }).assertions)
  ) {
    try {
      candidate = canonicalizeCheckSpec(raw as { entities: Entity[]; assertions: Assertion[] });
    } catch {
      candidate = raw; // the parse below reports what is wrong
    }
  }
  const r = CheckSpec.safeParse(candidate);
  if (!r.success) {
    return {
      ok: false,
      issues: r.error.issues
        .slice(0, 8)
        .map((i) => `${['spec', ...i.path].join('.')}: ${i.message}`),
    };
  }
  try {
    describeChecks(r.data); // the readback must render
  } catch (e) {
    return { ok: false, issues: [`readback failed: ${String(e)}`] };
  }
  return { ok: true, spec: r.data };
}

/** The decision + spec rules beyond the wire schema. */
function judgeOutput(
  v: CompiledChecks,
): { ok: true; spec: CheckSpec | null } | { ok: false; issues: string[] } {
  if (v.decision === 'judge_only') {
    return v.spec === null
      ? { ok: true, spec: null }
      : { ok: false, issues: ['decision "judge_only" requires spec null'] };
  }
  if (v.spec === null) return { ok: false, issues: ['decision "checks" requires a spec'] };
  return acceptSpec(v.spec);
}

function retryText(issues: string[], previous: string | undefined): string {
  return [
    'Your previous answer was rejected by the validator:',
    ...issues.map((i) => `- ${i}`),
    ...(previous ? [`Previous answer: ${previous.slice(0, 2000)}`] : []),
    'Fix these problems (or answer judge_only if no valid check applies) and return the corrected JSON OUTPUT.',
  ].join('\n');
}

export async function compileChecks(
  deps: CompileChecksDeps,
  input: CompileInput,
  opts: CompileChecksOptions = {},
): Promise<CompileChecksResult> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const model = opts.model ?? deps.env.CHECKS_MODEL;

  const parsed = CompileInput.safeParse(input);
  if (!parsed.success) {
    const error = `invalid input: ${parsed.error.issues[0]?.message ?? 'unknown'}`;
    deps.log.warn('checks.compile_fallback', { status: 'invalid_input', error });
    return {
      decision: 'judge_only',
      spec: null,
      why: 'Invalid compiler input.',
      model: null,
      prompt_version: buildCompilePrompt(input, opts.fewShots).prompt_version,
      attempts: 0,
      latency_ms: ms(),
      status: 'fallback',
      error,
    };
  }
  const prompt = buildCompilePrompt(parsed.data, opts.fewShots);
  const pv = prompt.prompt_version;

  // §1 V2 rules: checks only for single-attempt skill bets. No model call otherwise.
  if (parsed.data.type !== 'skill' || parsed.data.attempts.rule !== 'single') {
    return {
      decision: 'judge_only',
      spec: null,
      why:
        parsed.data.type !== 'skill'
          ? 'Not a camera skill bet.'
          : 'Multi-attempt bet: end-window checks would see only the last try.',
      model: null,
      prompt_version: pv,
      attempts: 0,
      latency_ms: ms(),
      status: 'ok',
    };
  }

  const cache = opts.cache === undefined ? DEFAULT_CACHE : opts.cache;
  const key = sha256Hex(jcs(parsed.data) + pv + model);
  const hit = cache?.get(key);
  if (hit) {
    deps.log.info('checks.compile_cached', { key: key.slice(0, 12), prompt_version: pv });
    // A deep copy: a caller mutating its result must not change later hits.
    return { ...structuredClone(hit), latency_ms: ms(), cached: true };
  }

  const fallback = (
    attempts: number,
    served: string | null,
    status: ChatFailure | 'invalid_spec' | 'threw',
    message: string,
  ): CompileChecksResult => {
    deps.log.warn('checks.compile_fallback', {
      status,
      message: message.slice(0, 300),
      model: served,
      prompt_version: pv,
      attempts,
    });
    return {
      decision: 'judge_only',
      spec: null,
      why: 'Compiler failed; judge only.',
      model: served,
      prompt_version: pv,
      attempts,
      latency_ms: ms(),
      status: 'fallback',
      error: `${status}: ${message.slice(0, 300)}`,
    };
  };

  let parts: ChatPart[] = prompt.parts;
  let served: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let issues: string[];
    let previous: string | undefined;
    try {
      const res = await deps.providers.llm.chat({
        vendor: 'anthropic',
        model,
        system: prompt.system,
        parts,
        output: COMPILE_CHECKS_OUTPUT,
        effort: 'medium',
        maxOutputTokens: COMPILE_CHECKS_MAX_OUTPUT_TOKENS,
        timeoutMs: opts.timeoutMs ?? COMPILE_CHECKS_TIMEOUT_MS,
      });
      served = `anthropic/${res.model}`;
      if (!res.ok) {
        // Only a malformed answer is worth a retry; timeouts, refusals and errors fall back now.
        if (res.status !== 'invalid_output')
          return fallback(attempt, served, res.status, res.message);
        issues = [res.message];
        previous = res.text;
      } else {
        const j = judgeOutput(res.value);
        if (j.ok) {
          const out: CompileChecksResult = {
            decision: j.spec === null ? 'judge_only' : 'checks',
            spec: j.spec,
            why: res.value.why,
            model: served,
            prompt_version: pv,
            attempts: attempt,
            latency_ms: ms(),
            status: 'ok',
          };
          deps.log.info('checks.compiled', {
            decision: out.decision,
            predicates: out.spec?.assertions.map((a) => `${a.role}:${a.test.p}`) ?? [],
            model: served,
            prompt_version: pv,
            attempts: attempt,
            latency_ms: out.latency_ms,
          });
          if (cache) {
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
            cache.set(key, structuredClone(out));
          }
          return out;
        }
        issues = j.issues;
        previous = res.text;
      }
    } catch (e) {
      return fallback(attempt, served ?? `anthropic/${model}`, 'threw', String(e));
    }
    if (attempt === 2) return fallback(attempt, served, 'invalid_spec', issues.join('; '));
    deps.log.warn('checks.compile_retry', { issues, model: served, prompt_version: pv });
    parts = [...prompt.parts, { kind: 'text', text: retryText(issues, previous) }];
  }
  /* c8 ignore next */
  return fallback(2, served, 'invalid_spec', 'unreachable');
}
