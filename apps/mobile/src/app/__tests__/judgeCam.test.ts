import { describe, expect, it } from 'vitest';

import { ApiClientError } from '../../net/signedFetch';
import { checkCopy } from '../../ui/copyRule';
import {
  attemptStartAlert,
  camRestore,
  createJudgeCamSync,
  deviceRoleRequest,
  encodeMemo,
  parseMemo,
  rejoinAndRebind,
  type CamOwner,
  type CamRestore,
} from '../judgeCam';

describe('deviceRoleRequest (PATCH /v1/devices/current)', () => {
  it('binds a judge cam to the room it judges', () => {
    expect(deviceRoleRequest(true, 'room-1')).toEqual({
      ok: true,
      role: 'judge_cam',
      roomId: 'room-1',
    });
  });

  it('needs a room to become a judge cam (the server would 400)', () => {
    expect(deviceRoleRequest(true, null)).toEqual({ ok: false, reason: 'no_room' });
  });

  it('goes back to a phone WITHOUT a room_id, in or out of a room (the server 400s on one)', () => {
    expect(deviceRoleRequest(false, 'room-1')).toEqual({ ok: true, role: 'phone' });
    expect(deviceRoleRequest(false, null)).toEqual({ ok: true, role: 'phone' });
    const r = deviceRoleRequest(false, 'room-1');
    expect(r.ok && r.roomId).toBeUndefined();
  });
});

const A_CAM: CamOwner = { device_id: 'dev-1', user_id: 'user-a' };

describe('the judge-cam memo is bound to this device and this user', () => {
  it('round-trips', () => {
    expect(parseMemo(encodeMemo(A_CAM, 'judge_cam'))).toEqual({
      v: 1,
      ...A_CAM,
      role: 'judge_cam',
    });
    expect(parseMemo(encodeMemo(A_CAM, 'phone'))?.role).toBe('phone');
  });

  it('comes back as the judge cam only for the same device and user', () => {
    expect(camRestore(encodeMemo(A_CAM, 'judge_cam'), A_CAM)).toBe('judge_cam');
  });

  it('a demo claim as another user on this phone forgets it (the server reset the device)', () => {
    // Case (a) of the review: the rehearsal judge cam claimed as party B must see B's invite.
    const asB = { device_id: 'dev-1', user_id: 'user-b' };
    expect(camRestore(encodeMemo(A_CAM, 'judge_cam'), asB)).toBe('forget');
    expect(camRestore(encodeMemo(A_CAM, 'phone'), asB)).toBe('forget');
  });

  it("another device key's memo is forgotten too", () => {
    const other = { device_id: 'dev-2', user_id: 'user-a' };
    expect(camRestore(encodeMemo(A_CAM, 'judge_cam'), other)).toBe('forget');
  });

  it("the pre-release bare '1' and junk are forgotten, never restored", () => {
    expect(camRestore('1', A_CAM)).toBe('forget');
    expect(camRestore('{"v":1,"role":"judge_cam"}', A_CAM)).toBe('forget');
    expect(camRestore('{nope', A_CAM)).toBe('forget');
    expect(camRestore('null', A_CAM)).toBe('forget');
  });

  it('nothing stored is nothing to do', () => {
    expect(camRestore(null, A_CAM)).toBe('none');
    expect(camRestore('', A_CAM)).toBe('none');
  });

  it('an unconfirmed turn-off is sent again', () => {
    expect(camRestore(encodeMemo(A_CAM, 'phone'), A_CAM)).toBe('send_phone');
  });
});

