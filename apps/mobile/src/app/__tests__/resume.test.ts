import { MeBetItem } from '@youre-on/shared/api';
import type { RealtimeEvent } from '@youre-on/shared/realtime';
import { describe, expect, it } from 'vitest';

import { BetHub } from '../betHub';
import { appReducer, initialApp, selectRoute } from '../machine';
import { resumable } from '../resume';
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
    // ...except the challenger, which is always party A: B gets the invite back (the live
    // server has no GET /v1/bets/:id/events yet, so this is the path it takes today).
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
