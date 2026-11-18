/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are loosely typed in tests */
// GET /v1/me/bets (API-CONTRACT §2.14): party bets, a judge-cam device's room bets, outsiders,
// status filters, the cursor, and the response shape the judge-cam phone polls
// (apps/mobile DemoApp: `?status=active&limit=5`, then `items[].bet_id`).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { devices } from '@youre-on/db';
import { BetSnapshot, MeBetsResponse } from '@youre-on/shared/api';
import { issueAppSession } from '../src/auth/sessions';
import { parseMeBetsQuery } from '../src/me/bets';
import {
  describeDb,
  newKey,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

it('parseMeBetsQuery: defaults, bounds, cursor shape', () => {
  expect(parseMeBetsQuery({})).toEqual({ status: 'all', limit: 20, cursor: null });
  expect(parseMeBetsQuery({ status: 'active', limit: '5' })).toMatchObject({
    status: 'active',
    limit: 5,
  });
  for (const bad of [{ status: 'open' }, { limit: '0' }, { limit: '51' }, { limit: '2.5' }]) {
    expect(() => parseMeBetsQuery(bad)).toThrow();
  }
  expect(() => parseMeBetsQuery({ cursor: 'not-a-bet' })).toThrow();
});

describeDb('GET /v1/me/bets over Postgres', () => {
  let ctx: Ctx;
  let A: SignedUp; // party
  let B: SignedUp; // party
  let C: SignedUp; // room member, not a party; her second device is the room's judge cam
  let D: SignedUp; // in another room with B
  let E: SignedUp; // outsider
  let aCam: SignedUp; // A's second device bound as judge_cam to room 1 (the demo setup)
  let cCam: SignedUp; // C's second device bound as judge_cam to room 1
  let room1: string;
  let active1: string; // A vs B in room 1, DRAFTING
  let cancelled1: string; // A vs B in room 1, CANCELLED (declined)
  let other2: string; // B vs D in room 2, DRAFTING

  const uid = (u: SignedUp) => u.session.user.user_id;
  const signed = async (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw),
      body: raw || undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const post = (u: SignedUp, path: string, body?: unknown) => signed(u, 'POST', path, body);
  const get = async (u: SignedUp, path: string) => {
    const res = await fetch(ctx.base + path, {
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const myBets = async (u: SignedUp, query = '') => {
    const r = await get(u, `/v1/me/bets${query}`);
    expect(r.status).toBe(200);
    return MeBetsResponse.parse(r.json);
  };
  const ids = (r: MeBetsResponse) => r.items.map((i) => i.bet_id);

  async function newRoom(owner: SignedUp, ...members: SignedUp[]) {
    const r = await post(owner, '/v1/rooms', { name: 'Me bets', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members)
      expect((await post(m, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    return r.json!.room_id as string;
  }
  async function challenge(a: SignedUp, b: SignedUp, roomId: string) {
    const r = await post(a, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(b),
      challenge_method: 'list',
    });
    expect(r.status).toBe(201);
    return r.json!.bet.bet_id as string;
  }
  /** A second device of `u` with its own session, bound as the judge cam of `roomId`. */
  async function judgeCam(u: SignedUp, roomId: string): Promise<SignedUp> {
    const key = newKey();
    const [dev] = await ctx.deps.db
      .insert(devices)
      .values({ user_id: uid(u), device_pubkey: key.pubkey })
      .returning({ id: devices.id });
    const s = await issueAppSession(ctx.deps.db, {
      user_id: uid(u),
      device_id: dev!.id,
      now: Date.now(),
    });
    const cam: SignedUp = {
      device: key,
      wallet: u.wallet,
      session: { ...u.session, token: s.token, session_id: s.session_id, device_id: dev!.id },
    };
    const bound = await signed(cam, 'PATCH', '/v1/devices/current', {
      role: 'judge_cam',
      room_id: roomId,
    });
    expect(bound.status).toBe(204);
    return cam;
  }

  beforeAll(async () => {
    ctx = await startTestServer();
    [A, B, C, D, E] = await Promise.all([
      signUp(ctx.base, 'Logan'),
      signUp(ctx.base, 'Jake'),
      signUp(ctx.base, 'Carol'),
      signUp(ctx.base, 'Dana'),
      signUp(ctx.base, 'Eve'),
    ]);
    room1 = await newRoom(A, B, C);
    const room2 = await newRoom(B, D);
    cancelled1 = await challenge(A, B, room1);
    expect((await post(B, `/v1/bets/${cancelled1}/invite/decline`)).status).toBe(200);
    active1 = await challenge(A, B, room1);
    other2 = await challenge(B, D, room2);
    aCam = await judgeCam(A, room1);
    cCam = await judgeCam(C, room1);
  });
  afterAll(async () => {
    await ctx?.server.close();
  });

  it('party: every bet I am in, newest first; items are the GET /v1/bets/:id snapshot + summary', async () => {
    const all = await myBets(A);
    expect(ids(all)).toEqual([active1, cancelled1]);
    expect(all.next_cursor).toBeNull();
    const [item] = all.items;
    const snap = BetSnapshot.parse((await get(A, `/v1/bets/${active1}`)).json);
    expect(BetSnapshot.parse(item)).toEqual(snap); // a phone can adopt the item as-is
    expect(item).toMatchObject({
      access: 'party',
      my_party: 'A',
      state: 'DRAFTING',
      room_id: room1,
      title: 'Challenge', // no terms yet
      opponent: { user_id: uid(B), display_name: 'Jake' },
      my_stake: null,
      my_payout: null,
      outcome: null,
      settled_at: null,
      is_seed: false,
    });
    expect(all.items[1]).toMatchObject({ state: 'CANCELLED', end_reason: 'declined' });

    expect(ids(await myBets(A, '?status=active'))).toEqual([active1]);
    expect(ids(await myBets(A, '?status=settled'))).toEqual([]);
    // B sees both rooms' bets, as B.
    const b = await myBets(B, '?status=active');
    expect(ids(b)).toEqual([other2, active1]);
    expect(b.items.every((i) => i.my_party === 'B' || i.my_party === 'A')).toBe(true);
    expect(b.items.find((i) => i.bet_id === other2)!.my_party).toBe('A');
    expect(b.items.find((i) => i.bet_id === active1)!.my_party).toBe('B');
  });

  it('cursor pages through the list without gaps or repeats', async () => {
    const p1 = await myBets(A, '?limit=1');
    expect(ids(p1)).toEqual([active1]);
    expect(p1.next_cursor).toBe(active1);
    const p2 = await myBets(A, `?limit=1&cursor=${p1.next_cursor}`);
    expect(ids(p2)).toEqual([cancelled1]);
    expect(p2.next_cursor).toBeNull();
  });

  it("judge cam: A's own cam device (the demo) finds A's active bet in the room, as a party", async () => {
    const r = await myBets(aCam, '?status=active&limit=5');
    expect(ids(r)).toEqual([active1]);
    expect(r.items[0]).toMatchObject({ access: 'party', my_party: 'A' });
  });

  it("judge cam of a non-party: the room's active bets only (not other rooms, not ended ones)", async () => {
    const r = await myBets(cCam, '?status=active&limit=5');
    expect(ids(r)).toEqual([active1]);
    expect(r.items[0]).toMatchObject({
      access: 'judge_cam',
      my_party: null,
      opponent: null,
      my_stake: null,
      my_payout: null,
      room_id: room1,
    });
    // status=all still shows only the room's ACTIVE bets to the cam (no history of others).
    expect(ids(await myBets(cCam))).toEqual([active1]);
    // C's ordinary phone is not a judge cam: nothing.
    expect(ids(await myBets(C, '?status=active'))).toEqual([]);
    // Rebinding the cam as a plain phone drops the room's bets.
    const plain = await signed(cCam, 'PATCH', '/v1/devices/current', { role: 'phone' });
    expect(plain.status).toBe(204);
    expect(ids(await myBets(cCam, '?status=active'))).toEqual([]);
    expect(
      (await signed(cCam, 'PATCH', '/v1/devices/current', { role: 'judge_cam', room_id: room1 }))
        .status,
    ).toBe(204);
  });

  it('outsider: sees none of these bets', async () => {
    expect(await myBets(E)).toEqual({ items: [], next_cursor: null });
    expect(ids(await myBets(D))).toEqual([other2]);
  });

  it('auth + validation', async () => {
    const anon = await fetch(ctx.base + '/v1/me/bets');
    expect(anon.status).toBe(401);
    const bad = await get(A, '/v1/me/bets?status=open');
    expect(bad.status).toBe(422);
    expect(bad.json!.error.code).toBe('VALIDATION_FAILED');
    expect((await get(A, '/v1/me/bets?limit=500')).json!.error.code).toBe('VALIDATION_FAILED');
  });
});
