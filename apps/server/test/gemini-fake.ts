// A fake Gemini REST server for the markets tests, answering from real recorded responses
// (fixtures/gemini-btc5m.json). Routes can be swapped per test; every call is logged.
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

export const GEMINI_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/gemini-btc5m.json', import.meta.url), 'utf8'),
) as {
  events_0237: { data: Json[] };
  events_0241: { data: Json[] };
  event_0240_active: Json;
  event_0240_settled: Json;
  event_0245_active: Json;
  strike_0245_pending: Json;
  strike_0240_known: Json;
  btcusd: Json;
};

export const T0237 = Date.parse('2026-11-18T02:37:10.000Z');
export const T0241 = Date.parse('2026-11-18T02:41:57.000Z');

export interface FakeGemini {
  fetch: typeof fetch;
  calls: string[];
  /** path (no host) -> body, or a number for an HTTP error, or 'throw' for a network error. */
  routes: Map<string, unknown>;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function fakeGemini(initial: Record<string, unknown> = {}): FakeGemini {
  const routes = new Map<string, unknown>(Object.entries(initial));
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const path = url.pathname + url.search;
    calls.push(path);
    const body = routes.get(path) ?? routes.get(url.pathname);
    if (body === undefined) return new Response('{"error":"not found"}', { status: 404 });
    if (body === 'throw') throw new TypeError('fetch failed');
    if (typeof body === 'number') return new Response('{}', { status: body });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: f, calls, routes };
}

export const EVENTS_PATH = '/v1/prediction-markets/events?status=active&category=Crypto&limit=200';
export const eventPath = (t: string) => `/v1/prediction-markets/events/${t}`;
export const strikePath = (t: string) => `/v1/prediction-markets/events/${t}/strike`;
export const TICKER_PATH = '/v1/pubticker/btcusd';
