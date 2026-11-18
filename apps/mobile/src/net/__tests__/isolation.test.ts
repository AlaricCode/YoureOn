// A handler that throws inside a realtime callback used to be a fatal crash in Release (the
// voice SDK's "No active conversation" from a judge.cue listener). These pin the isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BetHub } from '../../app/betHub';
import { BET, snapshot, stateEv } from '../../app/__tests__/fixtures';
import { createRealtimeClient, type SocketLike } from '../ws';

class Sock implements SocketLike {
  static all: Sock[] = [];
  readyState = 0;
  closed: number | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    Sock.all.push(this);
  }
  send() {}
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
}

describe('a handler that throws never takes the socket or the hub down', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Sock.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it('the realtime client logs a throwing onEvent / onControl and keeps delivering', () => {
    const logs: string[] = [];
    const events: number[] = [];
    let controls = 0;
    const c = createRealtimeClient({
      url: 'ws://x/v1/ws',
      createSocket: (u) => new Sock(u),
      hello: () => ({ token: 'yo_s_t', device_id: 'd1', app_version: '1' }),
      lastSeq: () => 0,
      onEvent: (e) => {
        events.push(e.seq);
        if (e.seq === 1) throw new Error('No active conversation. Call startSession() first.');
      },
      onControl: () => {
        controls++;
        throw new Error('listener bug');
      },
      random: () => 0,
      log: (m) => logs.push(m),
    });
    c.start();
    const s = Sock.all[0]!;
    s.open();
    expect(() =>
      s.msg({
        op: 'welcome',
        server_time: '2026-11-21T18:00:00.000Z',
        heartbeat_ms: 20000,
        user_channel: true,
      }),
    ).not.toThrow();
    expect(c.status).toBe('live');
    expect(() => s.msg(stateEv('DRAFTING', 1))).not.toThrow();
    s.msg(stateEv('TERMS_PROPOSED', 2));
    expect(events).toEqual([1, 2]);
    expect(controls).toBe(1);
    expect(s.closed).toBeNull();
    expect(logs).toEqual(['ws.handler_failed', 'ws.handler_failed']);
  });

  it('the bet hub logs a throwing listener; the others still run and the bet still updates', () => {
    const logs: string[] = [];
    const hub = new BetHub(
      {
        getBet: async () => snapshot(),
        getBetEvents: async () => ({ events: [], last_seq: 0 }),
      },
      Date.now,
      (m) => logs.push(m),
    );
    const seen: string[] = [];
    hub.onChange(() => {
      throw new Error('boom');
    });
    hub.onChange((e) => seen.push(e?.type ?? 'snapshot'));
    expect(() => hub.push(stateEv('DRAFTING', 1))).not.toThrow();
    expect(hub.get(BET)!.state).toBe('DRAFTING');
    expect(seen).toEqual(['bet.state']);
    expect(logs).toEqual(['listener.failed']);
  });
});
