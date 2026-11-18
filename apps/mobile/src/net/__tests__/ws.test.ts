import { WS_CLIENT_DEAD_MS, WS_CLOSE } from '@youre-on/shared/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BetHub } from '../../app/betHub';
import { BET, ev, snapshot, stateEv } from '../../app/__tests__/fixtures';
import {
  createRealtimeClient,
  GAP_WAIT_MS,
  ingest,
  initialSeq,
  needsResync,
  reconnectDelay,
  resetTo,
  wsUrlFor,
  type SocketLike,
} from '../ws';

describe('sequencer', () => {
  it('applies in order, drops duplicates and old seqs, buffers a gap and drains it', () => {
    let s = initialSeq(2);
    let r = ingest(s, stateEv('TERMS_PROPOSED', 3), 0);
    expect(r.apply.map((e) => e.seq)).toEqual([3]);
    s = r.state;
    expect(ingest(s, stateEv('TERMS_PROPOSED', 3), 0).apply).toEqual([]);
    expect(ingest(s, stateEv('DRAFTING', 1), 0).apply).toEqual([]);
    r = ingest(s, stateEv('AWAITING_LOCK', 5), 100);
    expect(r.apply).toEqual([]);
    expect(r.state.gapSince).toBe(100);
    expect(needsResync(r.state, 100 + GAP_WAIT_MS - 1)).toBe(false);
    expect(needsResync(r.state, 100 + GAP_WAIT_MS)).toBe(true);
    r = ingest(r.state, stateEv('AWAITING_AUTHORIZATIONS', 4), 200);
    expect(r.apply.map((e) => e.seq)).toEqual([4, 5]);
    expect(r.state.gapSince).toBeNull();
    expect(r.state.lastSeq).toBe(5);
  });

  it('resetTo a snapshot drops covered events and drains the rest', () => {
    let s = initialSeq(0);
    s = ingest(s, stateEv('LOCKED', 7), 0).state;
    s = ingest(s, stateEv('ATTEMPT', 8), 0).state;
    const r = resetTo(s, 6, 10);
    expect(r.apply.map((e) => e.seq)).toEqual([7, 8]);
    expect(r.state.lastSeq).toBe(8);
  });

  it('backoff follows 0.25 -> 0.5 -> 1 -> 2 -> 5 s plus <= 30 % jitter', () => {
    expect([0, 1, 2, 3, 4, 9].map((a) => reconnectDelay(a, () => 0))).toEqual([
      250, 500, 1000, 2000, 5000, 5000,
    ]);
    expect(reconnectDelay(0, () => 1)).toBe(325);
  });

  it('ws url from the http base', () => {
    expect(wsUrlFor('https://yo.fly.dev/')).toBe('wss://yo.fly.dev/v1/ws');
    expect(wsUrlFor('http://192.168.1.5:8080')).toBe('ws://192.168.1.5:8080/v1/ws');
  });
});

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed: number | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.closed = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  serverClose(code: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.(reason === undefined ? { code } : { code, reason });
  }
}

