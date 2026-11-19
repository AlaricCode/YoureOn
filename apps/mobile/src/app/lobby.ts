// The shared lobby (POST /v1/rooms/lobby, API-CONTRACT §2.3): every phone joins ONE live room on
// launch, so nobody types a code. A face scan there matches the people who have the app open,
// and the challenge lands on their phone as the usual incoming request (bet.invited goes to
// user:<id>, so being online is enough). Rooms stay under the hood (bets, the stage and face
// matching all need a room_id); a code is the "Private room" option. An explicit code, a new
// room or a youreon://room/ link overrides the lobby for the rest of the launch.
// Pure TS: tested in node.
import type { RoomMember } from '@youre-on/shared/api';

import type { AppState, RoomInfo } from './machine';

/** How often a phone with no room tries the lobby again while it keeps failing. */
export const LOBBY_RETRY_MS = 5_000;
/** A foreground re-join of the lobby, at most this often (it refreshes the room's TTL). */
export const LOBBY_REFRESH_MS = 60_000;

export interface LobbyIntent {
  /** EXPO_PUBLIC_LOBBY !== 'off'. */
  enabled: boolean;
  /** This launch, the user chose a room by code, made one, or opened a room link. */
  privateChosen: boolean;
}

/** The lobby is what this phone should be in when it has no room. */
export const lobbyWanted = (i: LobbyIntent): boolean => i.enabled && !i.privateChosen;

export const isLobby = (room: RoomInfo | null | undefined): boolean => room?.lobby === true;

/**
 * Re-join the lobby now (the app came to the foreground, or a retry tick): signed in, lobby
 * wanted, and either no room or already the lobby (a re-join refreshes it; the server may have
 * replaced an expired lobby with a new room). A private room or a judge-cam phone is left alone.
 */
export function shouldRejoinLobby(
  i: LobbyIntent,
  app: Pick<AppState, 'auth' | 'room' | 'judgeCam'>,
): boolean {
  if (!lobbyWanted(i) || app.auth !== 'signedIn') return false;
  if (app.room === null) return true;
  return isLobby(app.room) && !app.judgeCam;
}

export type JoinStep = { kind: 'lobby' } | { kind: 'code'; code: string };

/**
 * The joins to try, in order, for a phone with no room: a room link's code alone (it wins);
 * else the last private room's code first, then the lobby. LAST_ROOM_KEY only ever holds a
 * private room (a lobby join deletes it, Leave deletes it), so a phone that was in a private
 * room before a restart goes back there (the demo phones the stage watches, a restored judge
 * cam bound to that room), and the lobby is the fallback when that room is gone. With no
 * stored code (never in a private room, or it left one) it is the lobby alone.
 */
export function homeJoinPlan(o: {
  linked: string | null;
  lobby: boolean;
  stored: string | null;
}): JoinStep[] {
  if (o.linked) return [{ kind: 'code', code: o.linked }];
  const stored: JoinStep[] = o.stored ? [{ kind: 'code', code: o.stored }] : [];
  return o.lobby ? [...stored, { kind: 'lobby' }] : stored;
}

export interface JoinPlanDeps {
  joinLobby(): Promise<string | null>;
  joinCode(code: string): Promise<string | null>;
  /** The caller is still mounted. */
  live(): boolean;
}

/**
 * Runs the plan until a join works. `tried` is false when there was nothing to try (no lobby,
 * no stored code): that is done, not failed. A join that throws counts as failed.
 */
export async function runJoinPlan(
  steps: readonly JoinStep[],
  d: JoinPlanDeps,
): Promise<{ tried: boolean; roomId: string | null; via: JoinStep['kind'] | null }> {
  let tried = false;
  for (const step of steps) {
    if (!d.live()) break;
    tried = true;
    let id: string | null = null;
    try {
      id = step.kind === 'lobby' ? await d.joinLobby() : await d.joinCode(step.code);
    } catch {
      id = null;
    }
    if (id !== null) return { tried, roomId: id, via: step.kind };
  }
  return { tried, roomId: null, via: null };
}

/** What home shows: the lobby, a private room, or the code entry (today's no-room home). */
export type HomeMode = 'lobby' | 'room' | 'code';

export function homeMode(o: {
  room: { lobby?: boolean | undefined } | null;
  /** No room yet, the lobby join is in flight. */
  lobbyJoining: boolean;
  /** "Private room" was tapped: the code entry and "New room" show over the lobby. */
  showPrivate: boolean;
}): HomeMode {
  if (o.room && !o.room.lobby) return 'room';
  const inLobby = o.room?.lobby === true || (o.room === null && o.lobbyJoining);
  return inLobby && !o.showPrivate ? 'lobby' : 'code';
}

/**
 * The people a lobby phone can challenge: online and not me, in the server's order (a re-sort
 * would make rows jump on every presence frame). The lobby holds everyone who opened the app
 * today; only the ones here now are worth a row.
 */
export const lobbyMembers = (members: readonly RoomMember[], meId: string | null): RoomMember[] =>
  members.filter((m) => m.online && m.user.user_id !== meId);
