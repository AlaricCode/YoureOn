// The real app's route state machine (forked from PreviewApp's routes, but driven by the server).
// Local facts (signed in? which room? which bet is on screen? did this phone acknowledge the
// locked card?) live in a pure reducer; the screen for an active bet is DERIVED from the bet's
// server state (../bets/store), never set by a timer, so both phones always agree with the server.
// Pure TS: tested in node.
import type { RoomMember } from '@youre-on/shared/api';
import type { BetState } from '@youre-on/shared/bet-state';
import type { UserRef } from '@youre-on/shared/primitives';

import { isAppealed, type BetModel } from '../bets/store';
import { inDanceRound, isDanceBet, recordsDance } from './danceFlow';

export type Route =
  | 'boot'
  | 'signup'
  | 'demoClaim'
  | 'home'
  | 'profile'
  | 'scan'
  | 'faceSettings'
  | 'enroll'
  | 'history'
  | 'incoming'
  | 'negotiate'
  | 'terms'
  | 'lockEnded'
  | 'live'
  /** A Gemini bet waiting for Gemini to settle (Beat 6). */
  | 'market'
  | 'judgeCam'
  | 'ruling'
  /** Beat 5: the three-model panel voting live, then its result (SCHEMAS §7). */
  | 'appeal'
  | 'redo'
  | 'payout'
  /**
   * A Dance Off round on the phone that records it (the room's judge cam, else A's phone):
   * framing, count-in, the 15 s dance with live scoring, the upload, then waiting for the ruling.
   */
  | 'dance'
  /** A Dance Off round on the other phone: "Dance off live", then the score. */
  | 'danceWatch';

export interface RoomInfo {
  room_id: string;
  code: string;
  name: string;
}

export interface AppState {
  auth: 'booting' | 'signedOut' | 'signedIn';
  me: UserRef | null;
  deviceId: string | null;
  /**
   * A screen opened over home: profile, demo claim, the face scan (Beat 1), face settings,
   * face enrollment (offered right after signup, or from face settings), or bet history.
   */
  overlay: Overlay;
  room: RoomInfo | null;
  members: readonly RoomMember[];
  activeBetId: string | null;
  /** The locked card was acknowledged ("Continue", or its short auto-advance). */
  lockAcked: readonly string[];
  /** The appeal result was acknowledged ("Continue"): the bet moves on to its payout screen. */
  appealAcked: readonly string[];
  /** This device records attempts (devices.role = 'judge_cam'). */
  judgeCam: boolean;
  /** The server is unreachable / the socket is down. */
  offline: boolean;
}

export type Overlay =
  'none' | 'profile' | 'history' | 'demoClaim' | 'scan' | 'faceSettings' | 'enroll';

export type AppEvent =
  | { type: 'booted'; me: UserRef | null; deviceId: string | null }
  | { type: 'signed_in'; me: UserRef; deviceId: string }
  | { type: 'signed_out' }
  | { type: 'overlay'; overlay: AppState['overlay'] }
  | { type: 'room'; room: RoomInfo | null; members?: readonly RoomMember[] }
  | { type: 'presence'; room_id: string; members: readonly RoomMember[] }
  | { type: 'bet_opened'; bet_id: string; force?: boolean }
  | { type: 'bet_dismissed' }
  | { type: 'lock_ack'; bet_id: string }
  | { type: 'appeal_ack'; bet_id: string }
  | { type: 'judge_cam'; on: boolean }
  | { type: 'offline'; offline: boolean };

export const initialApp: AppState = {
  auth: 'booting',
  me: null,
  deviceId: null,
  overlay: 'none',
  room: null,
  members: [],
  activeBetId: null,
  lockAcked: [],
  appealAcked: [],
  judgeCam: false,
  offline: false,
};

const TERMINAL: ReadonlySet<BetState> = new Set(['PAID', 'VOIDED', 'CANCELLED', 'EXPIRED']);
export const isOver = (s: BetState | null): boolean => s !== null && TERMINAL.has(s);

export function appReducer(
  s: AppState,
  e: AppEvent,
  bets?: (id: string) => BetModel | undefined,
): AppState {
  switch (e.type) {
    case 'booted':
      return e.me
        ? { ...s, auth: 'signedIn', me: e.me, deviceId: e.deviceId }
        : { ...s, auth: 'signedOut', me: null, deviceId: null };
    case 'signed_in':
      // A different user (demo claim from Profile): the old user's room, bet and lock acks
      // are not theirs; carrying them over makes the socket subscribe to subs it may not see.
      if (s.me && s.me.user_id !== e.me.user_id)
        return { ...initialApp, auth: 'signedIn', me: e.me, deviceId: e.deviceId };
      // Face enrollment offered by the signup screen survives the session landing.
      return {
        ...s,
        auth: 'signedIn',
        me: e.me,
        deviceId: e.deviceId,
        overlay: s.overlay === 'enroll' ? 'enroll' : 'none',
      };
    case 'signed_out':
      return { ...initialApp, auth: 'signedOut' };
    case 'overlay':
      return { ...s, overlay: e.overlay };
    case 'room':
      // No room, nothing to scan: the scan screen closes with it.
      return {
        ...s,
        room: e.room,
        members: e.room ? (e.members ?? []) : [],
        overlay: !e.room && s.overlay === 'scan' ? 'none' : s.overlay,
      };
    case 'presence':
      return s.room?.room_id === e.room_id ? { ...s, members: e.members } : s;
    case 'bet_opened': {
      // One bet on screen at a time: a second invite while a live bet is up waits.
      const current = s.activeBetId ? bets?.(s.activeBetId) : undefined;
      const busy =
        s.activeBetId !== null && s.activeBetId !== e.bet_id && current && !isOver(current.state);
      if (busy && !e.force) return s;
      return { ...s, activeBetId: e.bet_id, overlay: 'none' };
    }
    case 'bet_dismissed':
      return { ...s, activeBetId: null };
    case 'lock_ack':
      return s.lockAcked.includes(e.bet_id) ? s : { ...s, lockAcked: [...s.lockAcked, e.bet_id] };
    case 'appeal_ack':
      return s.appealAcked.includes(e.bet_id)
        ? s
        : { ...s, appealAcked: [...s.appealAcked, e.bet_id] };
    case 'judge_cam':
      return { ...s, judgeCam: e.on };
    case 'offline':
      return s.offline === e.offline ? s : { ...s, offline: e.offline };
  }
}

