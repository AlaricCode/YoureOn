// Realtime client (API-CONTRACT §3): one socket to /v1/ws.
//   open -> hello {token, device_id, app_version, subs:[{bet_id, after_seq}]} (within 5 s)
//   welcome -> live (clock offset from server_time); ping -> pong; frames with `op` are control
//   frames, bare envelopes go through parseRealtimeEvent (drop failures with a log line).
//   No frame for 45 s -> dead; reconnect with 0.25 -> 0.5 -> 1 -> 2 -> 5 s backoff + jitter and
//   resend hello with each bet's after_seq = last applied seq (the server replays the gap).
//   Close 4401 -> the token is bad: ask for a fresh session before reconnecting.
//
// Plus the per-bet sequencer (§3.3): apply in seq order, drop seq <= last_seen, buffer a gap up
// to 2 s, then ask for REST resync (GET /v1/bets/:id/events?after=last_seen) and drain.
// Pure TS (socket constructor and timers injected): tested in node.
import {
  WS_CLIENT_DEAD_MS,
  WS_CLOSE,
  WS_PATH,
  WS_RECONNECT_BACKOFF_MS,
  WsServerControlFrame,
  type WsClientFrameInput,
} from '@youre-on/shared/api';
import { parseRealtimeEvent, type RealtimeEvent } from '@youre-on/shared/realtime';

// ---------------------------------------------------------------------------------------
// Sequencer (pure)
// ---------------------------------------------------------------------------------------

export const GAP_WAIT_MS = 2_000;

export interface SeqState {
  lastSeq: number;
  /** Out-of-order events waiting for the gap to fill, keyed by seq. */
  buffer: ReadonlyMap<number, RealtimeEvent>;
  /** When the current gap opened (ms), or null. */
  gapSince: number | null;
}

export const initialSeq = (lastSeq = 0): SeqState => ({
  lastSeq,
  buffer: new Map(),
  gapSince: null,
});

/** Feeds one event; returns the events now applicable, in order. */
export function ingest(
  s: SeqState,
  e: RealtimeEvent,
  nowMs: number,
): { state: SeqState; apply: RealtimeEvent[] } {
  if (e.seq <= s.lastSeq || s.buffer.has(e.seq)) return { state: s, apply: [] };
  const buffer = new Map(s.buffer);
  buffer.set(e.seq, e);
  return drain({ lastSeq: s.lastSeq, buffer, gapSince: s.gapSince }, nowMs);
}

function drain(s: SeqState, nowMs: number): { state: SeqState; apply: RealtimeEvent[] } {
  const buffer = new Map(s.buffer);
  const apply: RealtimeEvent[] = [];
  let last = s.lastSeq;
  for (let next = buffer.get(last + 1); next; next = buffer.get(last + 1)) {
    apply.push(next);
    buffer.delete(last + 1);
    last += 1;
  }
  const gapSince = buffer.size === 0 ? null : apply.length > 0 ? nowMs : (s.gapSince ?? nowMs);
  return { state: { lastSeq: last, buffer, gapSince }, apply };
}

/** True once a gap has stayed open for GAP_WAIT_MS: time to call the events endpoint. */
export const needsResync = (s: SeqState, nowMs: number): boolean =>
  s.gapSince !== null && nowMs - s.gapSince >= GAP_WAIT_MS;

/** After a REST snapshot at `lastSeq` (cold start / resync): drop what it covers, drain the rest. */
export function resetTo(
  s: SeqState,
  lastSeq: number,
  nowMs: number,
): { state: SeqState; apply: RealtimeEvent[] } {
  if (lastSeq <= s.lastSeq) return { state: s, apply: [] };
  const buffer = new Map([...s.buffer].filter(([k]) => k > lastSeq));
  return drain({ lastSeq, buffer, gapSince: null }, nowMs);
}

// ---------------------------------------------------------------------------------------
// Socket client
// ---------------------------------------------------------------------------------------

/** jittered backoff: step `attempt` of WS_RECONNECT_BACKOFF_MS, plus up to 30 % jitter. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const steps = WS_RECONNECT_BACKOFF_MS;
  const base = steps[Math.min(attempt, steps.length - 1)] as number;
  return Math.round(base + base * 0.3 * random());
}

export const wsUrlFor = (httpBase: string): string =>
  httpBase.replace(/\/+$/, '').replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`) + WS_PATH;

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'stopped';

export interface TimerApi {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface RealtimeClientDeps {
  url: string;
  createSocket(url: string): SocketLike;
  /** Current credentials; null = signed out (stay idle). */
  hello(): { token: string; device_id: string; app_version: string } | null;
  /** The after_seq to resume each subscribed bet from. */
  lastSeq(betId: string): number;
  onEvent(e: RealtimeEvent): void;
  onControl?(f: WsServerControlFrame): void;
  onStatus?(s: WsStatus): void;
  /** Called on close 4401; resolve true when a new session is ready (reconnect then). */
  onUnauthorized?(): Promise<boolean>;
  timers?: TimerApi;
  random?: () => number;
  log?: (msg: string, extra?: unknown) => void;
}

