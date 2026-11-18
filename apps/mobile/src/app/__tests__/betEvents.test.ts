// GET /v1/bets/:id/events (API-CONTRACT §2.14) on the phone: the cold-start restore and the 2 s
// gap resync read the bet's log through the real api wrapper (../../net/api), against a fake
// client that answers like the server (seq > after, oldest first, ≤ limit, last_seq = the head),
// and fall back to GET /v1/bets/:id when the route 404s (a server from before it).
import { BET_EVENTS_LIMIT, type BetSnapshot } from '@youre-on/shared/api';
import type { RealtimeEvent } from '@youre-on/shared/realtime';
import { describe, expect, it } from 'vitest';

import { lockSignals } from '../../bets/store';
import { createYoApi } from '../../net/api';
import { ApiClientError, type ApiClient } from '../../net/signedFetch';
import { GAP_WAIT_MS } from '../../net/ws';
import { BetHub } from '../betHub';
import { appReducer, initialApp, selectRoute } from '../machine';
import {
  canConfirm,
  initialTyped,
  typedReducer,
  waitingForAccept,
  type TypedEvent,
} from '../typedTerms';
import {
  authorizeRequest,
  BET,
  DEVICE_A,
  envelope,
  ev,
  ME_A,
  ME_B,
  ROOM,
  snapshot,
  stateEv,
} from './fixtures';

const invited = (seq: number) => ev('bet.invited', { challenger: ME_A, room_id: ROOM }, seq);
const accepted = (seq: number) =>
  ev('bet.invite_answered', { party: 'B', answer: 'accepted' }, seq);
const line = (seq: number) =>
  ev(
    'judge.line',
    {
      utterance_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      text: `line ${seq}`,
      final: true,
    },
    seq,
  );
const proposed = (seq: number) => ev('terms.proposed', { envelope: envelope() }, seq);
const authorized = (party: 'A' | 'B', seq: number, count: 1 | 2) =>
  ev(
    'terms.authorized',
    { party, method: 'faceid_hold', authorized_at: '2026-11-21T18:06:40.000Z', count },
    seq,
  );

/**
 * A fake ApiClient serving GET /v1/bets/:id/events like the server does (and GET /v1/bets/:id),
 * or 404 for the events route (`routeMissing`). `pageCap` is the server's own page size cap.
 */
function fakeServer(o: {
  log: unknown[];
  head?: number;
  snapshot?: () => BetSnapshot;
  routeMissing?: boolean;
  pageCap?: number;
}) {
  const calls: string[] = [];
  const seqOf = (e: unknown) => (e as { seq: number }).seq;
  const client = {
    clock: { now: () => 0, sync: () => undefined, offsetMs: 0 },
    async request(
      method: string,
      path: string,
      opts?: { schema?: { parse(x: unknown): unknown } },
    ) {
      calls.push(`${method} ${path}`);
      const u = new URL(path, 'http://yo.test');
      const parse = (body: unknown) => (opts?.schema ? opts.schema.parse(body) : body);
      if (/^\/v1\/bets\/[^/]+\/events$/.test(u.pathname)) {
        if (o.routeMissing) throw new ApiClientError('NOT_FOUND', 404, 'Not found.', false);
        const after = Number(u.searchParams.get('after'));
        const limit = Math.min(Number(u.searchParams.get('limit')), o.pageCap ?? Infinity);
        const events = o.log.filter((e) => seqOf(e) > after).slice(0, limit);
        return parse({ events, last_seq: o.head ?? Math.max(0, ...o.log.map(seqOf)) });
      }
      if (/^\/v1\/bets\/[^/]+$/.test(u.pathname) && o.snapshot) return parse(o.snapshot());
      throw new ApiClientError('NOT_FOUND', 404, 'No such bet.', false);
    },
  } as unknown as ApiClient;
  const api = createYoApi(client);
  const eventCalls = () => calls.filter((c) => c.includes('/events'));
  return { api, calls, eventCalls };
}

