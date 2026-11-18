// Stage smoke tests (TASKS K-06 E3): the page renders, frames reduce into the ticker, and the WS
// client follows the stage auth / heartbeat / reconnect rules (API-CONTRACT §1.3, §3.1–§3.3).
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, Ticker } from '../src/App';
import {
  applyFrame,
  explorerTx,
  findSignature,
  initialTicker,
  type TickerAction,
} from '../src/ticker';
import { fetchStageToken, StageConnection, wsUrlFor, type WsLike } from '../src/connection';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const SIG = '5'.repeat(88);
const txEvent = (seq: number) => ({
  v: 1,
  type: 'tx.submitted',
  bet_id: BET,
  seq,
  ts: `2026-11-21T18:05:0${seq}.000Z`,
  source: 'server',
  payload: { kind: 'atomic_lock', signature: SIG },
});
const frame = (raw: unknown): TickerAction => ({
  kind: 'frame',
  raw,
  receivedAt: Date.parse('2026-11-21T18:00:00.000Z'),
});

describe('stage page', () => {
  it('renders the connect form with the no-typing URL tip', () => {
    const html = renderToString(<App />);
    expect(html).toContain('You&#x27;re <span class="on">On</span>');
    expect(html).toContain('Room code');
    expect(html).toContain('Stage key');
    expect(html).toContain('Connect');
    expect(html).toContain('href="?preview"');
    expect(html).toContain('/stage/?room=ABC234#key=STAGE_KEY');
  });

  it('renders events newest first with Explorer links', () => {
    let s = applyFrame(initialTicker, frame(txEvent(1)));
    s = applyFrame(
      s,
      frame({ ...txEvent(2), type: 'tx.confirmed', payload: { ...txEvent(2).payload, slot: 7 } }),
    );
    const html = renderToString(<Ticker state={s} />);
    expect(html.indexOf('Lock tx confirmed')).toBeGreaterThan(-1);
    expect(html.indexOf('Lock tx confirmed')).toBeLessThan(html.indexOf('Lock tx sent'));
    expect(html).toContain(explorerTx(SIG).replace(/&/g, '&amp;'));
  });
});

describe('ticker reducer', () => {
  it('welcome -> open with the clock offset', () => {
    const s = applyFrame(
      initialTicker,
      frame({
        op: 'welcome',
        server_time: '2026-11-21T18:00:01.500Z',
        heartbeat_ms: 20000,
        user_channel: false,
      }),
    );
    expect(s.status).toBe('open');
    expect(s.clockOffsetMs).toBe(1500);
  });

  it('parses events with the shared schema, dedupes by (bet_id, seq), drops junk', () => {
    let s = applyFrame(initialTicker, frame(txEvent(1)));
    s = applyFrame(s, frame(txEvent(1)));
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({
      type: 'tx.submitted',
      seq: 1,
      explorer: `https://explorer.solana.com/tx/${SIG}?cluster=devnet`,
    });
    expect(s.lastSeq[BET]).toBe(1);
    s = applyFrame(s, frame({ ...txEvent(2), source: 'chain' })); // source is fixed per type
    s = applyFrame(s, frame({ op: 'nope' }));
    s = applyFrame(s, frame('x'));
    expect(s.events).toHaveLength(1);
    expect(s.dropped).toBe(3);
  });

  it('control frames: error, presence, cue, subscribed', () => {
    let s = applyFrame(
      initialTicker,
      frame({ op: 'error', code: 'INTERNAL', message: 'replay failed' }),
    );
    expect(s.errors).toEqual(['INTERNAL: replay failed']);
    s = applyFrame(s, frame({ op: 'stage.cue', bet_id: BET, kind: 'gavel' }));
    expect(s.lastCue).toEqual({ bet_id: BET, kind: 'gavel' });
    s = applyFrame(s, frame({ op: 'subscribed', bet_id: BET, last_seq: 9, replayed: 9 }));
    expect(s.lastSeq[BET]).toBe(9);
    s = applyFrame(s, frame({ op: 'room.presence', room_id: BET, members: [] }));
    expect(s.presence).toMatchObject({ room_id: BET, members: 0, online: 0 });
    expect(s.cueCount).toBe(1);
    expect(applyFrame(s, { kind: 'reset' })).toBe(initialTicker);
  });

  it('findSignature looks one level down', () => {
    expect(findSignature({ chain: { signature: 'abc' } })).toBe('abc');
    expect(findSignature({ x: 1 })).toBeNull();
  });
});

