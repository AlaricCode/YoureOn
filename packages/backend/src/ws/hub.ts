/**
 * §12.4 WebSocket hub: `GET {API}/v1/ws?token=…`.
 *  - Topics: "user", "bet:<id>", "huddle:<id>", "world:<event_id>".
 *  - On subscribe, the registered snapshot provider for the topic kind sends
 *    the current state immediately (bet / huddle + draft / world price).
 *  - `{"type":"ping"}` ⇒ `{"type":"pong"}`; the server closes a socket after
 *    60 s of silence. Clients re-subscribe on reconnect.
 *  - `scene.frame` and `recording` are dispatched to handlers registered by
 *    service modules (scene check, record).
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { errorBody, toApiError } from '../errors.js';
import type { Clock } from '../util/clock.js';
import { systemClock } from '../util/clock.js';
import { jsonReplacer } from '../util/bytes.js';
import {
  isTopic,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type Topic,
} from './messages.js';

export const WS_PATH = '/v1/ws';
export const WS_IDLE_TIMEOUT_MS = 60_000;
export const WS_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Close code for idle timeout (application range). */
export const WS_CLOSE_IDLE = 4000;

export interface WsConnection {
  readonly id: number;
  readonly userId: string;
  readonly topics: ReadonlySet<string>;
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

export type TopicKind = 'user' | 'bet' | 'huddle' | 'world';

/**
 * Returns the snapshot messages for `id` as seen by `userId`; throw an
 * ApiError (e.g. NOT_FOUND) to refuse the subscription.
 */
export type SnapshotProvider = (id: string, userId: string) => Promise<ServerMessage[]> | ServerMessage[];

type MessageHandler<T extends ClientMessage['type']> = (
  conn: WsConnection,
  msg: Extract<ClientMessage, { type: T }>,
) => void | Promise<void>;

export interface WsHubOptions {
  /** Resolves a bearer token to a user id (null ⇒ 401). */
  authenticate: (token: string) => Promise<string | null> | string | null;
  clock?: Clock;
  idleTimeoutMs?: number;
  /** how often to sweep idle sockets */
  sweepIntervalMs?: number;
  log?: { warn: (o: unknown, msg?: string) => void };
}

interface Conn extends WsConnection {
  socket: WebSocket;
  lastSeenMs: number;
  topics: Set<string>;
}

export function topicKind(t: Topic): { kind: TopicKind; id: string } {
  if (t === 'user') return { kind: 'user', id: '' };
  const i = t.indexOf(':');
  return { kind: t.slice(0, i) as TopicKind, id: t.slice(i + 1) };
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<number, Conn>();
  private readonly snapshots = new Map<TopicKind, SnapshotProvider>();
  private readonly handlers = new Map<string, (conn: WsConnection, msg: ClientMessage) => void | Promise<void>>();
  private readonly clock: Clock;
  private readonly idleMs: number;
  private sweep: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(private readonly opts: WsHubOptions) {
    this.clock = opts.clock ?? systemClock;
    this.idleMs = opts.idleTimeoutMs ?? WS_IDLE_TIMEOUT_MS;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES });
  }

  /** Hooks the HTTP server's upgrade event for `WS_PATH`. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    const every = this.opts.sweepIntervalMs ?? Math.min(5_000, this.idleMs);
    this.sweep = setInterval(() => this.sweepIdle(), every);
    this.sweep.unref();
  }

  setSnapshotProvider(kind: TopicKind, p: SnapshotProvider): void {
    this.snapshots.set(kind, p);
  }

  onMessage<T extends 'scene.frame' | 'recording'>(type: T, h: MessageHandler<T>): void {
    this.handlers.set(type, h as unknown as (conn: WsConnection, msg: ClientMessage) => void | Promise<void>);
  }

  /** Sends to every socket subscribed to `topic`. "user" topics are addressed with publishToUser. */
  publish(topic: Topic, msg: ServerMessage): number {
    const data = encode(msg);
    let n = 0;
    for (const c of this.conns.values()) {
      if (c.topics.has(topic) && c.socket.readyState === WebSocket.OPEN) {
        c.socket.send(data);
        n++;
      }
    }
    return n;
  }

  /**
   * Sends a per-viewer message to every socket subscribed to `topic` (e.g. a
   * BetView, whose my_index/state_label depend on the user). `build` runs once
   * per distinct user; a null result or a throw skips that user.
   */
  async publishPerUser(topic: Topic, build: (userId: string) => Promise<ServerMessage | null> | ServerMessage | null): Promise<number> {
    const byUser = new Map<string, Conn[]>();
    for (const c of this.conns.values()) {
      if (c.topics.has(topic) && c.socket.readyState === WebSocket.OPEN) byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
    }
    let n = 0;
    for (const [userId, conns] of byUser) {
      let msg: ServerMessage | null;
      try {
        msg = await build(userId);
      } catch {
        msg = null;
      }
      if (!msg) continue;
      const data = encode(msg);
      for (const c of conns) {
        if (c.socket.readyState !== WebSocket.OPEN) continue;
        c.socket.send(data);
        n++;
      }
    }
    return n;
  }

  /** Sends to every socket of `userId` subscribed to "user". */
  publishToUser(userId: string, msg: ServerMessage): number {
    const data = encode(msg);
    let n = 0;
    for (const c of this.conns.values()) {
      if (c.userId === userId && c.topics.has('user') && c.socket.readyState === WebSocket.OPEN) {
        c.socket.send(data);
        n++;
      }
    }
    return n;
  }

  /** WS `notify` (§12.4, D-29): title ≤ 3 words. */
  notify(userId: string, title: string, betId: string | null): number {
    return this.publishToUser(userId, { type: 'notify', title, bet_id: betId });
  }

  connectionCount(): number {
    return this.conns.size;
  }

  sweepIdle(): void {
    const now = this.clock.nowMs();
    for (const c of this.conns.values()) {
      if (now - c.lastSeenMs > this.idleMs) c.close(WS_CLOSE_IDLE, 'idle');
    }
  }

  async close(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const c of this.conns.values()) c.socket.terminate();
    this.conns.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  // ---- internals ---------------------------------------------------------------

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) return; // other upgrade handlers may own it
    const token = url.searchParams.get('token') ?? bearer(req.headers.authorization);
    let userId: string | null = null;
    try {
      userId = token ? await this.opts.authenticate(token) : null;
    } catch {
      userId = null;
    }
    if (!userId) {
      const body = JSON.stringify(errorBody('UNAUTHORIZED'));
      socket.end(
        `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    const uid = userId;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, uid));
  }

  private register(socket: WebSocket, userId: string): void {
    const id = this.nextId++;
    const conn: Conn = {
      id,
      userId,
      socket,
      topics: new Set(),
      lastSeenMs: this.clock.nowMs(),
      send: (msg) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encode(msg));
      },
      close: (code, reason) => {
        this.conns.delete(id);
        socket.close(code, reason);
      },
    };
    this.conns.set(id, conn);
    socket.on('message', (data, isBinary) => {
      conn.lastSeenMs = this.clock.nowMs();
      if (isBinary) return;
      void this.onClientMessage(conn, data.toString());
    });
    socket.on('pong', () => {
      conn.lastSeenMs = this.clock.nowMs();
    });
    socket.on('close', () => this.conns.delete(id));
    socket.on('error', () => this.conns.delete(id));
  }

  private async onClientMessage(conn: Conn, raw: string): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) {
      conn.send({ type: 'error', error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    try {
      switch (msg.type) {
        case 'ping':
          conn.send({ type: 'pong' });
          return;
        case 'subscribe':
          for (const t of msg.topics) await this.subscribe(conn, t);
          return;
        case 'unsubscribe':
          for (const t of msg.topics) conn.topics.delete(t);
          return;
        default: {
          const h = this.handlers.get(msg.type);
          if (h) await h(conn, msg);
        }
      }
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'INTERNAL') this.opts.log?.warn({ err: e }, 'ws handler failed');
      conn.send({ type: 'error', error: errorBody(err.code).error });
    }
  }

  private async subscribe(conn: Conn, t: string): Promise<void> {
    if (!isTopic(t)) {
      conn.send({ type: 'error', error: errorBody('NOT_FOUND').error });
      return;
    }
    const { kind, id } = topicKind(t);
    const provider = this.snapshots.get(kind);
    let snaps: ServerMessage[] = [];
    try {
      snaps = provider ? await provider(id, conn.userId) : [];
    } catch (e) {
      // Refused (e.g. NOT_FOUND): report and keep processing the other topics.
      const err = toApiError(e);
      if (err.code === 'INTERNAL') this.opts.log?.warn({ err: e }, 'ws snapshot failed');
      conn.send({ type: 'error', error: errorBody(err.code).error });
      return;
    }
    conn.topics.add(t);
    for (const s of snaps) conn.send(s);
  }
}

function bearer(h: string | undefined): string | null {
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

function encode(msg: ServerMessage): string {
  return JSON.stringify(msg, jsonReplacer);
}