/** A's typed form after A sent the card (terms_hash = the fixture envelope's). */
const aSentCard = () =>
  (
    [
      { type: 'init', bet_id: BET, bName: 'Jake', typed: true },
      { type: 'submit' },
      {
        type: 'submitted',
        outcome: { kind: 'proposed', terms_hash: envelope().terms_hash, code: 'X' },
      },
    ] satisfies TypedEvent[]
  ).reduce(typedReducer, initialTyped);

describe('getBetEvents (the api wrapper)', () => {
  it('asks the contract path with limit=200; keeps the events that parse; says how far the page reached', async () => {
    const { api, calls } = fakeServer({
      log: [
        invited(1),
        stateEv('DRAFTING', 2),
        {
          v: 1,
          type: 'future.thing',
          bet_id: BET,
          seq: 3,
          ts: invited(1).ts,
          source: 'server',
          payload: {},
        },
      ],
      head: 3,
    });
    const r = await api.getBetEvents(BET, 0);
    expect(calls).toEqual([`GET /v1/bets/${BET}/events?after=0&limit=${BET_EVENTS_LIMIT}`]);
    expect(r.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'bet.invited'],
      [2, 'bet.state'],
    ]);
    // seq 3 did not parse here, but the page held it: it is not coming.
    expect(r).toMatchObject({ last_seq: 3, through: 3 });
    expect(await api.getBetEvents(BET, 3)).toEqual({ events: [], last_seq: 3, through: 3 });
  });
});

describe('cold start: BetHub.restore rebuilds the bet from GET /v1/bets/:id/events', () => {
  // B accepted while A's phone was down, after a long voice negotiation: the answer is on the
  // log's second page (pages are 200 envelopes).
  const ACCEPT_AT = 260;
  const HEAD = 420;
  const log: RealtimeEvent[] = [invited(1), stateEv('DRAFTING', 2)];
  for (let s = 3; s <= HEAD; s++) log.push(s === ACCEPT_AT ? accepted(s) : line(s));
  const snapA = () => snapshot({ my_party: 'A', state: 'DRAFTING', last_seq: HEAD });

  it('after a restart A sees "Lock it in" once its card is up, because B had already accepted', async () => {
    const server = fakeServer({ log, snapshot: snapA });
    const hub = new BetHub(server.api); // a fresh app: nothing in memory
    const m = await hub.restore(snapA());
    expect(server.eventCalls()).toEqual([
      `GET /v1/bets/${BET}/events?after=0&limit=200`,
      `GET /v1/bets/${BET}/events?after=200&limit=200`,
      `GET /v1/bets/${BET}/events?after=400&limit=200`,
    ]);
    expect(m.inviteAnswer).toBe('accepted');
    expect(m.challenger?.user_id).toBe(ME_A.user_id);
    expect(m.my_party).toBe('A');
    expect(hub.lastSeq(BET)).toBe(HEAD);
    let app = appReducer(initialApp, { type: 'booted', me: ME_A, deviceId: DEVICE_A });
    app = appReducer(app, { type: 'bet_opened', bet_id: BET });
    expect(selectRoute(app, m)).toBe('negotiate');

    // A sends the terms again; the card arrives by its terms.proposed push.
    hub.push(proposed(HEAD + 1));
    const bet = hub.get(BET)!;
    const typed = aSentCard();
    expect(canConfirm(typed, bet.envelope!.terms_hash, bet.inviteAnswer)).toBe(true);
    expect(waitingForAccept(typed, bet.envelope!.terms_hash, bet.inviteAnswer)).toBe(false);
  });

  it('a server without the route (404) falls back to the snapshot: A is left "Waiting for Jake"', async () => {
    const server = fakeServer({ log, snapshot: snapA, routeMissing: true });
    const hub = new BetHub(server.api);
    const m = await hub.restore(snapA());
    expect(server.eventCalls()).toHaveLength(1);
    expect(m.state).toBe('DRAFTING');
    expect(hub.lastSeq(BET)).toBe(HEAD);
    expect(m.inviteAnswer).toBeNull(); // the snapshot does not carry B's answer
    hub.push(proposed(HEAD + 1));
    const bet = hub.get(BET)!;
    const typed = aSentCard();
    expect(canConfirm(typed, bet.envelope!.terms_hash, bet.inviteAnswer)).toBe(false);
    expect(waitingForAccept(typed, bet.envelope!.terms_hash, bet.inviteAnswer)).toBe(true);
  });

  it("the lock request and B's authorization come back too (A's lock card after a restart)", async () => {
    const lockLog = [
      invited(1),
      stateEv('DRAFTING', 2),
      accepted(3),
      stateEv('TERMS_PROPOSED', 4),
      proposed(5),
      stateEv('AWAITING_AUTHORIZATIONS', 6),
      proposed(7),
      ev('terms.authorize_request', authorizeRequest(), 8),
      authorized('B', 9, 1),
    ];
    const snap = () =>
      snapshot({
        my_party: 'A',
        state: 'AWAITING_AUTHORIZATIONS',
        envelope: envelope(),
        authorizations: {
          A: null,
          B: { method: 'faceid_hold', authorized_at: '2026-11-21T18:06:40.000Z' },
        },
        last_seq: 9,
      });
    const hub = new BetHub(fakeServer({ log: lockLog, snapshot: snap }).api);
    const m = await hub.restore(snap());
    expect(m.authorizeRequest?.lock_request_id).toBe(authorizeRequest().lock_request_id);
    expect(m.termsMismatch).toBe(false);
    expect(m.authorized).toEqual({ A: false, B: true });
    expect(m.inviteAnswer).toBe('accepted');
  });
});