export interface RealtimeClient {
  start(): void;
  stop(): void;
  subscribe(betId: string): void;
  unsubscribe(betId: string): void;
  subscribeRoom(roomId: string | null): void;
  readonly status: WsStatus;
}

const OPEN = 1;

export function createRealtimeClient(d: RealtimeClientDeps): RealtimeClient {
  const timers: TimerApi = d.timers ?? {
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const random = d.random ?? Math.random;
  const log = d.log ?? (() => undefined);
  const bets = new Set<string>();
  let room: string | null = null;
  let ws: SocketLike | null = null;
  let status: WsStatus = 'idle';
  let attempt = 0;
  let deadTimer: unknown = null;
  let retryTimer: unknown = null;
  let running = false;

  const setStatus = (s: WsStatus) => {
    if (s === status) return;
    status = s;
    d.onStatus?.(s);
  };
  const send = (f: WsClientFrameInput) => {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(f));
  };
  const armDead = () => {
    if (deadTimer !== null) timers.clearTimeout(deadTimer);
    deadTimer = timers.setTimeout(() => {
      log('ws.dead');
      ws?.close(4000, 'dead');
      drop();
    }, WS_CLIENT_DEAD_MS);
  };
  const clearTimers = () => {
    if (deadTimer !== null) timers.clearTimeout(deadTimer);
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    deadTimer = retryTimer = null;
  };

  const drop = () => {
    const old = ws;
    ws = null;
    if (old) old.onopen = old.onmessage = old.onclose = old.onerror = null;
    clearTimers();
    if (!running) return;
    setStatus('reconnecting');
    retryTimer = timers.setTimeout(connect, reconnectDelay(attempt++, random));
  };

  function connect() {
    retryTimer = null;
    if (!running) return;
    const creds = d.hello();
    if (!creds) {
      setStatus('idle');
      return;
    }
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const sock = d.createSocket(d.url);
    ws = sock;
    sock.onopen = () => {
      send({
        op: 'hello',
        token: creds.token,
        device_id: creds.device_id,
        app_version: creds.app_version,
        subs: [...bets].map((bet_id) => ({ bet_id, after_seq: d.lastSeq(bet_id) })),
      });
      if (room) send({ op: 'subscribe_room', room_id: room });
      armDead();
    };
    sock.onmessage = (ev) => {
      armDead();
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        log('ws.bad_json');
        return;
      }
      if (raw !== null && typeof raw === 'object' && 'op' in raw) {
        const c = WsServerControlFrame.safeParse(raw);
        if (!c.success) {
          log('ws.unknown_control', (raw as { op?: unknown }).op);
          return;
        }
        if (c.data.op === 'ping') send({ op: 'pong', t: c.data.t });
        if (c.data.op === 'welcome') {
          attempt = 0;
          setStatus('live');
        }
        d.onControl?.(c.data);
        return;
      }
      const p = parseRealtimeEvent(raw);
      if (!p.ok) {
        log('ws.drop_event', (raw as { type?: unknown } | null)?.type);
        return;
      }
      d.onEvent(p.event);
    };
    sock.onerror = () => log('ws.error');
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      if (ev.code === WS_CLOSE.UNAUTHORIZED && d.onUnauthorized) {
        ws = null;
        clearTimers();
        setStatus('unauthorized');
        void d.onUnauthorized().then(
          (ok) => {
            if (ok && running) connect();
          },
          () => undefined,
        );
        return;
      }
      drop();
    };
  }

  return {
    get status() {
      return status;
    },
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      connect();
    },
    stop() {
      running = false;
      const old = ws;
      ws = null;
      clearTimers();
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        old.close(1000, 'bye');
      }
      setStatus('stopped');
    },
    subscribe(betId) {
      if (bets.has(betId)) return;
      bets.add(betId);
      send({ op: 'subscribe', bet_id: betId, after_seq: d.lastSeq(betId) });
    },
    unsubscribe(betId) {
      if (!bets.delete(betId)) return;
      send({ op: 'unsubscribe', bet_id: betId });
    },
    subscribeRoom(roomId) {
      room = roomId;
      if (roomId) send({ op: 'subscribe_room', room_id: roomId });
    },
  };
}