class FakeWs implements WsLike {
  readyState = 1;
  sent: unknown[] = [];
  closed: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.closed = code;
  }
  serverSays(f: unknown) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

function harness() {
  const sockets: FakeWs[] = [];
  const urls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const actions: TickerAction[] = [];
  const conn = new StageConnection({
    wsUrl: 'wss://youre-on.fly.dev/v1/ws',
    token: 'yo_s_stage',
    roomId: BET,
    onAction: (a) => actions.push(a),
    makeSocket: (u) => {
      urls.push(u);
      const s = new FakeWs();
      sockets.push(s);
      return s;
    },
    random: () => 0,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  });
  return { conn, sockets, urls, timers, actions };
}

describe('stage WebSocket client', () => {
  it('hello with the token in the first frame (not the URL), then subscribe_room', () => {
    const h = harness();
    h.conn.start();
    h.sockets[0]!.onopen?.({});
    expect(h.urls).toEqual(['wss://youre-on.fly.dev/v1/ws']);
    expect(h.sockets[0]!.sent).toEqual([
      { op: 'hello', token: 'yo_s_stage', subs: [] },
      { op: 'subscribe_room', room_id: BET },
    ]);
  });

  it('answers ping with pong and forwards frames', () => {
    const h = harness();
    h.conn.start();
    h.sockets[0]!.onopen?.({});
    h.sockets[0]!.serverSays({ op: 'ping', t: 42, server_time: '2026-11-21T18:00:00.000Z' });
    expect(h.sockets[0]!.sent.at(-1)).toEqual({ op: 'pong', t: 42 });
    expect(h.actions.some((a) => a.kind === 'frame')).toBe(true);
  });

  it('reconnects with the 0.25 -> 5 s ladder; 4401 / 4403 are final', () => {
    const h = harness();
    h.conn.start();
    h.sockets[0]!.onclose?.({ code: 1006, reason: '' });
    const reconnect = h.timers.find((t) => t.ms === 250)!;
    expect(reconnect).toBeTruthy();
    reconnect.fn();
    expect(h.sockets).toHaveLength(2);
    expect(h.conn.backoff(10)).toBe(5000);
    h.sockets[1]!.onclose?.({ code: 4401, reason: 'bad token' });
    expect(h.timers.filter((t) => t.ms === 500)).toHaveLength(0);
    expect(h.actions.at(-1)).toEqual({ kind: 'error', message: 'stage token rejected (4401)' });
  });

  it('45 s of silence: the dead socket is abandoned and the reconnect is scheduled without waiting for onclose', () => {
    const h = harness();
    h.conn.start();
    h.sockets[0]!.onopen?.({});
    const dead = h.timers.filter((t) => t.ms === 45_000).at(-1)!;
    expect(dead).toBeTruthy();
    dead.fn();
    expect(h.sockets[0]!.closed).toBe(4000);
    const reconnect = h.timers.find((t) => t.ms === 250)!;
    expect(reconnect).toBeTruthy();
    // a late onclose / frame from the abandoned socket changes nothing
    h.sockets[0]!.onclose?.({ code: 1006, reason: '' });
    expect(h.timers.filter((t) => t.ms === 500)).toHaveLength(0);
    reconnect.fn();
    expect(h.sockets).toHaveLength(2);
  });

  it('stop() closes and does not reconnect', () => {
    const h = harness();
    h.conn.start();
    h.conn.stop();
    expect(h.sockets[0]!.closed).toBe(1000);
  });

  it('wsUrlFor maps http(s) to ws(s) on /v1/ws', () => {
    expect(wsUrlFor('https://youre-on.fly.dev')).toBe('wss://youre-on.fly.dev/v1/ws');
    expect(wsUrlFor('http://localhost:8080/')).toBe('ws://localhost:8080/v1/ws');
  });

  it('fetchStageToken posts {stage_key, room_id} to /v1/stage/session', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const f = (async (u: string, i?: RequestInit) => {
      calls.push([u, i]);
      return new Response(JSON.stringify({ token: 'yo_s_x' }), { status: 201 });
    }) as unknown as typeof fetch;
    await expect(
      fetchStageToken({ serverUrl: 'https://h.dev', roomId: BET, stageKey: 'k' }, f),
    ).resolves.toBe('yo_s_x');
    expect(calls[0]![0]).toBe('https://h.dev/v1/stage/session');
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ stage_key: 'k', room_id: BET });
    const notFound = (async () =>
      new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchStageToken({ serverUrl: 'https://h.dev', roomId: BET, stageKey: 'k' }, notFound),
    ).rejects.toThrow(/404 NOT_FOUND/);
  });
});
