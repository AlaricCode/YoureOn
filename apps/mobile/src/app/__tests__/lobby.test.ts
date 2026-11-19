import type { RoomMember } from '@youre-on/shared/api';
import { describe, expect, it } from 'vitest';

import { checkCopy } from '../../ui/copyRule';
import { COPY, t } from '../../screens/copy';
import { rejoinAndRebind, type CamRestore } from '../judgeCam';
import {
  homeJoinPlan,
  homeMode,
  isLobby,
  lobbyMembers,
  lobbyWanted,
  runJoinPlan,
  shouldRejoinLobby,
  type JoinStep,
} from '../lobby';
import { initialApp, type AppState, type RoomInfo } from '../machine';
import { ME_A, ME_B } from './fixtures';

const LOBBY: RoomInfo = { room_id: 'room-lobby', code: 'LOBBY7', name: 'Lobby', lobby: true };
const PRIVATE: RoomInfo = { room_id: 'room-1', code: 'ABC123', name: 'ABC123' };
const ON = { enabled: true, privateChosen: false };

const signedIn = (o: Partial<AppState> = {}): AppState => ({
  ...initialApp,
  auth: 'signedIn',
  me: ME_A,
  ...o,
});

describe('lobbyWanted / shouldRejoinLobby: when a phone joins the lobby by itself', () => {
  it('is wanted unless it is off or a private room was chosen this launch', () => {
    expect(lobbyWanted(ON)).toBe(true);
    expect(lobbyWanted({ enabled: false, privateChosen: false })).toBe(false);
    expect(lobbyWanted({ enabled: true, privateChosen: true })).toBe(false);
  });

  it('re-joins with no room, or to refresh the lobby it is in', () => {
    expect(shouldRejoinLobby(ON, signedIn())).toBe(true);
    expect(shouldRejoinLobby(ON, signedIn({ room: LOBBY }))).toBe(true);
  });

  it('leaves a private room, a judge cam in the lobby and a signed-out phone alone', () => {
    expect(shouldRejoinLobby(ON, signedIn({ room: PRIVATE }))).toBe(false);
    expect(shouldRejoinLobby(ON, signedIn({ room: LOBBY, judgeCam: true }))).toBe(false);
    expect(shouldRejoinLobby(ON, { ...initialApp, auth: 'signedOut' })).toBe(false);
    expect(shouldRejoinLobby({ enabled: true, privateChosen: true }, signedIn())).toBe(false);
    expect(shouldRejoinLobby({ enabled: false, privateChosen: false }, signedIn())).toBe(false);
  });

  it('isLobby reads the flag the lobby join sets', () => {
    expect(isLobby(LOBBY)).toBe(true);
    expect(isLobby(PRIVATE)).toBe(false);
    expect(isLobby(null)).toBe(false);
  });
});

describe('homeJoinPlan: what a phone with no room joins', () => {
  it('a room link wins over everything', () => {
    expect(homeJoinPlan({ linked: 'LINK42', lobby: true, stored: 'ABC123' })).toEqual([
      { kind: 'code', code: 'LINK42' },
    ]);
  });

  it('the last private room first, the lobby as the fallback; no private room: the lobby', () => {
    expect(homeJoinPlan({ linked: null, lobby: true, stored: 'ABC123' })).toEqual([
      { kind: 'code', code: 'ABC123' },
      { kind: 'lobby' },
    ]);
    expect(homeJoinPlan({ linked: null, lobby: true, stored: null })).toEqual([{ kind: 'lobby' }]);
  });

  it('lobby off: exactly the old rejoin', () => {
    expect(homeJoinPlan({ linked: null, lobby: false, stored: 'ABC123' })).toEqual([
      { kind: 'code', code: 'ABC123' },
    ]);
    expect(homeJoinPlan({ linked: null, lobby: false, stored: null })).toEqual([]);
  });
});

