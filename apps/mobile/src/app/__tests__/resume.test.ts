import { MeBetItem } from '@youre-on/shared/api';
import type { RealtimeEvent } from '@youre-on/shared/realtime';
import { describe, expect, it } from 'vitest';

import { BetHub } from '../betHub';
import { appReducer, initialApp, selectRoute } from '../machine';
import { createLiveRetry, resumable } from '../resume';
import { BET, DEVICE_A, envelope, ev, ME_A, ME_B, ROOM, snapshot, stateEv } from './fixtures';

const invited = (seq: number) => ev('bet.invited', { challenger: ME_A, room_id: ROOM }, seq);
const accepted = (seq: number) =>
  ev('bet.invite_answered', { party: 'B', answer: 'accepted' }, seq);

function hubWith(events: RealtimeEvent[] | Error) {
  const calls: string[] = [];
  const hub = new BetHub({
    getBet: async () => snapshot(),
    async getBetEvents(id, after) {
      calls.push(`events ${id} >${after}`);
      if (events instanceof Error) throw events;
      return { events, last_seq: events.at(-1)?.seq ?? 0 };
    },
  });
  const seen: (string | null)[] = [];
  hub.onChange((e) => seen.push(e?.type ?? null));
  return { hub, calls, seen };
}

describe('BetHub.restore (cold start mid-bet)', () => {
  it("B's pending invite comes back: the challenger from the log, B's party from the snapshot", async () => {
    const { hub, calls, seen } = hubWith([invited(1), stateEv('DRAFTING', 2)]);
    const m = await hub.restore(snapshot({ my_party: 'B', last_seq: 2 }));
    expect(calls).toEqual([`events ${BET} >0`]);
    expect(m.my_party).toBe('B');
    expect(m.challenger?.user_id).toBe(ME_A.user_id);
    expect(m.inviteAnswer).toBeNull();
    expect(m.state).toBe('DRAFTING');
    // One change, no replayed events: no haptics, no lock signals, no second invite.
    expect(seen).toEqual([null]);
    // The screen it opens on: the full-screen invite.
    let app = appReducer(initialApp, { type: 'booted', me: ME_B, deviceId: DEVICE_A });
    app = appReducer(app, { type: 'bet_opened', bet_id: BET });
    expect(selectRoute(app, m)).toBe('incoming');
  });

  it('A stays party A (bet.invited on an empty model would have made it B)', async () => {
    const { hub } = hubWith([invited(1), stateEv('DRAFTING', 2), accepted(3)]);
    const m = await hub.restore(snapshot({ my_party: 'A', last_seq: 3 }));
    expect(m.my_party).toBe('A');
    expect(m.inviteAnswer).toBe('accepted');
    let app = appReducer(initialApp, { type: 'booted', me: ME_A, deviceId: DEVICE_A });
    app = appReducer(app, { type: 'bet_opened', bet_id: BET });
    expect(selectRoute(app, m)).toBe('negotiate');
  });

  it('the snapshot wins for what it carries (state, terms), whatever the log replayed', async () => {
    const env = envelope();
    const { hub } = hubWith([invited(1), stateEv('DRAFTING', 2), stateEv('TERMS_PROPOSED', 3)]);
    const m = await hub.restore(
      snapshot({ state: 'AWAITING_AUTHORIZATIONS', envelope: env, last_seq: 4 }),
    );
    expect(m.state).toBe('AWAITING_AUTHORIZATIONS');
    expect(m.envelope?.terms_hash).toBe(env.terms_hash);
    expect(hub.lastSeq(BET)).toBe(4);
  });

  it('events newer than the snapshot apply like live ones (in order, listeners told)', async () => {
    const { hub, seen } = hubWith([invited(1), stateEv('DRAFTING', 2), stateEv('CANCELLED', 3)]);
    const m = await hub.restore(snapshot({ state: 'DRAFTING', last_seq: 2 }));
    expect(m.state).toBe('CANCELLED');
    expect(hub.lastSeq(BET)).toBe(3);
    expect(seen).toEqual([null, 'bet.state']);
  });

  it('without the log (offline) it is a plain adopt of the snapshot', async () => {
    const { hub } = hubWith(new Error('Network request failed'));
    const m = await hub.restore(snapshot({ my_party: 'B', state: 'TERMS_PROPOSED', last_seq: 5 }));
    expect(m.state).toBe('TERMS_PROPOSED');
    expect(hub.lastSeq(BET)).toBe(5);
    // ...except the challenger, which is always party A: B gets the invite back (also the path
    // a server without GET /v1/bets/:id/events takes: it answers 404).
    expect(m.challenger?.user_id).toBe(ME_A.user_id);
    expect(m.inviteAnswer).toBeNull();
    let app = appReducer(initialApp, { type: 'booted', me: ME_B, deviceId: DEVICE_A });
    app = appReducer(app, { type: 'bet_opened', bet_id: BET });
    expect(selectRoute(app, m)).toBe('incoming');
  });
});

