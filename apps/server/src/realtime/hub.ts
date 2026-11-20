// WebSocket hub: one process, in-memory fan-out.
// Spec: docs/planning/API-CONTRACT.md §3.
//
// Channels: user:<user_id> (auto on hello), bet:<bet_id> (subscribe), room:<room_id>
// (subscribe_room). Event frames are bare RealtimeEvent envelopes (no `op`); control frames
// carry `op` and are not sequenced.
//
// Protocol (server side):
//  1. client `hello` within 5 s or close 4401; bad token -> 4401.
//  2. `welcome {server_time, heartbeat_ms, user_channel}`.
//  3. for each sub (hello.subs, then each `subscribe`): replay after_seq+1..last_seq from
//     bet_events, send `subscribed {bet_id, last_seq, replayed}`, then live. Live events that
//     arrive during the replay are buffered and flushed after it, deduped by seq.
//  4. `ping {t, server_time}` every 20 s; a socket with 2 unanswered pings is closed; a socket
//     whose send buffer exceeds 1 MB is closed (the client reconnects and resyncs).
import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';
import type { WebSocketLike } from '@hono/node-server';
import {
  WS_CLOSE,
  WS_HEARTBEAT_MS,
  WS_HELLO_TIMEOUT_MS,
  WS_MAX_BUFFERED_BYTES,
  WS_MAX_MISSED_PONGS,
  WsClientFrame,
  type WsServerControlFrame,
} from '@youre-on/shared/api';
import type { AuthContext } from '../context';
import type { Logger } from '../log';
import { silentLogger } from '../log';

/** What the hub needs to know about a bet event: the envelope is otherwise opaque here. */
export interface BetEnvelope {
  v: number;
  type: string;
  bet_id: string;
  seq: number;
  [k: string]: unknown;
}

export interface HubAccess {
  /** Resolves a hello token, or throws/returns null to reject (close 4401). */
  resolveToken(token: string): Promise<AuthContext | null>;
  /** May this session see bet_id? false -> close 4403. */
  canSeeBet(auth: AuthContext, betId: string): Promise<boolean>;
  /** May this session see room_id? false -> close 4403. */
  canSeeRoom(auth: AuthContext, roomId: string): Promise<boolean>;
  /**
   * Envelopes with seq > afterSeq in seq order (at most `limit`; the access's own cap when
   * omitted), and the bet's current last_seq.
   */
  replay(
    betId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<{ events: BetEnvelope[]; last_seq: number }>;
}

export interface HubOptions {
  access: HubAccess;
  now?: () => number;
  log?: Logger;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
  maxBufferedBytes?: number;
}

/** Close codes the hub uses that the spec does not number (it fixes only 4401 and 4403). */
export const HUB_CLOSE = {
  HEARTBEAT_TIMEOUT: 4408,
  BACKPRESSURE: 4413,
  SHUTDOWN: 1001,
} as const;

type Ws = WSContext<WebSocketLike>;

interface Conn {
  id: number;
  ws: Ws;
  auth: AuthContext | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  missedPongs: number;
  bets: Set<string>;
  rooms: Set<string>;
  /** bet_id -> live envelopes received while that bet's replay is running. */
  replaying: Map<string, BetEnvelope[]>;
  /** bet_id -> highest seq sent on this socket. */
  lastSent: Map<string, number>;
  queue: Promise<void>;
  closed: boolean;
}

export type PresenceListener = (userId: string, online: boolean) => void;
/** Told of every envelope publishBetEvent fans out (after the fan-out); must not block. */
export type BetEventListener = (env: BetEnvelope, roomId: string | null) => void;

export class RealtimeHub {
  private readonly conns = new Set<Conn>();
  private readonly channels = new Map<string, Set<Conn>>();
  private readonly userConnCount = new Map<string, number>();
  private readonly presenceListeners = new Set<PresenceListener>();
  private readonly betListeners = new Set<BetEventListener>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: HubOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? silentLogger;
  }

  get heartbeatMs() {
    return this.opts.heartbeatMs ?? WS_HEARTBEAT_MS;
  }

  /**
   * Who may see what, and the replay query. REST resync (GET /v1/bets/:bet_id/events,
   * ./resync.ts) goes through this same object, so it allows exactly the sessions `subscribe`
   * allows and returns exactly the envelopes the socket replay sends.
   */
  get access(): HubAccess {
    return this.opts.access;
  }