describe('realtime client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (
    o: {
      onUnauthorized?: () => Promise<boolean>;
      onForbidden?: (d: { room: string | null; bets: string[]; reason: string }) => void;
    } = {},
  ) => {
    const events: unknown[] = [];
    const seqs = new Map<string, number>([[BET, 4]]);
    const statuses: string[] = [];
    const c = createRealtimeClient({
      url: 'ws://x/v1/ws',
      createSocket: (u) => new FakeSocket(u),
      hello: () => ({ token: 'yo_s_t', device_id: 'd1', app_version: '1' }),
      lastSeq: (id) => seqs.get(id) ?? 0,
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      random: () => 0,
      ...(o.onUnauthorized ? { onUnauthorized: o.onUnauthorized } : {}),
      ...(o.onForbidden ? { onForbidden: o.onForbidden } : {}),
    });
    return { c, events, seqs, statuses };
  };

  it('hello carries token, device and each bet after_seq; welcome -> live; ping -> pong', () => {
    const { c, events, statuses } = make();
    c.subscribe(BET);
    c.subscribeRoom('room-1');
    c.start();
    const s = FakeSocket.all[0]!;
    s.open();
    expect(s.sent[0]).toEqual({
      op: 'hello',
      token: 'yo_s_t',
      device_id: 'd1',
      app_version: '1',
      subs: [{ bet_id: BET, after_seq: 4 }],
    });
    expect(s.sent[1]).toEqual({ op: 'subscribe_room', room_id: 'room-1' });
    s.msg({
      op: 'welcome',
      server_time: '2026-11-21T18:00:00.000Z',
      heartbeat_ms: 20000,
      user_channel: true,
    });
    expect(statuses.at(-1)).toBe('live');
    s.msg({ op: 'ping', t: 42, server_time: '2026-11-21T18:00:20.000Z' });
    expect(s.sent.at(-1)).toEqual({ op: 'pong', t: 42 });
    s.msg(stateEv('LOCKED', 5));
    s.msg({
      v: 1,
      type: 'nope.unknown',
      bet_id: BET,
      seq: 6,
      ts: 'x',
      source: 'server',
      payload: {},
    });
    expect(events).toHaveLength(1);
  });

  it('reconnects with backoff and resumes from the latest after_seq', () => {
    const { c, seqs } = make();
    c.subscribe(BET);
    c.start();
    FakeSocket.all[0]!.open();
    seqs.set(BET, 9);
    FakeSocket.all[0]!.serverClose(1006);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.serverClose(1006);
    vi.advanceTimersByTime(500);
    const s3 = FakeSocket.all[2]!;
    s3.open();
    expect((s3.sent[0] as { subs: unknown }).subs).toEqual([{ bet_id: BET, after_seq: 9 }]);
    // welcome resets the backoff
    s3.msg({
      op: 'welcome',
      server_time: '2026-11-21T18:00:00.000Z',
      heartbeat_ms: 20000,
      user_channel: true,
    });
    s3.serverClose(1006);
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('declares the socket dead after 45 s of silence', () => {
    const { c } = make();
    c.start();
    const s = FakeSocket.all[0]!;
    s.open();
    vi.advanceTimersByTime(WS_CLIENT_DEAD_MS - 1);
    expect(s.closed).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.closed).toBe(4000);
    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('4401: refreshes the session, then reconnects', async () => {
    let refreshed = 0;
    const { c, statuses } = make({ onUnauthorized: async () => (++refreshed, true) });
    c.start();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.serverClose(WS_CLOSE.UNAUTHORIZED);
    expect(statuses).toContain('unauthorized');
    await vi.runAllTicks();
    await Promise.resolve();
    expect(refreshed).toBe(1);
    expect(FakeSocket.all).toHaveLength(2);
  });

  const welcome = {
    op: 'welcome',
    server_time: '2026-11-21T18:00:00.000Z',
    heartbeat_ms: 20000,
    user_channel: true,
  };
  const helloOf = (s: FakeSocket) => s.sent[0] as { subs: { bet_id: string }[] };

  it('4403 bet not allowed: drops the bet subs and reconnects with a clean hello (no loop)', () => {
    const dropped: unknown[] = [];
    const { c } = make({ onForbidden: (d) => dropped.push(d) });
    c.subscribe(BET);
    c.subscribeRoom('room-1');
    c.start();
    const s1 = FakeSocket.all[0]!;
    s1.open();
    s1.msg(welcome); // welcome arrives before the server checks the subs
    s1.serverClose(WS_CLOSE.FORBIDDEN, 'bet not allowed');
    expect(dropped).toEqual([{ room: null, bets: [BET], reason: 'bet not allowed' }]);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1); // backed off, not an instant retry
    vi.advanceTimersByTime(1);
    const s2 = FakeSocket.all[1]!;
    s2.open();
    expect(helloOf(s2).subs).toEqual([]);
    // the room was allowed: still subscribed
    expect(s2.sent[1]).toEqual({ op: 'subscribe_room', room_id: 'room-1' });
    s2.msg(welcome);
    vi.advanceTimersByTime(WS_CLIENT_DEAD_MS - 1); // stays up (no new 4403)
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('4403 room not allowed: drops only the room; repeated 4403s back off', () => {
    const { c } = make();
    c.subscribe(BET);
    c.subscribeRoom('room-1');
    c.start();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.serverClose(WS_CLOSE.FORBIDDEN, 'room not allowed');
    vi.advanceTimersByTime(500);
    const s2 = FakeSocket.all[1]!;
    s2.open();
    expect(helloOf(s2).subs).toEqual([{ bet_id: BET, after_seq: 4 }]);
    expect(s2.sent).toHaveLength(1);
    // the app re-adds a refused room: the next 4403 waits longer (1 s), never a tight loop
    c.subscribeRoom('room-1');
    s2.msg(welcome);
    s2.serverClose(WS_CLOSE.FORBIDDEN, 'room not allowed');
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('reset() forgets every sub: the next hello (a new user) carries none', () => {
    const { c } = make();
    c.subscribe(BET);
    c.subscribeRoom('room-1');
    c.reset();
    c.start();
    const s = FakeSocket.all[0]!;
    s.open();
    expect(helloOf(s).subs).toEqual([]);
    expect(s.sent).toHaveLength(1);
  });

  it('stop closes and never reconnects', () => {
    const { c } = make();
    c.start();
    FakeSocket.all[0]!.open();
    c.stop();
    expect(FakeSocket.all[0]!.closed).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('bet hub', () => {
  it('clear() forgets every bet and its seq', () => {
    const hub = new BetHub({
      getBet: async () => snapshot(),
      getBetEvents: async () => ({ events: [], last_seq: 0 }),
    });
    hub.adopt(snapshot({ last_seq: 3 }));
    hub.clear();
    expect(hub.has(BET)).toBe(false);
    expect(hub.lastSeq(BET)).toBe(0);
    expect(hub.ids()).toEqual([]);
  });
});

describe('bet hub resync', () => {
  it('fills a gap from GET /events after 2 s, and falls back to the snapshot', async () => {
    let now = 0;
    const calls: string[] = [];
    // Served like the server: seq > after, oldest first, last_seq = the head. The log holds
    // 3..5; later the head moves to 9 but 6..9 never reach the log (pruned).
    const log = [
      stateEv('AWAITING_AUTHORIZATIONS', 3),
      stateEv('AWAITING_LOCK', 4),
      stateEv('LOCKED', 5),
    ];
    let head = 5;
    const hub = new BetHub(
      {
        async getBet() {
          calls.push('getBet');
          return snapshot({ state: 'LOCKED', last_seq: 8 });
        },
        async getBetEvents(_id, after) {
          calls.push(`events>${after}`);
          return { events: log.filter((e) => e.seq > after), last_seq: head };
        },
      },
      () => now,
    );
    hub.adopt(snapshot({ last_seq: 2 }));
    hub.push(stateEv('LOCKED', 5));
    expect(hub.get(BET)!.state).toBe('DRAFTING');
    await hub.tick();
    expect(calls).toEqual([]);
    now = GAP_WAIT_MS;
    await hub.tick();
    expect(calls).toEqual(['events>2']);
    expect(hub.get(BET)!.state).toBe('LOCKED');
    expect(hub.lastSeq(BET)).toBe(5);
    // A hole the events endpoint can't fill -> snapshot.
    head = 9;
    hub.push(stateEv('ATTEMPT', 9));
    now += GAP_WAIT_MS;
    await hub.tick();
    expect(calls.at(-1)).toBe('getBet');
    expect(hub.lastSeq(BET)).toBe(9);
    expect(hub.get(BET)!.state).toBe('ATTEMPT');
  });

  it('notifies listeners with before/after for each applied event', () => {
    const hub = new BetHub({
      getBet: async () => snapshot(),
      getBetEvents: async () => ({ events: [], last_seq: 0 }),
    });
    const seen: string[] = [];
    hub.onChange((e, before, after) =>
      seen.push(`${e?.type ?? 'snapshot'}:${before?.state ?? '-'}->${after.state}`),
    );
    hub.push(ev('bet.invited', { challenger: snapshot().party_a, room_id: snapshot().room_id }, 1));
    hub.push(stateEv('DRAFTING', 2));
    expect(seen).toEqual(['bet.invited:-->null', 'bet.state:-->DRAFTING']);
  });
});
