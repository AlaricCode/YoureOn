// POST /v1/demo/warmup (API-CONTRACT §2.17; FINDINGS §3.8 "a Claude warm-up call 10 minutes
// before the pitch"): touch every external dependency of the demo once, without a bet and
// without moving money, and say how each answered.
//
//   judge    one live vision call through deps.providers.llm with the real prompt and the real
//            output schema (judge/ruling.ts callJudge) on a 16x16 stored JPEG
//            (judge/fixtures/warmup-16px.jpg). It ignores cached_ruling (the point is to test the
//            live judge) and records into the judge stats (GET /v1/demo/health `judge_llm`).
//   rpc      getLatestBlockhash on the server's RPC (the chain runtime's client).
//   gemini   one poll of the BTC 5-minute relay (MarketService.refresh, shared with its own
//            loop) and its current contract.
//   voice    voice readiness (voice/readiness.ts): config only. A conversation token would open a
//            billed ElevenLabs session, so none is minted.
//
// Each check reports {ok, ms, error} plus what it saw; the checks run in parallel and each is
// time-boxed. `notes` says when a check did not exercise the real thing (LLM_PROVIDER=mock, the
// cached ruling, the REPLAY feed, no chain). One warm-up per 10 s (WARMUP_BUCKET, on even when
// deps.rateLimit is off), so a stuck key or a loop cannot burn the API budget: each one is a
// paid Claude call (~1 image, ≤ 1024 output tokens).
import { readFileSync } from 'node:fs';
import { auditLog } from '@youre-on/db';
import type { AppDeps } from '../context';
import { RateLimiter, type BucketSpec } from '../http/rate-limit';
import { rpcErrorText } from '../chain/tx';
import { lifecycleOf } from '../lock/runtime';
import type { JudgeTerms } from '../judge/prompt';
import { callJudge } from '../judge/ruling';
import { voiceReadiness } from '../voice/readiness';
import { togglesOf } from './toggles';

/** One warm-up per 10 s per server. */
export const WARMUP_BUCKET: BucketSpec = { limit: 1, windowMs: 10_000 };
/** Each check's own cap (the judge call has its 10 s deadline inside). */
export const WARMUP_CHECK_TIMEOUT_MS = 15_000;

/** The stored frame (a valid 16x16 baseline JPEG, 663 B). Read once. */
let frame: Uint8Array | null = null;
export function warmupFrame(): Uint8Array {
  frame ??= new Uint8Array(
    readFileSync(new URL('../judge/fixtures/warmup-16px.jpg', import.meta.url)),
  );
  return frame;
}

/** The Beat 2 bottle flip (demo/routes.ts DEMO_TERMS_ARGS), as the prompt reads it. */
export const WARMUP_TERMS: JudgeTerms = {
  claim: 'Party B lands a water bottle flip upright on the table.',
  attempts: { count: 1, rule: 'single' },
  success_criteria: [
    'The bottle rotates at least once in the air.',
    'The bottle comes to rest standing upright on its base.',
  ],
  failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
  edge_cases: [
    {
      question: 'Does landing on the cap count?',
      answer: 'No. Only upright on its base counts.',
      asked_by: 'judge',
    },
  ],
};

export interface WarmupCheck {
  ok: boolean;
  ms: number;
  error: string | null;
}

