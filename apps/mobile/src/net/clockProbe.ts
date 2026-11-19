// A round-trip-compensated server clock offset (NTP style), for the two-phone Dance Off
// (../dance/model/schedule): both phones map the attempt's go_at onto their own clocks, so they
// agree only as well as their offsets do. The app Clock (./signedFetch) takes ONE sample at a
// time with its one-way latency uncorrected (the socket welcome, the login, a CLOCK_SKEW): good
// enough for signing (±30 s), off by tens to hundreds of ms on cellular. This probes GET /health
// (server_time, no DB call) a few times and keeps the sample with the smallest round trip:
//
//   offset = server_time − (sent + received) / 2       error ≤ rtt / 2 (the asymmetry)
//
// It never touches the app Clock; the dance screens use it in place of Clock.offsetMs while it
// is fresh. Pure TS (fetch and clock injected): tested in node.
import type { FetchLike } from './signedFetch';

export interface ClockSample {
  /** Date.now() when the request went out. */
  sentAt: number;
  /** Date.now() when the response was read. */
  receivedAt: number;
  /** The server's server_time (epoch ms). */
  serverMs: number;
}

export interface OffsetEstimate {
  /** Server time − Date.now(), as Clock.offsetMs. */
  offsetMs: number;
  /** The round trip of the sample it came from: the estimate is within rttMs / 2. */
  rttMs: number;
}

/** A sample slower than this says nothing useful about the offset. */
export const PROBE_MAX_RTT_MS = 2_000;
export const PROBE_COUNT = 5;
const PROBE_GAP_MS = 60;

/** The minimum-RTT sample's midpoint offset, or null when no sample is usable. */
export function bestOffset(samples: readonly ClockSample[]): OffsetEstimate | null {
  let best: OffsetEstimate | null = null;
  for (const s of samples) {
    const rtt = s.receivedAt - s.sentAt;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > PROBE_MAX_RTT_MS) continue;
    if (!Number.isFinite(s.serverMs)) continue;
    if (best === null || rtt < best.rttMs)
      best = { offsetMs: Math.round(s.serverMs - (s.sentAt + s.receivedAt) / 2), rttMs: rtt };
  }
  return best;
}

/** server_time from a GET /health body, or null. */
export function healthServerMs(body: string): number | null {
  try {
    const t = (JSON.parse(body) as { server_time?: unknown }).server_time;
    const ms = typeof t === 'string' ? Date.parse(t) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Probes `${baseUrl}/health` `count` times, one at a time; null when none answered. */
export async function probeServerOffset(p: {
  baseUrl: string;
  fetch: FetchLike;
  now?: () => number;
  count?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<OffsetEstimate | null> {
  const now = p.now ?? Date.now;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${p.baseUrl.replace(/\/+$/, '')}/health`;
  const samples: ClockSample[] = [];
  for (let i = 0; i < (p.count ?? PROBE_COUNT); i++) {
    if (i > 0) await sleep(PROBE_GAP_MS);
    try {
      const sentAt = now();
      const res = await p.fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
      const body = await res.text();
      const receivedAt = now();
      const serverMs = res.status === 200 ? healthServerMs(body) : null;
      if (serverMs !== null) samples.push({ sentAt, receivedAt, serverMs });
    } catch {
      // One lost probe: the others decide.
    }
  }
  return bestOffset(samples);
}