describe('resumable', () => {
  const item = (o: Parameters<typeof snapshot>[0]) =>
    MeBetItem.parse({
      ...snapshot(o),
      title: 'Bottle flip',
      opponent: ME_B,
      my_stake: null,
      my_payout: null,
      outcome: null,
      settled_at: null,
      is_seed: false,
    });

  it('keeps the open bets newest first, as the server sends them', () => {
    const a = item({ bet_id: '11111111-1111-4111-8111-111111111111', state: 'TERMS_PROPOSED' });
    const b = item({ bet_id: '22222222-2222-4222-8222-222222222222', state: 'LOCKED' });
    expect(resumable([a, b]).map((s) => s.bet_id)).toEqual([a.bet_id, b.bet_id]);
  });

  it('drops bets that are over and items that do not parse', () => {
    const over = item({ state: 'CANCELLED' });
    const open = item({ bet_id: '33333333-3333-4333-8333-333333333333', state: 'RULED' });
    expect(resumable([over, { nope: 1 }, open]).map((s) => s.state)).toEqual(['RULED']);
    expect(resumable([])).toEqual([]);
  });
});

describe('createLiveRetry: a sign-in step that could not reach the server runs again once it can', () => {
  // Seen on the simulator: A restarted mid-bet while the server was unreachable. The room rejoin
  // and GET /v1/me/bets failed and nothing tried again: with the server back, A sat on home with
  // no room and no bet while B waited on the terms.
  function step(results: boolean[]) {
    let calls = 0;
    const gates: (() => void)[] = [];
    const fn = () =>
      new Promise<boolean>((resolve) => {
        const r = results[calls++] ?? true;
        gates.push(() => resolve(r));
      });
    const settle = async () => {
      gates.shift()?.();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    return { fn, calls: () => calls, settle };
  }

  it('failed at sign-in: runs again on the next live socket, then never again', async () => {
    const s = step([false, true]);
    const r = createLiveRetry(s.fn);
    void r.run();
    await s.settle();
    expect(r.pending).toBe(true);
    r.onLive();
    expect(s.calls()).toBe(2);
    await s.settle();
    expect(r.pending).toBe(false);
    r.onLive();
    expect(s.calls()).toBe(2);
  });

  it('done at sign-in: a live socket runs nothing', async () => {
    const s = step([true]);
    const r = createLiveRetry(s.fn);
    void r.run();
    await s.settle();
    r.onLive();
    expect(s.calls()).toBe(1);
  });

  it('live arrives while the failing run is still out: it runs again right after', async () => {
    const s = step([false, true]);
    const r = createLiveRetry(s.fn);
    void r.run();
    r.onLive(); // the socket came back before the failed request answered
    expect(s.calls()).toBe(1);
    await s.settle();
    expect(s.calls()).toBe(2);
    await s.settle();
    expect(r.pending).toBe(false);
  });

  it('markPending (the step ran elsewhere and failed); stop() ends it for good', () => {
    const s = step([true]);
    const r = createLiveRetry(s.fn);
    r.markPending();
    r.stop();
    r.onLive();
    expect(s.calls()).toBe(0);
    const t = createLiveRetry(s.fn);
    t.markPending();
    t.onLive();
    expect(s.calls()).toBe(1);
  });

  it('a step that throws counts as not done', async () => {
    const r = createLiveRetry(() => Promise.reject(new Error('offline')));
    await r.run();
    expect(r.pending).toBe(true);
  });
});