export interface WarmupResult {
  ok: boolean;
  at: string;
  /** What was configured: a check against a mock / replay / cached path says so in `notes`. */
  modes: {
    llm: 'live' | 'mock';
    judge_model: string;
    cached_ruling: boolean;
    markets_feed: 'live' | 'replay' | 'off' | null;
    lock_signer: 'phones' | 'server';
  };
  notes: string[];
  checks: {
    judge: WarmupCheck & {
      provider: 'live' | 'mock';
      model: string | null;
      claim_result: string | null;
    };
    rpc: WarmupCheck & { rpc: string | null; blockhash: string | null };
    gemini: WarmupCheck & {
      feed_mode: 'live' | 'replay' | null;
      current: {
        event_ticker: string;
        expiry: string;
        strike: string | null;
        lockable: boolean;
        lockable_until: string | null;
        refusal: string | null;
      } | null;
      next_window_start: string | null;
    };
    voice: WarmupCheck & { judge_ready: boolean; ready: boolean; missing: string[] };
  };
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/** Runs `fn`, timing it and capping it at `ms`; a throw or the cap becomes `{ok: false}`. */
async function timed<T extends object>(
  fail: T,
  fn: () => Promise<T & { ok: boolean; error?: string | null }>,
  ms = WARMUP_CHECK_TIMEOUT_MS,
): Promise<T & WarmupCheck> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
    return { ...r, error: r.error ?? null, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ...fail, ok: false, error: errText(e), ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

const limiters = new WeakMap<object, RateLimiter>();

/** Throws 429 RATE_LIMITED (Retry-After) for a second warm-up within WARMUP_BUCKET. */
export function takeWarmupToken(deps: Pick<AppDeps, 'now'>): void {
  let l = limiters.get(deps);
  if (!l) limiters.set(deps, (l = new RateLimiter(deps.now, 16)));
  l.take('demo/warmup', 'server', WARMUP_BUCKET);
}

export async function runWarmup(
  deps: AppDeps,
  o: { requestId?: string } = {},
): Promise<WarmupResult> {
  const llm = deps.providers.llm.name;
  const cached = togglesOf(deps).cachedRulingOn(deps.env);
  const m = deps.markets;
  const notes: string[] = [];
  if (llm === 'mock')
    notes.push(
      deps.env.NODE_ENV === 'production'
        ? 'LLM_PROVIDER=mock: in production the mock refuses every call, so no ruling can be made (set LLM_PROVIDER=live with ALLOW_SPEND=true and ANTHROPIC_API_KEY).'
        : 'LLM_PROVIDER=mock: the judge check hit the offline mock, not Claude.',
    );
  if (cached)
    notes.push(
      `cached_ruling is on (${togglesOf(deps).view(deps.env).cached_ruling_source}): bets get the stored verdict (model cache/demo-bottle@1); this warm-up still called the live judge.`,
    );

  const judge = timed(
    { provider: llm, model: null as string | null, claim_result: null as string | null },
    async () => {
      const j = await callJudge(
        deps,
        {
          terms: WARMUP_TERMS,
          performer_name: 'Warm-up',
          frames: [{ t_ms: 0, bytes: warmupFrame() }],
        },
        'warmup',
      );
      return j.kind === 'verdict'
        ? { ok: true, provider: llm, model: j.model, claim_result: j.verdict.claim_result }
        : {
            ok: false,
            provider: llm,
            model: j.model,
            claim_result: null,
            error: `${j.status}: ${j.message}`.slice(0, 200),
          };
    },
  );

  const rpc = timed({ rpc: null as string | null, blockhash: null as string | null }, async () => {
    const rt = await lifecycleOf(deps).runtime();
    if (!rt)
      return {
        ok: false,
        rpc: null,
        blockhash: null,
        error: 'chain not configured (SOLANA_DEVNET_RPC / FEE_PAYER_SECRET_KEY)',
      };
    try {
      const b = await rt.client.latestBlockhash();
      return { ok: true, rpc: rt.client.label, blockhash: b.blockhash };
    } catch (e) {
      return { ok: false, rpc: rt.client.label, blockhash: null, error: rpcErrorText(e) };
    }
  });

  const gemini = timed(
    {
      feed_mode: (m?.feed ?? null) as 'live' | 'replay' | null,
      current: null as WarmupResult['checks']['gemini']['current'],
      next_window_start: null as string | null,
    },
    async () => {
      if (!m)
        return {
          ok: false,
          feed_mode: null,
          current: null,
          next_window_start: null,
          error: 'the Gemini relay is off in this process (MARKETS_FEED=off)',
        };
      await m.refresh();
      const cur = m.current(deps.now());
      const failed = m.failures > 0;
      return {
        ok: !failed && cur.market !== null,
        feed_mode: m.feed,
        current: cur.market
          ? {
              event_ticker: cur.market.eventTicker,
              expiry: cur.market.expiry,
              strike: cur.market.strike.value,
              lockable: cur.lockable,
              lockable_until: cur.lockable_until,
              refusal: cur.refusal,
            }
          : null,
        next_window_start: cur.next_window_start,
        error: failed
          ? `poll failed: ${m.lastError ?? 'error'}`
          : cur.market
            ? null
            : 'no BTC 5-minute contract is live right now',
      };
    },
  );

  const voice = timed({ judge_ready: false, ready: false, missing: [] as string[] }, async () => {
    // The production voice route's ElevenLabs client exists exactly when ALLOW_SPEND=true.
    const r = voiceReadiness(deps.env, deps.env.ALLOW_SPEND === true);
    return {
      ok: r.judge_ready,
      judge_ready: r.judge_ready,
      ready: r.ready,
      missing: r.missing,
      error: r.judge_ready ? null : `not ready: ${r.missing.join('; ')}`.slice(0, 300),
    };
  });

  const checks = {
    judge: await judge,
    rpc: await rpc,
    gemini: await gemini,
    voice: await voice,
  };
  if (!checks.rpc.ok && checks.rpc.rpc === null)
    notes.push('No chain runtime: locks and payouts cannot run.');
  if (checks.gemini.feed_mode === 'replay')
    notes.push('The Gemini relay is on the REPLAY feed (POST /v1/demo/gemini {"feed":"live"}).');

  const result: WarmupResult = {
    ok: Object.values(checks).every((c) => c.ok),
    at: new Date(deps.now()).toISOString(),
    modes: {
      llm,
      judge_model: deps.env.JUDGE_MODEL,
      cached_ruling: cached,
      markets_feed: m ? m.feed : 'off',
      lock_signer: deps.env.LOCK_SIGNER,
    },
    notes,
    checks,
  };
  await deps.db.insert(auditLog).values({
    actor_kind: 'system',
    action: 'demo.warmup',
    request_id: o.requestId ?? null,
    details: {
      ok: result.ok,
      llm,
      cached_ruling: cached,
      judge: { ok: checks.judge.ok, ms: checks.judge.ms },
      rpc: { ok: checks.rpc.ok, ms: checks.rpc.ms },
      gemini: { ok: checks.gemini.ok, ms: checks.gemini.ms },
      voice: { ok: checks.voice.ok },
    },
  });
  deps.log.info('demo.warmup', {
    ok: result.ok,
    judge_ms: checks.judge.ms,
    judge_ok: checks.judge.ok,
    rpc_ok: checks.rpc.ok,
    gemini_ok: checks.gemini.ok,
    voice_ok: checks.voice.ok,
  });
  return result;
}
