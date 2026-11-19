// The live display store: per-frame writes, throttled notifications, popups.
import type { LivePlayerState, LiveUpdate } from '@youre-on/shared/dance/score';
import { describe, expect, it } from 'vitest';

import {
  createLiveStore,
  LIVE_MIN_INTERVAL_MS,
  POPUP_TTL_MS,
  POPUPS_PER_PLAYER,
  prunePopups,
  type Popup,
  type StoreTimer,
} from '../model/liveStore';

function fakeTimer() {
  let now = 0;
  const queue: { at: number; fn: () => void; live: boolean }[] = [];
  const timer: StoreTimer = {
    now: () => now,
    schedule: (fn, ms) => {
      const job = { at: now + ms, fn, live: true };
      queue.push(job);
      return () => {
        job.live = false;
      };
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const job of queue.splice(0)) {
      if (!job.live) continue;
      if (job.at <= now) job.fn();
      else queue.push(job);
    }
  };
  return { timer, advance };
}

const player = (meter: number): LivePlayerState => ({
  meter,
  sim: 0.9,
  lagMs: 40,
  limbs: new Array(9).fill(0.8),
  convention: 'identity',
});

const update = (a: number, b: number, events: LiveUpdate['events'] = []): LiveUpdate => ({
  a: player(a),
  b: player(b),
  events,
});

describe('live store', () => {
  it('notifies at most once per interval, with the latest values', () => {
    const { timer, advance } = fakeTimer();
    const store = createLiveStore({ timer });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    // The first write goes out at once (nothing was sent yet).
    store.update({ fps: 10 });
    advance(0);
    expect(calls).toBe(1);
    store.update({ fps: 20 });
    store.update({ fps: 30 });
    advance(10);
    expect(calls).toBe(1);
    advance(LIVE_MIN_INTERVAL_MS);
    expect(calls).toBe(2);
    expect(store.get().fps).toBe(30);
  });

  it('get() sees writes at once (the throttle is for listeners only)', () => {
    const { timer } = fakeTimer();
    const store = createLiveStore({ timer });
    store.update((v) => ({ frames: v.frames + 3 }));
    expect(store.get().frames).toBe(3);
    expect(store.get().version).toBe(1);
  });

  it('flush() delivers a pending write now', () => {
    const { timer } = fakeTimer();
    const store = createLiveStore({ timer });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.update({ fps: 1 });
    store.flush();
    expect(calls).toBe(1);
    store.flush();
    expect(calls).toBe(1);
  });

  it('applyLive sets the meters and adds a popup per key-move event', () => {
    const { timer } = fakeTimer();
    const store = createLiveStore({ timer });
    store.applyLive(
      update(55, 70, [
        { key_move_id: 'k01', name: 'T pose', t: 1_000, player: 'A', grade: 'PERFECT' },
        { key_move_id: 'k01', name: 'T pose', t: 1_000, player: 'B', grade: 'MISS' },
      ]),
    );
    const v = store.get();
    expect(v.meterA).toBe(55);
    expect(v.meterB).toBe(70);
    expect(v.liveA?.lagMs).toBe(40);
    expect(v.popups.map((p) => [p.player, p.grade])).toEqual([
      ['A', 'PERFECT'],
      ['B', 'MISS'],
    ]);
    expect(new Set(v.popups.map((p) => p.id)).size).toBe(2);
  });

  it('reset() empties it and tells listeners', () => {
    const { timer } = fakeTimer();
    const store = createLiveStore({ timer });
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.update({ frames: 9, meterA: 40 });
    store.reset();
    expect(calls).toBe(1);
    expect(store.get().frames).toBe(0);
    expect(store.get().meterA).toBe(0);
  });

  it('unsubscribe stops notifications', () => {
    const { timer, advance } = fakeTimer();
    const store = createLiveStore({ timer });
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    off();
    store.update({ fps: 1 });
    advance(100);
    expect(calls).toBe(0);
  });
});

describe('prunePopups', () => {
  const pop = (id: number, player: 'A' | 'B', at: number): Popup => ({
    id,
    player,
    grade: 'GOOD',
    name: 'x',
    at,
  });

  it('drops expired ones and keeps the newest few per player', () => {
    const list = [
      pop(1, 'A', 0),
      pop(2, 'A', 500),
      pop(3, 'A', 600),
      pop(4, 'A', 700),
      pop(5, 'B', 0),
    ];
    const kept = prunePopups(list, POPUP_TTL_MS + 1);
    expect(kept.map((p) => p.id)).toEqual([3, 4].slice(-POPUPS_PER_PLAYER));
    expect(prunePopups(list, 700).map((p) => p.id)).toEqual([3, 4, 5]);
  });
});
