// The pitch layout's state (ticker.ts BetView folding, market.ts odds widget) and render
// (App.tsx): a full skill bet from terms to payout, the Gemini widget, cold-start snapshots,
// REPLAY clips, and the connection's bet subscriptions + REST helpers.
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hashJcs } from '@youre-on/shared/jcs';
import type { BetSnapshot } from '@youre-on/shared/api';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { BetCard, OddsWidget, ReplayOverlay, StageView, clock, shortSig } from '../src/App';
import { marketView } from '../src/market';
import {
  applyFrame,
  emptyBet,
  explorerTx,
  initialTicker,
  type TickerAction,
  type TickerState,
} from '../src/ticker';
import { fetchBetSnapshot, fetchMarket, StageConnection, type WsLike } from '../src/connection';

const vector = <T,>(name: string): T =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/shared/test/vectors/${name}.json`, import.meta.url),
        'utf8',
      ),
    ) as { input: T }
  ).input;

const terms = vector<Record<string, any>>('terms-v1-001'); // eslint-disable-line @typescript-eslint/no-explicit-any
const ruling = vector<Record<string, unknown>>('ruling-v1-001');
const BET = terms.bet_id as string;
const SIG_LOCK = '5'.repeat(88);
const SIG_RESOLVE = '4'.repeat(88);
const SIG_PAY = '3'.repeat(88);
const PK = {
  a: terms.party_a.pubkey as string,
  b: terms.party_b.pubkey as string,
  judge: 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi',
  mint: terms.escrow.mint as string,
};
const envelope = {
  terms,
  terms_hash: hashJcs(terms),
  presentation: {
    title: 'Bottle flip',
    readback: 'Jake flips a bottle upright. Five dollars each.',
    stakes_display: '$5 each',
    odds_display: null,
    party_a_avatar_url: null,
    party_b_avatar_url: null,
  },
};
const meta = (signature: string) => ({
  signature,
  slot: 400118200,
  block_height: null,
  outer_ix: 3,
  inner_ix: 0,
  block_time: 1795284320,
  observed_via: 'quicknode_stream',
});

let seq = 0;
const ev = (
  type: string,
  payload: unknown,
  source = type.startsWith('chain.') ? 'chain' : 'server',
) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: ++seq,
  ts: new Date(Date.parse('2026-11-21T18:05:00.000Z') + seq * 1000).toISOString(),
  source,
  payload,
});
const frame = (
  raw: unknown,
  receivedAt = Date.parse('2026-11-21T18:06:00.000Z'),
): TickerAction => ({
  kind: 'frame',
  raw,
  receivedAt,
});
const run = (frames: unknown[], s: TickerState = initialTicker) =>
  frames.reduce<TickerState>((acc, f) => applyFrame(acc, frame(f)), s);

function fullBet(): unknown[] {
  seq = 0;
  return [
    ev('terms.proposed', { envelope }),
    ev('terms.authorized', {
      party: 'A',
      method: 'faceid_hold',
      authorized_at: '2026-11-21T18:05:20.000Z',
      count: 1,
    }),
    ev('terms.authorized', {
      party: 'B',
      method: 'passcode_hold',
      authorized_at: '2026-11-21T18:05:24.000Z',
      count: 2,
    }),
    ev('tx.submitted', { kind: 'atomic_lock', signature: SIG_LOCK }),
    ev('chain.BetCreated', {
      ...meta(SIG_LOCK),
      bet_id: BET,
      bet: PK.judge,
      vault: PK.judge,
      party_a: PK.a,
      party_b: PK.b,
      mint: PK.mint,
      stake_a: '5000000',
      stake_b: '5000000',
      terms_hash: envelope.terms_hash,
      judge_authority: PK.judge,
      appeal_authority: PK.judge,
      accept_deadline: 1795284600,
      rent_payer: PK.judge,
      ts: 1795284320,
    }),
    ev('ruling.issued', { ruling, ruling_hash: 'ab'.repeat(32) }),
    ev('chain.BetResolved', {
      ...meta(SIG_RESOLVE),
      bet_id: BET,
      judge: PK.judge,
      outcome: 'PartyB',
      evidence_hash: '6d'.repeat(32),
      ruling_hash: 'ab'.repeat(32),
      appeal_deadline: 1795284435,
      ts: 1795284425,
    }),
  ];
}
const finalized = () =>
  ev('chain.BetFinalized', {
    ...meta(SIG_PAY),
    bet_id: BET,
    final_status: 'Settled',
    outcome: 'PartyB',
    mint: PK.mint,
    party_a: PK.a,
    party_b: PK.b,
    party_a_token: '11111111111111111111111111111111',
    party_b_token: PK.b,
    to_a: '0',
    to_b: '10000000',
    ts: 1795284436,
    caller: PK.judge,
  });

const snap = (over: Partial<GeminiMarketSnapshot> = {}): GeminiMarketSnapshot => ({
  eventTicker: 'BTC05M2611180240',
  eventTitle: 'BTC price today at 9:40pm EST',
  instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
  contractLabel: 'Up',
  status: 'active',
  marketState: 'open',
  strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
  expiry: '2026-11-18T02:40:00.000Z',
  bestBid: '0.54',
  bestAsk: '0.67',
  lastTradePrice: null,
  indexPrice: '64379.76',
  source: 'rest_event',
  exchangeTs: null,
  observedAt: '2026-11-18T02:37:10.000Z',
  ...over,
});
const T = Date.parse('2026-11-18T02:37:11.000Z');

describe('bet card state', () => {
  it('folds a skill bet: names, terms code, Face ID per party, 1 tx / 3 signatures, ruling, appeal', () => {
    const s = run(fullBet());
    expect(s.events).toHaveLength(7);
    expect(s.dropped).toBe(0);
    expect(s.focusBetId).toBe(BET);
    const b = s.bets[BET]!;
    expect(b.names).toEqual({ A: 'Logan', B: 'Jake' });
    expect(b.terms_code).toBe(envelope.terms_hash.slice(0, 8));
    expect(b.auth.A).toEqual({ method: 'faceid_hold', at: '2026-11-21T18:05:20.000Z' });
    expect(b.auth.B?.method).toBe('passcode_hold');
    expect(b.auth_count).toBe(2);
    expect(b.lock).toMatchObject({
      kind: 'atomic_lock',
      signature: SIG_LOCK,
      signers: 3,
      status: 'confirmed',
      onchain: true,
    });
    expect(b.ruling).toMatchObject({ outcome: 'B_WINS', cited_frames: [5, 6, 7] });
    expect(b.appeal_deadline).toBe(1795284435);
    expect(b.txs.resolve).toBe(SIG_RESOLVE);
    expect(b.payout).toBeNull();
  });

  it('money moves in BetFinalized (no BetPaid): payout + Explorer; appeal countdown ends', () => {
    const s = run([...fullBet(), finalized()]);
    const b = s.bets[BET]!;
    expect(b.payout).toEqual({
      to_a: '0',
      to_b: '10000000',
      event: 'BetFinalized',
      signature: SIG_PAY,
    });
    expect(b.appeal_deadline).toBeNull();
    const html = renderToString(<BetCard bet={b} now={Date.parse('2026-11-21T18:07:20.000Z')} />);
    expect(html).toContain('PAID');
    expect(html).toContain('$10');
    expect(html).toContain(explorerTx(SIG_PAY).replace(/&/g, '&amp;'));
  });

  it('renders the pitch card: parties, claim, code, auth, lock link + signer count, verdict, countdown', () => {
    const s = run(fullBet());
    const b = {
      ...s.bets[BET]!,
      frame_urls: Array.from({ length: 8 }, (_, i) => `https://x.test/f${i}.jpg`),
    };
    const now = (1795284435 - 8) * 1000;
    const html = renderToString(<BetCard bet={b} now={now} />);
    expect(html).toContain('Logan');
    expect(html).toContain('Jake');
    expect(html).toContain('water bottle flip');
    expect(html).toContain(b.terms_code!);
    expect(html).toContain('Face ID');
    expect(html).toContain('Passcode');
    expect(html).toContain('1 tx · 3 signatures');
    expect(html).toContain(explorerTx(SIG_LOCK).replace(/&/g, '&amp;'));
    expect(html).toContain('Jake wins');
    expect(html).toContain('https://x.test/f5.jpg'); // the first cited frame
    expect(html).toContain('Appeal window 0:08');
  });

  it('a REST snapshot seeds names / auth / lock on cold start; events still win', () => {
    const snapshot: BetSnapshot = {
      bet_id: BET,
      room_id: '00000000-0000-4000-8000-000000000001',
      state: 'LOCKED',
      prev_state: 'AWAITING_LOCK',
      onchain_status: 'Locked',
      chain_ack: 'stream',
      pending_tx: null,
      party_a: {
        user_id: '00000000-0000-4000-8000-00000000000a',
        pubkey: PK.a as never,
        display_name: 'Logan',
        avatar_url: null,
      },
      party_b: {
        user_id: '00000000-0000-4000-8000-00000000000b',
        pubkey: PK.b as never,
        display_name: 'Jake',
        avatar_url: null,
      },
      my_party: null,
      envelope: null,
      draft: null,
      authorizations: {
        A: { method: 'faceid_hold', authorized_at: '2026-11-21T18:05:20.000Z' },
        B: { method: 'faceid_hold', authorized_at: '2026-11-21T18:05:24.000Z' },
      },
      deadlines: {
        accept_deadline: null,
        resolve_deadline: null,
        appeal_deadline: null,
        appeal_resolve_deadline: null,
      },
      attempt_no: null,
      redo_count: 0,
      latest_ruling: null,
      appeal: null,
      payout: null,
      signatures: { lock: SIG_LOCK as never },
      end_reason: null,
      last_seq: 5,
    };
    let s = applyFrame(initialTicker, { kind: 'snapshot', bet: snapshot, receivedAt: 1 });
    expect(s.focusBetId).toBe(BET);
    expect(s.bets[BET]).toMatchObject({
      state: 'LOCKED',
      names: { A: 'Logan', B: 'Jake' },
      auth_count: 2,
      lock: { signature: SIG_LOCK, signers: 3, onchain: true },
    });
    seq = 5;
    s = applyFrame(
      s,
      frame(
        ev('bet.state', {
          state: 'ATTEMPT',
          prev: 'LOCKED',
          onchain_status: 'Locked',
          chain_ack: 'stream',
          pending_tx: null,
          reason: null,
        }),
      ),
    );
    expect(s.bets[BET]!.state).toBe('ATTEMPT');
  });

  // The stage first sees a bet mid-flight (page reloaded / opened during the pitch): a live
  // event lands, then subscribe(id, 0) replays seq 1..N-1 and the REST snapshot may land after
  // newer live events. The card must end where an in-order fold ends, never regress.
  const betState = (state: string, prev: string | null) =>
    ev('bet.state', {
      state,
      prev,
      onchain_status: null,
      chain_ack: 'none',
      pending_tx: null,
      reason: null,
    });
  function pitch(): unknown[] {
    const base = fullBet() as Array<{ type: string; payload: unknown }>;
    seq = 5; // keep the first five (seq 1-5), number the rest after them
    const redo = { ...ruling, outcome: 'REDO', redo_reason: 'unclear' };
    return [
      ...base.slice(0, 5), // proposed, auth A, auth B, lock submitted, BetCreated
      betState('LOCKED', 'AWAITING_LOCK'),
      ev('attempt.started', {
        attempt_no: 1,
        performer: 'A',
        max_ms: 30000,
        recorder_device_id: '00000000-0000-4000-8000-0000000000d1',
        go_at: '2026-11-21T18:05:40.000Z',
      }),
      ev('ruling.issued', { ruling: redo, ruling_hash: 'cd'.repeat(32) }),
      ev('attempt.started', {
        attempt_no: 2,
        performer: 'A',
        max_ms: 30000,
        recorder_device_id: '00000000-0000-4000-8000-0000000000d1',
        go_at: '2026-11-21T18:05:50.000Z',
      }),
      ev('ruling.issued', { ruling, ruling_hash: 'ab'.repeat(32) }),
      ev(base[6]!.type, base[6]!.payload), // BetResolved
      betState('RULED', 'JUDGING'),
    ];
  }
  const card = (s: TickerState) => ({ ...s.bets[BET]!, updated_at: 0 });

  it('a seq-0 replay after a newer live event does not regress the card', () => {
    const frames = pitch();
    const inOrder = run(frames);
    expect(inOrder.dropped).toBe(0);
    expect(inOrder.bets[BET]).toMatchObject({
      state: 'RULED',
      auth_count: 2,
      attempt_no: 2,
      ruling: { outcome: 'B_WINS', ruling_hash: 'ab'.repeat(32) },
    });

    // live: the last event first, then the replay of everything before it
    const live = run([frames.at(-1), ...frames.slice(0, -1)]);
    expect(live.dropped).toBe(0);
    expect(card(live)).toEqual(card(inOrder));
    expect(live.bets[BET]!.state).toBe('RULED');

    // the reported case: live bet.state LOCKED (seq 6), then replayed seq 1-5: stays LOCKED
    let s = run([frames[5]]);
    expect(s.bets[BET]!.state).toBe('LOCKED');
    s = run(frames.slice(0, 5), s);
    expect(s.bets[BET]).toMatchObject({ state: 'LOCKED', auth_count: 2 });
    expect(s.bets[BET]!.auth.B?.method).toBe('passcode_hold');

    // any interleaving converges on the in-order card; the ticker keeps every event once
    const shuffled = [...frames].reverse();
    const r = run([...shuffled, ...frames]);
    expect(card(r)).toEqual(card(inOrder));
    expect(r.events).toHaveLength(frames.length);
  });

  it('a REST snapshot older than the live events does not roll the state back', () => {
    const frames = pitch();
    const snapshot = (last_seq: number, state: BetSnapshot['state']): BetSnapshot => ({
      bet_id: BET,
      room_id: null,
      state,
      prev_state: null,
      onchain_status: null,
      chain_ack: 'stream',
      pending_tx: null,
      party_a: {
        user_id: '00000000-0000-4000-8000-00000000000a',
        pubkey: PK.a as never,
        display_name: 'Logan',
        avatar_url: null,
      },
      party_b: {
        user_id: '00000000-0000-4000-8000-00000000000b',
        pubkey: PK.b as never,
        display_name: 'Jake',
        avatar_url: null,
      },
      my_party: null,
      envelope: null,
      draft: null,
      authorizations: { A: null, B: null },
      deadlines: {
        accept_deadline: null,
        resolve_deadline: null,
        appeal_deadline: null,
        appeal_resolve_deadline: null,
      },
      attempt_no: null,
      redo_count: 0,
      latest_ruling: null,
      appeal: null,
      payout: null,
      signatures: { lock: SIG_LOCK as never },
      end_reason: null,
      last_seq,
    });
    // fetched at seq 3 (AWAITING_AUTHORIZATIONS), lands after the live bet reached RULED
    let s = run(frames);
    s = applyFrame(s, {
      kind: 'snapshot',
      bet: snapshot(3, 'AWAITING_AUTHORIZATIONS'),
      receivedAt: 2,
    });
    expect(s.bets[BET]).toMatchObject({ state: 'RULED', auth_count: 2, attempt_no: 2 });
    expect(s.bets[BET]!.ruling?.ruling_hash).toBe('ab'.repeat(32));

    // snapshot first, then the replay of the seqs it already covers: its state holds until a
    // newer event moves it
    s = applyFrame(initialTicker, {
      kind: 'snapshot',
      bet: snapshot(6, 'LOCKED'),
      receivedAt: 1,
    });
    s = run(frames.slice(0, 5), s);
    expect(s.bets[BET]).toMatchObject({ state: 'LOCKED', names: { A: 'Logan', B: 'Jake' } });
    s = run(frames.slice(5), s);
    expect(s.bets[BET]!.state).toBe('RULED');

    // a fresh snapshot (last_seq >= everything seen) still lays on top
    s = applyFrame(s, { kind: 'snapshot', bet: snapshot(99, 'FINALIZED'), receivedAt: 3 });
    expect(s.bets[BET]!.state).toBe('FINALIZED');
  });

  it('tx.failed on the lock shows the error; market.tick does not steal the focus', () => {
    seq = 0;
    let s = run([
      ev('tx.failed', { kind: 'atomic_lock', signature: null, error: 'BlockhashNotFound' }),
    ]);
    expect(s.bets[BET]!.lock).toMatchObject({
      status: 'failed',
      error: 'BlockhashNotFound',
      signers: 3,
    });
    const other = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
    s = applyFrame(s, frame({ ...ev('market.tick', { snapshot: snap() }), bet_id: other }));
    expect(s.focusBetId).toBe(BET);
    expect(s.events.at(-1)?.type).toBe('market.tick');
  });
});

