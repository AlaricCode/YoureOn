// Shared by the mock and live LLM providers so both produce identical ChatResults: JSON
// extraction from model text, enum upper-casing, zod validation, and a hard per-call deadline.
//
// firstJson is ported from Verdict packages/backend/src/providers/real/boothLlm.ts.
import type { ChatResult, ChatVendor, StructuredOutput } from './types';

/** Panel seats (API-CONTRACT §7.2); also the default model per vendor. */
export const DEFAULT_CHAT_MODELS: Record<ChatVendor, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6.1-terra',
  google: 'gemini-3.8-flash',
};

/** Per-call deadline: the appeals panel's per-vote cap (API-CONTRACT §7.2: 8 s). */
export const CHAT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** The first JSON object in model text; tolerates code fences and prose around it. */
export function firstJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no JSON object in model output');
  return JSON.parse(body.slice(s, e + 1));
}

function upperCaseFields(raw: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'string') out[f] = v.trim().toUpperCase();
  }
  return out;
}

/** Model text -> validated value, or why not. */
export function parseStructured<T>(
  text: string,
  out: StructuredOutput<T>,
): { ok: true; value: T } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = firstJson(text);
  } catch (e) {
    return { ok: false, message: `${out.name}: ${(e as Error).message}` };
  }
  const r = out.schema.safeParse(upperCaseFields(raw, out.upperCase));
  if (!r.success) {
    const issues = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, message: `${out.name} failed validation: ${issues.join('; ')}` };
  }
  return { ok: true, value: r.data };
}

/** Builds the ChatResult for model text that came back from a vendor. */
export function resultFromText<T>(
  base: { vendor: ChatVendor; model: string; latency_ms: number },
  text: string,
  out: StructuredOutput<T>,
): ChatResult<T> {
  const p = parseStructured(text, out);
  return p.ok
    ? { ...base, ok: true, value: p.value, text }
    : { ...base, ok: false, status: 'invalid_output', message: p.message, text };
}

export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`deadline of ${ms} ms exceeded`);
    this.name = 'DeadlineError';
  }
}

/**
 * Runs `fn` with an AbortSignal that fires at `ms` (or when `outer` aborts), and rejects with
 * DeadlineError at `ms` even if `fn` ignores the signal. SDK retries are off (maxRetries 0),
 * so this bounds the wall time (API-CONTRACT §7.1).
 */
export async function withDeadline<R>(
  ms: number,
  outer: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<R>,
): Promise<R> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onOuter = () => ctl.abort(outer?.reason);
  if (outer?.aborted) ctl.abort(outer.reason);
  else outer?.addEventListener('abort', onOuter, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineError(ms);
      ctl.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), deadline]);
  } catch (e) {
    // An SDK abort error caused by our timer is a timeout, whatever class the SDK threw.
    if (ctl.signal.reason instanceof DeadlineError) throw ctl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}