describe('runJoinPlan', () => {
  const deps = (o: { lobby?: string | null | Error; codes?: Record<string, string | null> }) => {
    const calls: string[] = [];
    return {
      calls,
      d: {
        joinLobby: () => {
          calls.push('lobby');
          return o.lobby instanceof Error
            ? Promise.reject(o.lobby)
            : Promise.resolve(o.lobby ?? null);
        },
        joinCode: (code: string) => {
          calls.push(code);
          return Promise.resolve(o.codes?.[code] ?? null);
        },
        live: () => true,
      },
    };
  };
  const plan: JoinStep[] = [{ kind: 'lobby' }, { kind: 'code', code: 'ABC123' }];

  it('stops at the lobby when it works', async () => {
    const h = deps({ lobby: 'room-lobby' });
    expect(await runJoinPlan(plan, h.d)).toEqual({
      tried: true,
      roomId: 'room-lobby',
      via: 'lobby',
    });
    expect(h.calls).toEqual(['lobby']);
  });

  it('goes on to the next step when one fails or throws', async () => {
    for (const lobby of [null, new Error('404')]) {
      const h = deps({ lobby, codes: { ABC123: 'room-1' } });
      expect(await runJoinPlan(plan, h.d)).toEqual({ tried: true, roomId: 'room-1', via: 'code' });
      expect(h.calls).toEqual(['lobby', 'ABC123']);
    }
  });

  it('all failed: tried, no room (the caller retries); nothing to try: not tried', async () => {
    expect(await runJoinPlan(plan, deps({}).d)).toEqual({ tried: true, roomId: null, via: null });
    expect(await runJoinPlan([], deps({}).d)).toEqual({ tried: false, roomId: null, via: null });
  });

  it('stops when the caller is gone', async () => {
    const h = deps({});
    const r = await runJoinPlan(plan, { ...h.d, live: () => false });
    expect(r.tried).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe('rejoinAndRebind with the lobby', () => {
  function run(o: {
    restored?: CamRestore;
    stored?: string | null;
    linked?: string | null;
    lobby?: string | null;
    joins?: Record<string, string | null>;
  }) {
    const calls: string[] = [];
    const bound: (string | null)[] = [];
    const done = rejoinAndRebind({
      restored: o.restored ?? 'none',
      linked: o.linked ?? null,
      storedCode: () => Promise.resolve(o.stored ?? null),
      currentRoomId: () => null,
      join: (code) => {
        calls.push(code);
        return Promise.resolve(o.joins?.[code] ?? null);
      },
      ...(o.lobby !== undefined
        ? {
            joinLobby: () => {
              calls.push('lobby');
              return Promise.resolve(o.lobby ?? null);
            },
          }
        : {}),
      live: () => true,
      stillOn: () => true,
      bind: (roomId) => bound.push(roomId),
    });
    return { done, calls, bound };
  }

  it('a phone with no private room (none stored) joins the lobby', async () => {
    const r = run({ stored: null, lobby: 'room-lobby' });
    expect(await r.done).toBe(true);
    expect(r.calls).toEqual(['lobby']);
  });

  it('a phone that was in a private room goes back to it after a restart, not the lobby', async () => {
    const r = run({ stored: 'ABC123', lobby: 'room-lobby', joins: { ABC123: 'room-1' } });
    expect(await r.done).toBe(true);
    expect(r.calls).toEqual(['ABC123']);
  });

  it('that room gone: the lobby; both failing retries later', async () => {
    const a = run({ stored: 'GONE01', lobby: 'room-lobby' });
    expect(await a.done).toBe(true);
    expect(a.calls).toEqual(['GONE01', 'lobby']);
    const b = run({ stored: null, lobby: null });
    expect(await b.done).toBe(false);
  });

  it('lobby off on the server (no joinLobby): the stored room alone, as before', async () => {
    const r = run({ stored: 'ABC123', joins: { ABC123: 'room-1' } });
    expect(await r.done).toBe(true);
    expect(r.calls).toEqual(['ABC123']);
    expect(await run({ stored: null }).done).toBe(true);
  });

  it('a room link skips the lobby', async () => {
    const r = run({
      linked: 'LINK42',
      stored: 'ABC123',
      lobby: 'room-lobby',
      joins: { LINK42: 'room-2' },
    });
    await r.done;
    expect(r.calls).toEqual(['LINK42']);
  });

  it('a restored judge cam rejoins its room and binds it; the lobby only if that is gone', async () => {
    const a = run({
      restored: 'judge_cam',
      stored: 'ABC123',
      lobby: 'room-lobby',
      joins: { ABC123: 'room-1' },
    });
    await a.done;
    expect(a.calls).toEqual(['ABC123']);
    expect(a.bound).toEqual(['room-1']);
    const b = run({ restored: 'judge_cam', stored: 'GONE01', lobby: 'room-lobby' });
    await b.done;
    expect(b.calls).toEqual(['GONE01', 'lobby']);
    expect(b.bound).toEqual(['room-lobby']);
    // A judge cam in the lobby stored no code (a lobby join deletes it): back to the lobby.
    const c = run({ restored: 'judge_cam', stored: null, lobby: 'room-lobby' });
    await c.done;
    expect(c.calls).toEqual(['lobby']);
    expect(c.bound).toEqual(['room-lobby']);
  });
});

describe('homeMode: what home shows', () => {
  it('the lobby (also while its first join is in flight), no code entry', () => {
    expect(homeMode({ room: { lobby: true }, lobbyJoining: false, showPrivate: false })).toBe(
      'lobby',
    );
    expect(homeMode({ room: null, lobbyJoining: true, showPrivate: false })).toBe('lobby');
  });

  it('"Private room" opens the code entry over the lobby', () => {
    expect(homeMode({ room: { lobby: true }, lobbyJoining: false, showPrivate: true })).toBe(
      'code',
    );
    expect(homeMode({ room: null, lobbyJoining: true, showPrivate: true })).toBe('code');
  });

  it('a private room shows as today; no room and no lobby join is the code entry', () => {
    expect(homeMode({ room: {}, lobbyJoining: false, showPrivate: false })).toBe('room');
    expect(homeMode({ room: { lobby: false }, lobbyJoining: true, showPrivate: true })).toBe(
      'room',
    );
    expect(homeMode({ room: null, lobbyJoining: false, showPrivate: false })).toBe('code');
  });
});

describe('lobbyMembers', () => {
  const member = (user: typeof ME_A, online: boolean): RoomMember => ({
    user,
    face_enrolled: true,
    online,
    last_seen_at: '2026-11-18T20:00:00.000Z',
  });
  it('lists the people online here now, never me', () => {
    const jake = member(ME_B, true);
    const gone = member({ ...ME_B, user_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, false);
    expect(lobbyMembers([member(ME_A, true), jake, gone], ME_A.user_id)).toEqual([jake]);
  });
});

describe('lobby copy', () => {
  it('follows the copy rule and never shows a code', () => {
    for (const line of [
      COPY.home.everyone,
      COPY.home.lobbyEmpty,
      COPY.home.joining,
      COPY.home.privateRoom,
      COPY.home.back,
      COPY.scan.openApp,
    ])
      expect(checkCopy(line[0], line[1])).toEqual([]);
    expect(t(COPY.scan.openApp)).toBe('Ask them to open the app');
  });
});