describe('odds widget', () => {
  it('stage.market frames feed the widget; a rollover resets the chart', () => {
    let s = applyFrame(initialTicker, frame({ op: 'stage.market', snapshot: snap() }, T));
    s = applyFrame(
      s,
      frame({ op: 'stage.market', snapshot: snap({ indexPrice: '64400.1' }) }, T + 2000),
    );
    expect(s.marketTicks).toBe(2);
    expect(s.marketHistory.map((h) => h.price)).toEqual([64379.76, 64400.1]);
    s = applyFrame(
      s,
      frame({ op: 'stage.market', snapshot: snap({ eventTicker: 'BTC05M2611180245' }) }, T + 4000),
    );
    expect(s.marketHistory).toHaveLength(1);
    expect(s.market?.eventTicker).toBe('BTC05M2611180245');
  });

  it('strike, BTC vs the line, countdown, Up %, fair split of a $10 pot', () => {
    const v = marketView(snap(), [{ price: 64379.76 }], T, null);
    expect(v).toMatchObject({
      strike: '64389.6',
      price: '64379.76',
      direction: 'down',
      msLeft: 169_000,
      upPct: 61, // (54 + 67) / 2 = 60.5, half-up as fairStakes prices it (the bet locks 0.61)
      split: { ok: true, up: '6100000', down: '3900000', pot: '10000000', fromTerms: false },
    });
    const html = renderToString(<OddsWidget view={v} />);
    expect(html).toContain('$64,389.60');
    expect(html).toContain('$64,379.76');
    expect(html).toContain('2:49');
    expect(html).toContain('Up <!-- -->$6.10');
    expect(html).toContain('fair stakes');
  });

  it('refusals show instead of a split; a gemini bet on this contract shows its locked stakes', () => {
    const late = marketView(snap(), [], Date.parse('2026-11-18T02:38:30.000Z'), null);
    expect(late.split).toEqual({ ok: false, reason: 'QUOTE_STALE' });
    const pending = marketView(
      snap({ strike: { value: null, type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' } }),
      [],
      T,
      null,
    );
    expect(pending.split).toEqual({ ok: false, reason: 'STRIKE_PENDING' });
    const bet = emptyBet(BET);
    bet.envelope = {
      ...envelope,
      terms: {
        ...terms,
        type: 'real_world',
        market: { eventTicker: 'BTC05M2611180240', side: 'NO' },
        stakes: { a: '3800000', b: '6200000', currency: 'USDC' },
      },
    } as never;
    const locked = marketView(snap(), [], T, bet);
    expect(locked.split).toEqual({
      ok: true,
      up: '6200000',
      down: '3800000',
      pot: '10000000',
      fromTerms: true,
    });
  });
});

describe('stage layout', () => {
  it('StageView: waiting states, then the focused bet + widget + ticker', () => {
    const empty = renderToString(<StageView state={initialTicker} now={T} />);
    expect(empty).toContain('Waiting for a challenge');
    expect(empty).toContain('Waiting for the market');
    const s = applyFrame(run(fullBet()), frame({ op: 'stage.market', snapshot: snap() }, T));
    const html = renderToString(<StageView state={s} now={T} />);
    expect(html).toContain('Logan');
    expect(html).toContain('BTC 5-min');
    expect(html).toContain('chain.BetResolved');
    expect(html).toContain(explorerTx(SIG_RESOLVE).replace(/&/g, '&amp;'));
  });

  it('REPLAY overlay is labelled and points at public/replay/beat{n}.mp4', () => {
    const html = renderToString(<ReplayOverlay beat={3} onClose={() => {}} />);
    expect(html).toContain('REPLAY · beat <!-- -->3');
    expect(html).toContain('/replay/beat3.mp4');
  });

  it('helpers', () => {
    expect(clock(61_000)).toBe('1:01');
    expect(clock(-5)).toBe('0:00');
    expect(shortSig(SIG_LOCK)).toBe('5555…5555');
  });
});

describe('connection extras', () => {
  class FakeWs implements WsLike {
    readyState = 1;
    sent: unknown[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    send(d: string) {
      this.sent.push(JSON.parse(d));
    }
    close() {}
  }

  it('hello carries bet subs; subscribe() sends once; a reconnect resumes after the last seq', () => {
    const sockets: FakeWs[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const conn = new StageConnection({
      wsUrl: 'ws://h/v1/ws',
      token: 'yo_s_t',
      roomId: BET,
      onAction: () => {},
      subs: [{ bet_id: BET, after_seq: 0 }],
      makeSocket: () => {
        const s = new FakeWs();
        sockets.push(s);
        return s;
      },
      random: () => 0,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: () => {},
    });
    conn.start();
    sockets[0]!.onopen?.({});
    expect(sockets[0]!.sent[0]).toEqual({
      op: 'hello',
      token: 'yo_s_t',
      subs: [{ bet_id: BET, after_seq: 0 }],
    });
    const other = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
    conn.subscribe(other);
    conn.subscribe(other);
    expect(sockets[0]!.sent.filter((f) => (f as { op: string }).op === 'subscribe')).toEqual([
      { op: 'subscribe', bet_id: other, after_seq: 0 },
    ]);
    conn.noteSeq(BET, 12);
    sockets[0]!.onclose?.({ code: 1006, reason: '' });
    timers.find((t) => t.ms === 250)!.fn();
    sockets[1]!.onopen?.({});
    expect((sockets[1]!.sent[0] as { subs: unknown }).subs).toEqual([
      { bet_id: BET, after_seq: 12 },
      { bet_id: other, after_seq: 0 },
    ]);
  });

  it('fetchMarket / fetchBetSnapshot send the bearer and parse with the shared schemas', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const f = (async (u: string, i?: RequestInit) => {
      calls.push([u, i]);
      if (u.endsWith('/v1/markets/btc5m/current'))
        return new Response(JSON.stringify({ market: snap(), window: null }), { status: 200 });
      return new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
    }) as unknown as typeof fetch;
    await expect(fetchMarket('https://h.dev', 'yo_s_t', f)).resolves.toMatchObject({
      eventTicker: 'BTC05M2611180240',
    });
    expect((calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer yo_s_t');
    await expect(fetchBetSnapshot('https://h.dev', 'yo_s_t', BET, f)).rejects.toThrow(
      /404 NOT_FOUND/,
    );
    expect(calls[1]![0]).toBe(`https://h.dev/v1/bets/${BET}`);
  });
});