  /** Starts the ping loop. Idempotent. */
  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.tick(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Stops the ping loop and closes every socket. */
  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of [...this.conns]) this.close(c, HUB_CLOSE.SHUTDOWN, 'server shutdown');
  }

  /** Hono WSEvents for `upgradeWebSocket(() => hub.events())`. */
  events(): WSEvents<WebSocketLike> {
    let conn: Conn | null = null;
    return {
      onOpen: (_evt, ws) => {
        conn = this.open(ws);
      },
      onMessage: (evt, ws) => {
        const c = conn ?? (conn = this.open(ws));
        const text = toText(evt.data);
        c.queue = c.queue
          .then(() => this.onFrame(c, text))
          .catch((err: unknown) => {
            this.log.error('ws.frame_error', { conn: c.id, err });
            this.sendControl(c, { op: 'error', code: 'INTERNAL', message: 'Server error.' });
          });
      },
      onClose: () => {
        if (conn) this.cleanup(conn);
      },
      onError: () => {
        if (conn) this.cleanup(conn);
      },
    };
  }

  // ---- publishing -----------------------------------------------------------------------

  /**
   * Fans an already-persisted envelope (bet_events row) out to bet:<bet_id>. Pass the bet's
   * `roomId` so stage sessions of that room that sent `subscribe_room` also get it: stage
   * scope receives every bet in its room. emitBetEvent does this.
   */
  publishBetEvent(env: BetEnvelope, roomId?: string | null): void {
    const targets = new Set(this.channels.get(`bet:${env.bet_id}`) ?? []);
    if (roomId) {
      for (const c of this.channels.get(`room:${roomId}`) ?? []) {
        if (c.auth?.scopes.includes('stage') && c.auth.room_id === roomId) targets.add(c);
      }
    }
    for (const c of targets) this.deliverBet(c, env);
    for (const l of this.betListeners) {
      try {
        l(env, roomId ?? null);
      } catch (err) {
        this.log.warn('hub.bet_listener_failed', { type: env.type, err: String(err) });
      }
    }
  }

  /** Listens to every published bet event (the stage's voice, src/stage/voice.ts). */
  onBetEvent(listener: BetEventListener): () => void {
    this.betListeners.add(listener);
    return () => this.betListeners.delete(listener);
  }

  /**
   * Closes every socket authenticated with `sessionId` (4401), e.g. after
   * DELETE /v1/auth/session: a revoked bearer must not keep receiving bet events.
   */
  closeSession(sessionId: string): void {
    for (const c of [...this.conns]) {
      if (c.auth?.session_id === sessionId) this.close(c, WS_CLOSE.UNAUTHORIZED, 'session revoked');
    }
  }

  /**
   * Drops every non-stage socket of `userId` from room:<roomId>, e.g. after
   * POST /v1/rooms/:id/leave: a member who left must stop receiving room.presence frames (the
   * room channel is its members). They may re-subscribe after re-joining.
   */
  leaveRoom(userId: string, roomId: string): void {
    for (const c of [...(this.channels.get(`room:${roomId}`) ?? [])]) {
      if (c.auth?.user_id !== userId || c.auth.scopes.includes('stage')) continue;
      c.rooms.delete(roomId);
      this.leave(c, `room:${roomId}`);
    }
  }

  /**
   * Sends a frame (a seq-bearing envelope such as bet.invited, or a control frame) to
   * user:<user_id>.
   */
  publishToUser(userId: string, frame: BetEnvelope | WsServerControlFrame): void {
    for (const c of this.channels.get(`user:${userId}`) ?? []) {
      if ('seq' in frame && 'bet_id' in frame) this.deliverBet(c, frame as BetEnvelope);
      else this.send(c, frame);
    }
  }

  /** Sends a control frame (room.presence, stage.*) to room:<room_id>. */
  publishToRoom(roomId: string, frame: WsServerControlFrame): void {
    for (const c of this.channels.get(`room:${roomId}`) ?? []) this.send(c, frame);
  }

  /** Stage sessions of the room that sent subscribe_room. */
  private stageConns(roomId: string): Conn[] {
    return [...(this.channels.get(`room:${roomId}`) ?? [])].filter(
      (c) => c.auth?.scopes.includes('stage') && c.auth.room_id === roomId,
    );
  }

  /** Is a stage (projector) of this room listening? */
  hasStage(roomId: string): boolean {
    return this.stageConns(roomId).length > 0;
  }

  /** A control frame for the room's stage sessions only (stage.voice): the phones never get it. */
  publishToStage(roomId: string, frame: WsServerControlFrame): void {
    for (const c of this.stageConns(roomId)) this.send(c, frame);
  }

  isUserOnline(userId: string): boolean {
    return (this.userConnCount.get(userId) ?? 0) > 0;
  }

  /** Every user with a live socket right now. */
  onlineUserIds(): string[] {
    const out: string[] = [];
    for (const [id, n] of this.userConnCount) if (n > 0) out.push(id);
    return out;
  }

  onPresence(listener: PresenceListener): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  // ---- internals ------------------------------------------------------------------------

  private open(ws: Ws): Conn {
    const c: Conn = {
      id: this.nextId++,
      ws,
      auth: null,
      helloTimer: null,
      missedPongs: 0,
      bets: new Set(),
      rooms: new Set(),
      replaying: new Map(),
      lastSent: new Map(),
      queue: Promise.resolve(),
      closed: false,
    };
    c.helloTimer = setTimeout(() => {
      if (!c.auth) this.close(c, WS_CLOSE.UNAUTHORIZED, 'hello timeout');
    }, this.opts.helloTimeoutMs ?? WS_HELLO_TIMEOUT_MS);
    c.helloTimer.unref();
    this.conns.add(c);
    return c;
  }

  private async onFrame(c: Conn, text: string | null): Promise<void> {
    if (c.closed) return;
    let json: unknown;
    try {
      json = text === null ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = WsClientFrame.safeParse(json);
    if (!parsed.success) {
      if (!c.auth) return this.close(c, WS_CLOSE.UNAUTHORIZED, 'expected hello');
      this.sendControl(c, {
        op: 'error',
        code: 'VALIDATION_FAILED',
        message: 'Unknown or malformed frame.',
      });
      return;
    }
    const f = parsed.data;
    if (!c.auth && f.op !== 'hello') return this.close(c, WS_CLOSE.UNAUTHORIZED, 'expected hello');

    switch (f.op) {
      case 'hello': {
        if (c.auth) {
          this.sendControl(c, {
            op: 'error',
            code: 'INVALID_STATE',
            message: 'Already said hello.',
          });
          return;
        }
        let auth: AuthContext | null = null;
        try {
          auth = await this.opts.access.resolveToken(f.token);
        } catch {
          auth = null;
        }
        if (!auth) return this.close(c, WS_CLOSE.UNAUTHORIZED, 'invalid token');
        if (f.device_id && auth.device_id && f.device_id !== auth.device_id) {
          return this.close(c, WS_CLOSE.UNAUTHORIZED, 'device mismatch');
        }
        c.auth = auth;
        if (c.helloTimer) clearTimeout(c.helloTimer);
        c.helloTimer = null;
        if (auth.user_id) {
          this.join(c, `user:${auth.user_id}`);
          const n = (this.userConnCount.get(auth.user_id) ?? 0) + 1;
          this.userConnCount.set(auth.user_id, n);
          if (n === 1) this.emitPresence(auth.user_id, true);
        }
        // Logged so a phone's WS connection (on cellular, say) shows in the server log too.
        this.log.info('ws.hello', {
          conn: c.id,
          session_id: auth.session_id,
          user_id: auth.user_id,
          scopes: auth.scopes,
          subs: f.subs.length,
        });
        this.sendControl(c, {
          op: 'welcome',
          server_time: new Date(this.now()).toISOString(),
          heartbeat_ms: this.heartbeatMs,
          user_channel: auth.user_id !== null,
        });
        for (const s of f.subs) {
          if (c.closed) return;
          await this.subscribe(c, s.bet_id, s.after_seq);
        }
        return;
      }
      case 'subscribe':
        return this.subscribe(c, f.bet_id, f.after_seq);
      case 'unsubscribe':
        c.bets.delete(f.bet_id);
        c.replaying.delete(f.bet_id);
        c.lastSent.delete(f.bet_id);
        this.leave(c, `bet:${f.bet_id}`);
        return;
      case 'subscribe_room': {
        const ok = await this.opts.access.canSeeRoom(c.auth!, f.room_id);
        if (!ok) return this.close(c, WS_CLOSE.FORBIDDEN, 'room not allowed');
        c.rooms.add(f.room_id);
        this.join(c, `room:${f.room_id}`);
        return;
      }
      case 'pong':
        c.missedPongs = 0;
        return;
    }
  }

  private async subscribe(c: Conn, betId: string, afterSeq: number): Promise<void> {
    const ok = await this.opts.access.canSeeBet(c.auth!, betId);
    if (!ok) return this.close(c, WS_CLOSE.FORBIDDEN, 'bet not allowed');
    if (c.closed) return;
    // Join first and buffer, so nothing published during the replay query is lost.
    c.bets.add(betId);
    c.replaying.set(betId, []);
    c.lastSent.set(betId, afterSeq);
    this.join(c, `bet:${betId}`);
    let replayed = 0;
    let lastSeq = afterSeq;
    try {
      const r = await this.opts.access.replay(betId, afterSeq);
      for (const env of r.events) {
        if (this.sendBet(c, env)) replayed++;
      }
      lastSeq = Math.max(r.last_seq, c.lastSent.get(betId) ?? afterSeq);
    } catch (err) {
      // Never claim `subscribed` after a failed replay: the client would treat last_seq as
      // caught up and miss the gap. Drop the subscription; the client resyncs over REST and
      // subscribes again.
      c.replaying.delete(betId);
      c.bets.delete(betId);
      c.lastSent.delete(betId);
      this.leave(c, `bet:${betId}`);
      this.log.error('ws.replay_failed', { conn: c.id, bet_id: betId, err });
      this.sendControl(c, {
        op: 'error',
        code: 'INTERNAL',
        message: `Could not replay bet ${betId}; resync and subscribe again.`,
      });
      return;
    }
    const buffered = c.replaying.get(betId) ?? [];
    c.replaying.delete(betId);
    if (!c.closed) {
      this.sendControl(c, { op: 'subscribed', bet_id: betId, last_seq: lastSeq, replayed });
      for (const env of buffered.sort((a, b) => a.seq - b.seq)) this.sendBet(c, env);
    }
  }

  private deliverBet(c: Conn, env: BetEnvelope) {
    const buf = c.replaying.get(env.bet_id);
    if (buf) buf.push(env);
    else this.sendBet(c, env);
  }

  /** Sends if seq is new for this socket. Returns whether it was sent. */
  private sendBet(c: Conn, env: BetEnvelope): boolean {
    const last = c.lastSent.get(env.bet_id) ?? 0;
    if (env.seq <= last) return false;
    c.lastSent.set(env.bet_id, env.seq);
    return this.send(c, env);
  }

  private sendControl(c: Conn, frame: WsServerControlFrame) {
    this.send(c, frame);
  }

  private send(c: Conn, frame: object): boolean {
    if (c.closed || c.ws.readyState !== 1) return false;
    const buffered = (c.ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount ?? 0;
    if (buffered > (this.opts.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES)) {
      this.close(c, HUB_CLOSE.BACKPRESSURE, 'send buffer full');
      return false;
    }
    try {
      c.ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.log.warn('ws.send_failed', { conn: c.id, err });
      return false;
    }
  }

  private tick() {
    const t = this.now();
    for (const c of [...this.conns]) {
      if (!c.auth) continue;
      if (c.missedPongs >= WS_MAX_MISSED_PONGS) {
        this.close(c, HUB_CLOSE.HEARTBEAT_TIMEOUT, 'missed pongs');
        continue;
      }
      c.missedPongs++;
      this.sendControl(c, { op: 'ping', t, server_time: new Date(t).toISOString() });
    }
  }

  private join(c: Conn, ch: string) {
    let set = this.channels.get(ch);
    if (!set) this.channels.set(ch, (set = new Set()));
    set.add(c);
  }

  private leave(c: Conn, ch: string) {
    const set = this.channels.get(ch);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.channels.delete(ch);
  }

  private close(c: Conn, code: number, reason: string) {
    if (!c.closed) {
      try {
        c.ws.close(code, reason);
      } catch {
        /* already closing */
      }
    }
    this.cleanup(c);
  }

  private cleanup(c: Conn) {
    if (!this.conns.has(c)) {
      c.closed = true;
      return;
    }
    c.closed = true;
    this.conns.delete(c);
    if (c.helloTimer) clearTimeout(c.helloTimer);
    for (const b of c.bets) this.leave(c, `bet:${b}`);
    for (const r of c.rooms) this.leave(c, `room:${r}`);
    const uid = c.auth?.user_id;
    if (uid) {
      this.leave(c, `user:${uid}`);
      const n = (this.userConnCount.get(uid) ?? 1) - 1;
      if (n <= 0) {
        this.userConnCount.delete(uid);
        this.emitPresence(uid, false);
      } else this.userConnCount.set(uid, n);
    }
  }

  private emitPresence(userId: string, online: boolean) {
    for (const l of this.presenceListeners) {
      try {
        l(userId, online);
      } catch (err) {
        this.log.warn('ws.presence_listener_failed', { err });
      }
    }
  }
}

function toText(data: WSMessageReceive): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null; // Blob: not expected from ws on Node
}