describe('the 2 s gap resync applies the missed events from GET /v1/bets/:id/events, in order', () => {
  it('pages through the gap, applies each missed event once and in seq order, then drains the buffer', async () => {
    let now = 0;
    const log: RealtimeEvent[] = [
      invited(1),
      stateEv('DRAFTING', 2),
      accepted(3),
      // missed while the socket was down:
      stateEv('TERMS_PROPOSED', 4),
      proposed(5),
      stateEv('AWAITING_AUTHORIZATIONS', 6),
      ev('terms.authorize_request', authorizeRequest(), 7),
      authorized('B', 8, 1),
      // live again:
      stateEv('AWAITING_LOCK', 9),
    ];
    const server = fakeServer({ log, pageCap: 2 });
    const hub = new BetHub(server.api, () => now);
    hub.adopt(snapshot({ my_party: 'A', last_seq: 0 }));
    for (const e of log.slice(0, 3)) hub.push(e);
    const seen: { seq: number; type: string; signals: string[] }[] = [];
    hub.onChange((e, before, after) => {
      if (e && before)
        seen.push({
          seq: e.seq,
          type: e.type,
          signals: lockSignals(before, after, e, 'A').map((x) => x.type),
        });
    });

    hub.push(log[8]!); // seq 9 arrives: a gap 4..8
    expect(hub.get(BET)!.state).toBe('DRAFTING');
    await hub.tick();
    expect(server.calls).toEqual([]); // < 2 s: still waiting for the gap to fill by itself
    now = GAP_WAIT_MS;
    await hub.tick();

    expect(server.eventCalls()).toEqual([
      `GET /v1/bets/${BET}/events?after=3&limit=200`,
      `GET /v1/bets/${BET}/events?after=5&limit=200`,
      `GET /v1/bets/${BET}/events?after=7&limit=200`,
    ]);
    expect(server.calls.some((c) => c === `GET /v1/bets/${BET}`)).toBe(false); // no snapshot needed
    expect(seen).toEqual([
      { seq: 4, type: 'bet.state', signals: [] },
      { seq: 5, type: 'terms.proposed', signals: [] },
      { seq: 6, type: 'bet.state', signals: [] },
      { seq: 7, type: 'terms.authorize_request', signals: ['reset'] },
      { seq: 8, type: 'terms.authorized', signals: ['their_signature'] },
      { seq: 9, type: 'bet.state', signals: ['submitted'] },
    ]);
    const m = hub.get(BET)!;
    expect(m).toMatchObject({ state: 'AWAITING_LOCK', inviteAnswer: 'accepted', lastSeq: 9 });
    expect(m.authorizeRequest?.lock_request_id).toBe(authorizeRequest().lock_request_id);
    expect(m.authorized).toEqual({ A: false, B: true });
    expect(hub.lastSeq(BET)).toBe(9);
    // Nothing is left open: the next tick does nothing.
    now += GAP_WAIT_MS;
    await hub.tick();
    expect(server.eventCalls()).toHaveLength(3);
  });

  it('an envelope this build cannot read does not stall the bet: the later ones apply, then the snapshot', async () => {
    let now = 0;
    const unknown = {
      v: 1,
      type: 'future.thing',
      bet_id: BET,
      seq: 5,
      ts: invited(1).ts,
      source: 'server',
      payload: {},
    };
    const log: unknown[] = [
      invited(1),
      stateEv('DRAFTING', 2),
      accepted(3),
      stateEv('TERMS_PROPOSED', 4),
      unknown,
      proposed(6),
      stateEv('AWAITING_AUTHORIZATIONS', 7),
    ];
    const server = fakeServer({
      log,
      snapshot: () =>
        snapshot({ state: 'AWAITING_AUTHORIZATIONS', envelope: envelope(), last_seq: 7 }),
    });
    const hub = new BetHub(server.api, () => now);
    hub.adopt(snapshot({ last_seq: 0 }));
    for (const e of log.slice(0, 3)) hub.push(e as RealtimeEvent);
    const seen: number[] = [];
    hub.onChange((e) => e && seen.push(e.seq));
    hub.push(stateEv('TERMS_PROPOSED', 4));
    hub.push(proposed(6)); // the socket dropped seq 5 (it does not parse): a gap that never fills
    now = GAP_WAIT_MS;
    await hub.tick();
    expect(seen).toEqual([4, 6, 7]);
    expect(hub.lastSeq(BET)).toBe(7);
    // A skipped seq may have carried state: the snapshot is laid over what the log gave.
    expect(server.calls.at(-1)).toBe(`GET /v1/bets/${BET}`);
    expect(hub.get(BET)).toMatchObject({
      state: 'AWAITING_AUTHORIZATIONS',
      inviteAnswer: 'accepted',
    });
  });

  it('a server without the route (404) resyncs from the snapshot instead', async () => {
    let now = 0;
    const server = fakeServer({
      log: [],
      routeMissing: true,
      snapshot: () => snapshot({ state: 'LOCKED', last_seq: 8 }),
    });
    const hub = new BetHub(server.api, () => now);
    hub.adopt(snapshot({ last_seq: 2 }));
    hub.push(stateEv('ATTEMPT', 9));
    now = GAP_WAIT_MS;
    await hub.tick();
    expect(server.calls).toEqual([
      `GET /v1/bets/${BET}/events?after=2&limit=200`,
      `GET /v1/bets/${BET}`,
    ]);
    expect(hub.lastSeq(BET)).toBe(9);
    expect(hub.get(BET)!.state).toBe('ATTEMPT');
  });
});

describe("B's side of the same restart", () => {
  it('B restarted after accepting: no second invite screen', async () => {
    const log = [invited(1), stateEv('DRAFTING', 2), accepted(3)];
    const snapB = () => snapshot({ my_party: 'B', last_seq: 3 });
    const hub = new BetHub(fakeServer({ log, snapshot: snapB }).api);
    const m = await hub.restore(snapB());
    expect(m.inviteAnswer).toBe('accepted');
    let app = appReducer(initialApp, { type: 'booted', me: ME_B, deviceId: DEVICE_A });
    app = appReducer(app, { type: 'bet_opened', bet_id: BET });
    expect(selectRoute(app, m)).toBe('negotiate');
  });
});
