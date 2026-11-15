// Stage WebSocket client (API-CONTRACT §1.3 stage auth, §3.1–§3.3):
//   1. POST /v1/stage/session {stage_key, room_id} -> a stage token (scope `stage`, read-only
//      fan-out for one room). PENDING: the server route is not built yet (server stream); the
//      page also accepts a pasted token.
//   2. wss://<host>/v1/ws, first frame `hello {token}` (never the token in the URL), then
//      `subscribe_room {room_id}`: presence frames, stage.* and every bet in the room.
//   3. `pong {t}` to every `ping`; dead after 45 s of silence; reconnect with 0.25→5 s backoff
//      plus jitter. 4401 (bad token) and 4403 (not this room) are final: no reconnect.
import {
  WS_CLIENT_DEAD_MS,
  WS_CLOSE,
  WS_PATH,
  WS_RECONNECT_BACKOFF_MS,
  type WsClientFrameInput,
} from '@youre-on/shared/api';
import type { TickerAction } from './ticker';

export const STAGE_SESSION_PATH = '/v1/stage/session';

export interface StageConfig {
  /** https://<app>.fly.dev (or http://localhost:8080 in dev). */
  serverUrl: string;
  roomId: string;
  /** Either a ready stage token or the STAGE_KEY to exchange for one. */
  token?: string;
  stageKey?: string;
}

export function wsUrlFor(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = WS_PATH;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** §1.3: exchange STAGE_KEY for a stage token. The response shape is not pinned in the spec; `token` is read. */
export async function fetchStageToken(
  cfg: Pick<StageConfig, 'serverUrl' | 'roomId' | 'stageKey'>,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  const res = await doFetch(new URL(STAGE_SESSION_PATH, cfg.serverUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage_key: cfg.stageKey, room_id: cfg.roomId }),
  });
  const body = (await res.json().catch(() => null)) as {
    token?: unknown;
    error?: { code?: string };
  } | null;
  if (!res.ok || typeof body?.token !== 'string')
    throw new Error(
      `stage session failed: HTTP ${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}`,
    );
  return body.token;
}

/** Minimal WebSocket surface (the browser's, or a fake in tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

export interface StageConnectionOptions {
  wsUrl: string;
  token: string;
  roomId: string;
  onAction: (a: TickerAction) => void;
  makeSocket?: WsFactory;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class StageConnection {
  private ws: WsLike | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: unknown = null;
  private deadTimer: unknown = null;
  private readonly o: Required<Omit<StageConnectionOptions, 'makeSocket'>> & {
    makeSocket: WsFactory;
  };

  constructor(opts: StageConnectionOptions) {
    this.o = {
      makeSocket: opts.makeSocket ?? ((u) => new WebSocket(u) as unknown as WsLike),
      now: Date.now,
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) this.o.clearTimer(this.reconnectTimer);
    if (this.deadTimer) this.o.clearTimer(this.deadTimer);
    this.ws?.close(1000, 'stage closed');
    this.ws = null;
    this.o.onAction({ kind: 'status', status: 'closed' });
  }

  /** ms before reconnect attempt n (0-based): the §3.3 ladder plus up to 25 % jitter. */
  backoff(n: number): number {
    const base = WS_RECONNECT_BACKOFF_MS[Math.min(n, WS_RECONNECT_BACKOFF_MS.length - 1)]!;
    return Math.round(base * (1 + 0.25 * this.o.random()));
  }

  private send(frame: WsClientFrameInput) {
    this.ws?.send(JSON.stringify(frame));
  }

  /**
   * §3.3: no frame for 45 s means dead. A browser's close() on a dead TCP connection can wait a
   * long time for the closing handshake before `onclose` fires, so the socket is abandoned here
   * and the reconnect is scheduled at once instead of waiting for that event.
   */
  private armDeadTimer() {
    if (this.deadTimer) this.o.clearTimer(this.deadTimer);
    this.deadTimer = this.o.setTimer(() => {
      const ws = this.ws;
      if (!ws) return;
      try {
        ws.close(4000, 'no frames for 45 s');
      } catch {
        // already closing
      }
      this.closed(ws, 4000);
    }, WS_CLIENT_DEAD_MS);
  }

  private closed(ws: WsLike, code: number) {
    if (this.deadTimer) this.o.clearTimer(this.deadTimer);
    if (this.ws !== ws) return;
    this.ws = null;
    this.o.onAction({ kind: 'status', status: 'closed', closeCode: code });
    if (this.stopped) return;
    if (code === WS_CLOSE.UNAUTHORIZED || code === WS_CLOSE.FORBIDDEN) {
      this.o.onAction({
        kind: 'error',
        message:
          code === WS_CLOSE.UNAUTHORIZED
            ? 'stage token rejected (4401)'
            : 'not allowed in this room (4403)',
      });
      return;
    }
    const wait = this.backoff(this.attempt++);
    this.reconnectTimer = this.o.setTimer(() => this.open(), wait);
  }

  private open() {
    this.o.onAction({ kind: 'status', status: 'connecting' });
    const ws = this.o.makeSocket(this.o.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ op: 'hello', token: this.o.token, subs: [] });
      this.send({ op: 'subscribe_room', room_id: this.o.roomId });
      this.armDeadTimer();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return; // an abandoned (dead) socket
      this.armDeadTimer();
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        this.o.onAction({ kind: 'error', message: 'non-JSON frame dropped' });
        return;
      }
      const op = (raw as { op?: unknown } | null)?.op;
      if (op === 'welcome') this.attempt = 0;
      if (op === 'ping') this.send({ op: 'pong', t: (raw as { t: number }).t });
      this.o.onAction({ kind: 'frame', raw, receivedAt: this.o.now() });
    };
    ws.onerror = () => this.o.onAction({ kind: 'error', message: 'socket error' });
    ws.onclose = (ev) => this.closed(ws, ev.code);
  }
}