/** A server double: each PATCH waits for the test to settle it. */
function harness(owner: CamOwner | null = A_CAM) {
  const calls: { role: string; roomId?: string }[] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  let stored: string | null = null;
  let who = owner;
  const sync = createJudgeCamSync({
    setRole: (role, roomId) => {
      calls.push(roomId ? { role, roomId } : { role });
      return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
    },
    save: async (raw) => {
      stored = raw;
    },
    owner: () => who,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    sync,
    calls,
    stored: async () => (await sync.flush(), stored),
    setStored: (raw: string | null) => (stored = raw),
    setOwner: (o: CamOwner | null) => (who = o),
    ok: async (i = pending.length - 1) => (pending[i]!.resolve(), tick()),
    fail: async (i = pending.length - 1, e: unknown = new Error('down')) => (
      pending[i]!.reject(e),
      tick()
    ),
  };
}

describe('createJudgeCamSync: off on screen means phone on the server', () => {
  it('on: remembers the judge cam for this owner and binds it to the room', async () => {
    const h = harness();
    const r = h.sync.on('room-1');
    expect(h.calls).toEqual([{ role: 'judge_cam', roomId: 'room-1' }]);
    await h.ok();
    expect(await r).toEqual({ status: 'ok' });
    expect(camRestore(await h.stored(), A_CAM)).toBe('judge_cam');
  });

  it('off: the memo says pending phone until the server confirms, then it is gone', async () => {
    const h = harness();
    const r = h.sync.off();
    expect(h.sync.phonePending).toBe(true);
    expect(camRestore(await h.stored(), A_CAM)).toBe('send_phone');
    await h.ok();
    expect(await r).toEqual({ status: 'ok' });
    expect(h.sync.phonePending).toBe(false);
    expect(await h.stored()).toBeNull();
  });

  it('a failed turn-off is re-sent when the socket is live again (the old comment lied)', async () => {
    const h = harness();
    const r = h.sync.off();
    await h.fail();
    expect((await r).status).toBe('failed');
    expect(h.sync.phonePending).toBe(true);
    // Restart now: the memo still asks for 'phone'.
    expect(camRestore(await h.stored(), A_CAM)).toBe('send_phone');
    const again = h.sync.retry();
    expect(again).not.toBeNull();
    expect(h.calls.map((c) => c.role)).toEqual(['phone', 'phone']);
    await h.ok();
    expect(await again).toEqual({ status: 'ok' });
    expect(h.sync.phonePending).toBe(false);
    expect(h.sync.retry()).toBeNull();
  });

  it('retry sends nothing while a phone PATCH is already in flight, or when nothing is pending', async () => {
    const h = harness();
    expect(h.sync.retry()).toBeNull();
    void h.sync.off();
    expect(h.sync.retry()).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it('a failed turn-on also sends phone (an older binding may remain on the server)', async () => {
    const h = harness();
    const r = h.sync.on('room-1');
    await h.fail(0);
    expect((await r).status).toBe('failed');
    expect(h.calls).toEqual([{ role: 'judge_cam', roomId: 'room-1' }, { role: 'phone' }]);
    expect(camRestore(await h.stored(), A_CAM)).toBe('send_phone');
    await h.ok(1);
    expect(await h.stored()).toBeNull();
  });

  it('turning it on again cancels a pending phone', async () => {
    const h = harness();
    const off = h.sync.off();
    await h.fail(0);
    await off;
    const on = h.sync.on('room-1');
    expect(h.sync.phonePending).toBe(false);
    expect(h.sync.retry()).toBeNull();
    await h.ok(1);
    expect(await on).toEqual({ status: 'ok' });
    expect(camRestore(await h.stored(), A_CAM)).toBe('judge_cam');
  });

  it("an older request's late answer does not undo a newer one", async () => {
    const h = harness();
    const off = h.sync.off();
    const on = h.sync.on('room-1');
    await h.ok(0); // the stale 'phone' lands after the user turned it back on
    expect(await off).toEqual({ status: 'superseded' });
    expect(camRestore(await h.stored(), A_CAM)).toBe('judge_cam');
    await h.fail(1); // the newer turn-on fails: that one is news
    expect((await on).status).toBe('failed');
  });

  it("restore: another user's memo is deleted and a stale pending phone is dropped", async () => {
    const h = harness();
    const off = h.sync.off();
    await h.fail(0);
    await off;
    h.setOwner({ device_id: 'dev-1', user_id: 'user-b' });
    expect(h.sync.restore(encodeMemo(A_CAM, 'phone'))).toBe('forget');
    expect(h.sync.phonePending).toBe(false);
    expect(await h.stored()).toBeNull();
  });

  it('restore: an unconfirmed turn-off of this owner is pending again', () => {
    const h = harness();
    expect(h.sync.restore(encodeMemo(A_CAM, 'phone'))).toBe('send_phone');
    expect(h.sync.phonePending).toBe(true);
    expect(h.sync.restore(encodeMemo(A_CAM, 'judge_cam'))).toBe('judge_cam');
    expect(h.sync.phonePending).toBe(false);
  });

  it('a request still in flight when the user switches is superseded', async () => {
    const h = harness();
    const on = h.sync.on('room-1');
    h.setOwner({ device_id: 'dev-1', user_id: 'user-b' });
    h.sync.restore(null);
    await h.fail(0);
    expect(await on).toEqual({ status: 'superseded' });
    expect(h.calls).toHaveLength(1); // no 'phone' on the new user's behalf
  });
});

describe('rejoinAndRebind: a restored judge cam re-binds the room it just rejoined', () => {
  /** The app state lags: currentRoomId() keeps answering what the last render saw. */
  function run(o: {
    restored: CamRestore;
    stored?: string | null;
    linked?: string | null;
    shown?: string | null;
    joins?: Record<string, string | null>;
    stillOn?: () => boolean;
  }) {
    const joined: string[] = [];
    const bound: (string | null)[] = [];
    const done = rejoinAndRebind({
      restored: o.restored,
      linked: o.linked ?? null,
      storedCode: () => Promise.resolve(o.stored ?? null),
      currentRoomId: () => o.shown ?? null,
      join: (code) => {
        joined.push(code);
        return Promise.resolve(o.joins?.[code] ?? null);
      },
      live: () => true,
      stillOn: o.stillOn ?? (() => true),
      bind: (roomId) => bound.push(roomId),
    });
    return { done, joined, bound };
  }

  it('binds the room the join returned, not the stale room on screen (it used to turn off)', async () => {
    const r = run({ restored: 'judge_cam', stored: 'ABC123', joins: { ABC123: 'room-1' } });
    expect(await r.done).toBe(true);
    expect(r.joined).toEqual(['ABC123']);
    expect(r.bound).toEqual(['room-1']);
  });

  it('keeps the room on screen when no join is needed', async () => {
    const r = run({ restored: 'judge_cam', stored: 'ABC123', shown: 'room-0' });
    await r.done;
    expect(r.joined).toEqual([]);
    expect(r.bound).toEqual(['room-0']);
  });

  it('a room link wins over the stored room, even with a room on screen', async () => {
    const r = run({
      restored: 'judge_cam',
      stored: 'ABC123',
      linked: 'LINK42',
      shown: 'room-0',
      joins: { LINK42: 'room-2' },
    });
    await r.done;
    expect(r.joined).toEqual(['LINK42']);
    expect(r.bound).toEqual(['room-2']);
  });

  it('no room to rejoin: binds null (the caller turns it off and says "Join room first")', async () => {
    const r = run({ restored: 'judge_cam', stored: 'GONE01', joins: { GONE01: null } });
    // false: the caller tries the rejoin again once the socket is live (offline at a cold start)
    expect(await r.done).toBe(false);
    expect(r.bound).toEqual([null]);
  });

  it('nothing to rejoin, or a room already on screen: done', async () => {
    expect(await run({ restored: 'none' }).done).toBe(true);
    expect(await run({ restored: 'none', stored: 'ABC123', shown: 'room-0' }).done).toBe(true);
  });

  it('a plain phone rejoins its room and binds nothing', async () => {
    const r = run({ restored: 'none', stored: 'ABC123', joins: { ABC123: 'room-1' } });
    await r.done;
    expect(r.joined).toEqual(['ABC123']);
    expect(r.bound).toEqual([]);
  });

  it('turned off while the join was in flight: binds nothing', async () => {
    let on = true;
    const r = run({
      restored: 'judge_cam',
      stored: 'ABC123',
      joins: { ABC123: 'room-1' },
      stillOn: () => on,
    });
    on = false;
    await r.done;
    expect(r.bound).toEqual([]);
  });
});

describe('createJudgeCamSync.restoredOn: the restored judge cam, untouched since', () => {
  it('is true after a judge_cam restore until the next on/off, false otherwise', () => {
    const h = harness();
    expect(h.sync.restoredOn).toBe(false);
    h.sync.restore(encodeMemo(A_CAM, 'judge_cam'));
    expect(h.sync.restoredOn).toBe(true);
    void h.sync.off();
    expect(h.sync.restoredOn).toBe(false);
    h.sync.restore(encodeMemo(A_CAM, 'phone'));
    expect(h.sync.restoredOn).toBe(false);
  });
});

const apiError = (code: string, status: number, details?: Record<string, unknown>) =>
  new ApiClientError(code, status, 'server text', false, details);

describe('attemptStartAlert (A taps Start)', () => {
  it("says there is no judge cam instead of doing nothing (the server's no_judge_cam 409)", () => {
    const e = apiError('INVALID_STATE', 409, { state: 'LOCKED', reason: 'no_judge_cam' });
    expect(attemptStartAlert(e)).toBe('No judge cam');
    expect(checkCopy('No judge cam', 'error')).toEqual([]);
  });

  it('stays quiet on the benign INVALID_STATE races (already started, double tap)', () => {
    expect(attemptStartAlert(apiError('INVALID_STATE', 409, { state: 'ATTEMPT' }))).toBeNull();
    expect(attemptStartAlert(apiError('INVALID_STATE', 409))).toBeNull();
  });

  it('says offline on a network failure and try again otherwise', () => {
    expect(attemptStartAlert(new ApiClientError('NETWORK', 0, 'x', true))).toBe("Can't connect");
    expect(attemptStartAlert(apiError('INTERNAL', 500))).toBe('Try again');
    expect(attemptStartAlert(new Error('boom'))).toBe('Try again');
  });
});
