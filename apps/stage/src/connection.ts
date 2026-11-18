// Stage WebSocket client (API-CONTRACT §1.3 stage auth, §3.1–§3.3):
//   1. POST /v1/stage/session {stage_key, room_id | room_code} -> a stage token (scope `stage`,
//      read-only fan-out for one room) and the room's uuid. The page also accepts a pasted token.
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
import { BetSnapshot } from '@youre-on/shared/api';
import { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { SettlementEvidence, settlementPath } from '@youre-on/shared/settlement';
import { z } from 'zod/v4';
import type { TickerAction } from './ticker';

export const STAGE_SESSION_PATH = '/v1/stage/session';

export interface StageConfig {
  /** The API origin; the page that the server itself serves uses its own origin. */
  serverUrl: string;
  /** The room's uuid, or its 6-char code (exchanged with the stage key for the uuid). */
  roomId: string;
  /** Either a ready stage token or the STAGE_KEY to exchange for one. */
  token?: string;
  stageKey?: string;
  /** Optional: a bet already in progress, replayed from seq 0 on connect (cold start). */
  betId?: string;
}

/** GET with the stage bearer; throws `HTTP <status> <code>` on failure. */
export async function getJson(
  serverUrl: string,
  path: string,
  token: string,
  doFetch: typeof fetch = fetch,
): Promise<unknown> {
  const res = await doFetch(new URL(path, serverUrl).toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  if (!res.ok)
    throw new Error(
      `GET ${path}: HTTP ${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}`,
    );
  return body;
}

/** §2.14 GET /v1/bets/:id (stage scope: bets of its room). */
export async function fetchBetSnapshot(
  serverUrl: string,
  token: string,
  betId: string,
  doFetch: typeof fetch = fetch,
): Promise<BetSnapshot> {
  return BetSnapshot.parse(
    await getJson(serverUrl, `/v1/bets/${encodeURIComponent(betId)}`, token, doFetch),
  );
}

/** GET /v1/bets/:id/attempts/:n/frames/:idx (apps/server/src/stage/routes.ts): one JPEG. */
export const framePath = (betId: string, attemptNo: number, idx: number) =>
  `/v1/bets/${encodeURIComponent(betId)}/attempts/${attemptNo}/frames/${idx}`;

/** An evidence frame with the stage bearer (an <img> cannot send one), as a Blob. */
export async function fetchFrame(
  serverUrl: string,
  token: string,
  betId: string,
  attemptNo: number,
  idx: number,
  doFetch: typeof fetch = fetch,
): Promise<Blob> {
  const res = await doFetch(new URL(framePath(betId, attemptNo, idx), serverUrl).toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`frame ${idx}: HTTP ${res.status}`);
  return res.blob();
}

const MarketCurrentLite = z.object({ market: GeminiMarketSnapshot.nullable() });

/** §2.13 GET /v1/markets/btc5m/current: the odds widget's first frame before stage.market. */
export async function fetchMarket(
  serverUrl: string,
  token: string,
  doFetch: typeof fetch = fetch,
): Promise<GeminiMarketSnapshot | null> {
  return MarketCurrentLite.parse(
    await getJson(serverUrl, '/v1/markets/btc5m/current', token, doFetch),
  ).market;
}

/**
 * Beat 6: GET /v1/bets/:id/settlement, the Gemini evidence chain with the server's checks; the
 * stage re-runs the shared verifySettlement itself before it shows "verified".
 */
export async function fetchSettlement(
  serverUrl: string,
  token: string,
  betId: string,
  doFetch: typeof fetch = fetch,
): Promise<SettlementEvidence> {
  return SettlementEvidence.parse(await getJson(serverUrl, settlementPath(betId), token, doFetch));
}

export function wsUrlFor(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = WS_PATH;
  u.search = '';
  u.hash = '';
  return u.toString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StageSession {
  token: string;
  /** The room's uuid (what subscribe_room needs), also when a code was given. */
  room_id: string;
  expires_at: string | null;
  scopes: string[];
  /** Who signs the lock (LOCK_SIGNER); null from an older server. */
  lock_signer: 'phones' | 'server' | null;
}

/**
 * §1.3: exchange STAGE_KEY for a stage token. A uuid goes as `room_id`; anything else is a room
 * code (or its youreon://room/ QR payload) and goes as `room_code`.
 */
export async function openStageSession(
  cfg: Pick<StageConfig, 'serverUrl' | 'roomId' | 'stageKey'>,
  doFetch: typeof fetch = fetch,
): Promise<StageSession> {
  const room = cfg.roomId.trim();
  const res = await doFetch(new URL(STAGE_SESSION_PATH, cfg.serverUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      UUID_RE.test(room)
        ? { stage_key: cfg.stageKey, room_id: room }
        : { stage_key: cfg.stageKey, room_code: room },
    ),
  });
  const body = (await res.json().catch(() => null)) as {
    token?: unknown;
    room_id?: unknown;
    expires_at?: unknown;
    scopes?: unknown;
    lock_signer?: unknown;
    error?: { code?: string };
  } | null;
  if (!res.ok || typeof body?.token !== 'string')
    throw new Error(
      `stage session failed: HTTP ${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}`,
    );
  return {
    token: body.token,
    room_id: typeof body.room_id === 'string' ? body.room_id : room,
    expires_at: typeof body.expires_at === 'string' ? body.expires_at : null,
    scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
    lock_signer:
      body.lock_signer === 'server' || body.lock_signer === 'phones' ? body.lock_signer : null,
  };
}

/** openStageSession's token only. */
export async function fetchStageToken(
  cfg: Pick<StageConfig, 'serverUrl' | 'roomId' | 'stageKey'>,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  return (await openStageSession(cfg, doFetch)).token;
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
  /** Bets to replay from `after_seq` in the hello (cold start / reconnect). */
  subs?: Array<{ bet_id: string; after_seq: number }>;
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
  private readonly o: Required<Omit<StageConnectionOptions, 'makeSocket' | 'subs'>> & {
    makeSocket: WsFactory;
  };
  /** bet_id -> last seq seen, so a reconnect resumes instead of replaying everything. */
  private readonly subs = new Map<string, number>();

  constructor(opts: StageConnectionOptions) {
    this.o = {
      makeSocket: opts.makeSocket ?? ((u) => new WebSocket(u) as unknown as WsLike),
      now: Date.now,
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...opts,
    };
    for (const s of opts.subs ?? []) this.subs.set(s.bet_id, s.after_seq);
  }

  /** Adds (or keeps) a bet subscription; sent now if open, and in every later hello. */
  subscribe(betId: string, afterSeq = 0): void {
    const known = this.subs.get(betId);
    if (known !== undefined) return;
    this.subs.set(betId, afterSeq);
    if (this.ws && this.ws.readyState === 1)
      this.send({ op: 'subscribe', bet_id: betId, after_seq: afterSeq });
  }

  /** Called with every event seq the page applied (keeps the resume point current). */
  noteSeq(betId: string, seq: number): void {
    const known = this.subs.get(betId);
    if (known !== undefined && seq > known) this.subs.set(betId, seq);
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
      this.send({
        op: 'hello',
        token: this.o.token,
        subs: [...this.subs].map(([bet_id, after_seq]) => ({ bet_id, after_seq })),
      });
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