/** Which screen a bet in this state shows on this phone. */
export function routeForBet(app: AppState, b: BetModel): Route {
  const state = b.state;
  if (state === null) return b.challenger && b.my_party === 'B' ? 'incoming' : 'home';
  // Dance Off (DANCE-OFF §6.2): both players dance, one phone films for both. The ruling, GG and
  // payout below are the usual screens.
  // A judge-cam device never signs: it goes straight to the round, and (the projector, §6.3)
  // keeps the round's result and announcer line up through RULED instead of dropping to the
  // standby camera screen; once the bet settles it shows the payout like any phone.
  if (isDanceBet(b) && app.judgeCam && (inDanceRound(state) || state === 'RULED')) return 'dance';
  if (isDanceBet(b) && inDanceRound(state)) {
    if (state === 'LOCKED' && !app.lockAcked.includes(b.bet_id)) return 'terms';
    return recordsDance(app, b) ? 'dance' : 'danceWatch';
  }
  // The recording device films whatever attempt names it, whoever's phone it is.
  const recording =
    b.attempt !== null && app.deviceId !== null && b.attempt.recorder_device_id === app.deviceId;
  if (recording && (state === 'ATTEMPT' || state === 'LOCKED')) return 'judgeCam';
  // A judge-cam device (a second device of A) only ever films: it never negotiates or signs.
  if (app.judgeCam && !isOver(state)) return 'judgeCam';
  switch (state) {
    case 'DRAFTING':
    case 'TERMS_PROPOSED':
      return b.my_party === 'B' && b.inviteAnswer === null && b.challenger !== null
        ? 'incoming'
        : 'negotiate';
    case 'AWAITING_AUTHORIZATIONS':
    case 'AWAITING_LOCK':
      return 'terms';
    case 'LOCKED':
      return app.lockAcked.includes(b.bet_id) ? 'live' : 'terms';
    // A Gemini bet is locked straight into AWAITING_MARKET: the Locked card first, then the clock.
    case 'AWAITING_MARKET':
      return app.lockAcked.includes(b.bet_id) ? 'market' : 'terms';
    case 'ATTEMPT':
    case 'JUDGING':
    case 'HEARING':
      return b.ruling?.ruling.outcome === 'REDO' ? 'redo' : 'live';
    case 'RULED':
      return 'ruling';
    // The panel votes live; its result stays up (through the payout) until "Continue".
    case 'APPEALED':
      return 'appeal';
    case 'VOIDED':
      return appealOpen(app, b) ? 'appeal' : 'ruling';
    case 'APPEAL_RESOLVED':
    case 'PAID':
      return appealOpen(app, b) ? 'appeal' : 'payout';
    case 'CONCEDED':
    case 'FINALIZED':
      return 'payout';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'lockEnded';
  }
}

/** An appealed bet whose result this phone has not acknowledged yet. */
const appealOpen = (app: AppState, b: BetModel): boolean =>
  isAppealed(b) && !app.appealAcked.includes(b.bet_id);

export function selectRoute(app: AppState, bet: BetModel | null | undefined): Route {
  if (app.auth === 'booting') return 'boot';
  if (app.auth === 'signedOut') return app.overlay === 'demoClaim' ? 'demoClaim' : 'signup';
  if (app.overlay === 'profile') return 'profile';
  if (app.overlay === 'history') return 'history';
  if (app.overlay === 'demoClaim') return 'demoClaim';
  if (app.overlay === 'faceSettings') return 'faceSettings';
  if (app.overlay === 'enroll') return 'enroll';
  // The scan addresses a challenge in the current room; it needs one.
  if (app.overlay === 'scan' && app.room && !app.judgeCam) return 'scan';
  if (app.activeBetId && bet) return routeForBet(app, bet);
  if (app.judgeCam) return 'judgeCam';
  return 'home';
}

/** The attempt A's phone starts next: 1 from LOCKED, previous + 1 after a REDO (API-CONTRACT §2.9). */
export const nextAttemptNo = (b: Pick<BetModel, 'lastAttemptNo'>): number =>
  (b.lastAttemptNo ?? 0) + 1;
