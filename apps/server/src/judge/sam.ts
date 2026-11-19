// The SAM 3.1 client (services/sam3/modal_app.py; design final.md §2): POST /segment over an
// attempt's regular frames, GET /health to wake a container. Used only by the camera checks
// (judge/camera-checks.ts), and only while they are active.
//
//   segment()  one deadline for the whole call, retry included: the first try may use all of it;
//              ONE retry follows a fast failure (network error, 5xx, 429, an unreadable reply)
//              when at least MIN_RETRY_MS is left. Never throws: a failure is {ok: false}, which
//              the checks record as 'unavailable' (no veto).
//   warm()     GET /health, fire-and-forget (a cold container takes ~25-45 s; it stays warm 5 min).
//
// The bearer token is only ever put in the Authorization header: it is never logged, and any
// message that could echo it is scrubbed.
import { SamSegmentReply } from '@youre-on/shared/checks/sam-reply';
import type { Logger } from '../log';

/** Below this, a retry cannot finish (≈ one prompt warm is 3.5 s). */
export const MIN_RETRY_MS = 3_500;
/** GET /health never waits longer (cold start can be 45 s; the warm-up still happens server-side). */
export const WARM_TIMEOUT_MS = 60_000;

export type SamFailure = 'timeout' | 'http' | 'network' | 'invalid_reply';

export type SamSegmentResult =
  | {
      ok: true;
      /** The raw JSON reply (what CheckReport.sam_reply_hash covers). */
      raw: unknown;
      reply: SamSegmentReply;
      ms: number;
      tries: number;
    }
  | { ok: false; status: SamFailure; message: string; ms: number; tries: number };

export interface SamSegmentOptions {
  masks?: boolean;
  promptFrame?: number;
  /** Total budget for the call, retry included. */
  timeoutMs: number;
}

export interface SamStatsSnapshot {
  calls: number;
  failures: number;
  last_ok_at: string | null;
  last_ok_ms: number | null;
  last_error_at: string | null;
  /** "<status>: <message>" of the last failed call. */
  last_error: string | null;
  last_warm_at: string | null;
}

export interface SamClient {
  segment(
    prompts: string[],
    frames: readonly Uint8Array[],
    opts: SamSegmentOptions,
  ): Promise<SamSegmentResult>;
  warm(): void;
  stats(): SamStatsSnapshot;
}

export interface SamClientOptions {
  url: string;
  token: string;
  log: Pick<Logger, 'info' | 'warn'>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Wall clock for the stats (ms). */
  now?: () => number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function createSamClient(o: SamClientOptions): SamClient {
  const base = o.url.replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const scrub = (s: string) => (o.token ? s.split(o.token).join('***') : s).slice(0, 300);
  const st = {
    calls: 0,
    failures: 0,
    lastOkAt: null as number | null,
    lastOkMs: null as number | null,
    lastErrAt: null as number | null,
    lastErr: null as string | null,
    lastWarmAt: null as number | null,
  };

  type Try =
    | { ok: true; raw: unknown; reply: SamSegmentReply }
    | { ok: false; status: SamFailure; message: string; retry: boolean };

  async function once(body: string, ms: number): Promise<Try> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await doFetch(`${base}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
        body,
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 401 / 422 are deterministic: retrying the same body cannot help.
        const retry = res.status >= 500 || res.status === 429;
        return { ok: false, status: 'http', message: `${res.status} ${text}`, retry };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, status: 'invalid_reply', message: 'not JSON', retry: true };
      }
      const p = SamSegmentReply.safeParse(raw);
      if (!p.success)
        return {
          ok: false,
          status: 'invalid_reply',
          message: p.error.issues[0]?.message ?? 'schema',
          retry: true,
        };
      return { ok: true, raw, reply: p.data };
    } catch (e) {
      if (ctl.signal.aborted)
        return { ok: false, status: 'timeout', message: `no reply in ${ms} ms`, retry: false };
      return { ok: false, status: 'network', message: String(e), retry: true };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async segment(prompts, frames, opts) {
      const t0 = performance.now();
      const left = () => opts.timeoutMs - (performance.now() - t0);
      const body = JSON.stringify({
        prompts,
        frames: frames.map((f) => Buffer.from(f).toString('base64')),
        prompt_frame: opts.promptFrame ?? 0,
        masks: opts.masks ?? true,
      });
      st.calls++;
      let tries = 0;
      let r: Try;
      for (;;) {
        tries++;
        r = await once(body, Math.max(1, Math.floor(left())));
        if (r.ok || !r.retry || tries >= 2 || left() < MIN_RETRY_MS) break;
        o.log.warn('sam.retry', { status: r.status, message: scrub(r.message) });
      }
      const ms = Math.round(performance.now() - t0);
      if (r.ok) {
        st.lastOkAt = now();
        st.lastOkMs = ms;
        o.log.info('sam.segment', { prompts: prompts.length, frames: frames.length, ms, tries });
        return { ok: true, raw: r.raw, reply: r.reply, ms, tries };
      }
      const message = scrub(r.message);
      st.failures++;
      st.lastErrAt = now();
      st.lastErr = `${r.status}: ${message}`.slice(0, 160);
      o.log.warn('sam.failed', { status: r.status, message, ms, tries });
      return { ok: false, status: r.status, message, ms, tries };
    },

    warm() {
      st.lastWarmAt = now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), WARM_TIMEOUT_MS);
      timer.unref?.();
      void doFetch(`${base}/health`, { signal: ctl.signal })
        .then(async (res) => {
          await res.text().catch(() => '');
          o.log.info('sam.warm', { status: res.status });
        })
        .catch((e: unknown) => o.log.warn('sam.warm_failed', { message: scrub(String(e)) }))
        .finally(() => clearTimeout(timer));
    },

    stats() {
      return {
        calls: st.calls,
        failures: st.failures,
        last_ok_at: iso(st.lastOkAt),
        last_ok_ms: st.lastOkMs,
        last_error_at: iso(st.lastErrAt),
        last_error: st.lastErr,
        last_warm_at: iso(st.lastWarmAt),
      };
    },
  };
}
