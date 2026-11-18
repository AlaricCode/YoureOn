import { describe, expect, it } from 'vitest';

import { initialLock, lockReducer, type LockState } from '../../bets/lock';
import {
  applyBetEvent,
  emptyBet,
  endReasonOf,
  fromSnapshot,
  lockSignals,
  type BetModel,
} from '../../bets/store';
import {
  appReducer,
  initialApp,
  nextAttemptNo,
  routeForBet,
  selectRoute,
  type AppEvent,
  type AppState,
} from '../machine';
import {
  authorizeRequest,
  BET,
  DEVICE_A,
  DEVICE_CAM,
  envelope,
  ev,
  ME_A,
  ME_B,
  ROOM,
  ruling,
  snapshot,
  stateEv,
} from './fixtures';

const signedIn = (me = ME_A, deviceId = DEVICE_A): AppState =>
  appReducer(initialApp, { type: 'signed_in', me, deviceId });

const fold = (m: BetModel, ...events: ReturnType<typeof ev>[]) => events.reduce(applyBetEvent, m);

describe('app reducer', () => {
  it('boot -> signup when no session, -> home when restored', () => {
    expect(selectRoute(initialApp, null)).toBe('boot');
    const out = appReducer(initialApp, { type: 'booted', me: null, deviceId: null });
    expect(selectRoute(out, null)).toBe('signup');
    expect(selectRoute(appReducer(out, { type: 'overlay', overlay: 'demoClaim' }), null)).toBe(
      'demoClaim',
    );
    const inn = appReducer(initialApp, { type: 'booted', me: ME_A, deviceId: DEVICE_A });
    expect(selectRoute(inn, null)).toBe('home');
  });

  it('a different user signing in (demo claim from Profile) drops the old room and bet', () => {
    let s = signedIn(ME_A);
    s = appReducer(s, { type: 'room', room: { room_id: ROOM, code: 'UBC26X', name: 'UBC' } });
    s = appReducer(s, { type: 'bet_opened', bet_id: BET });
    s = appReducer(s, { type: 'lock_ack', bet_id: BET });
    // the same user again (a silent re-login) keeps everything
    const same = appReducer(s, { type: 'signed_in', me: ME_A, deviceId: DEVICE_A });
    expect(same.room?.room_id).toBe(ROOM);
    expect(same.activeBetId).toBe(BET);
    const other = appReducer(s, { type: 'signed_in', me: ME_B, deviceId: DEVICE_A });
    expect(other.me).toEqual(ME_B);
    expect(other.auth).toBe('signedIn');
    expect(other.room).toBeNull();
    expect(other.activeBetId).toBeNull();
    expect(other.lockAcked).toEqual([]);
  });

  it('demo claim -> signed in -> home; profile overlay; sign out resets', () => {
    let s = appReducer(initialApp, { type: 'booted', me: null, deviceId: null });
    s = appReducer(s, { type: 'overlay', overlay: 'demoClaim' });
    s = appReducer(s, { type: 'signed_in', me: ME_A, deviceId: DEVICE_A });
    expect(selectRoute(s, null)).toBe('home');
    s = appReducer(s, { type: 'overlay', overlay: 'profile' });
    expect(selectRoute(s, null)).toBe('profile');
    s = appReducer(s, { type: 'signed_out' });
    expect(s.auth).toBe('signedOut');
    expect(s.room).toBeNull();
  });

  it('room join, presence only for the current room, leave clears members', () => {
    const m = [
      { user: ME_B, face_enrolled: false, online: true, last_seen_at: '2026-11-21T18:00:00.000Z' },
    ];
    let s = appReducer(signedIn(), {
      type: 'room',
      room: { room_id: ROOM, code: 'UBC26X', name: 'Demo room' },
      members: m,
    });
    expect(s.members).toHaveLength(1);
    s = appReducer(s, { type: 'presence', room_id: 'other', members: [] });
    expect(s.members).toHaveLength(1);
    s = appReducer(s, { type: 'presence', room_id: ROOM, members: [] });
    expect(s.members).toHaveLength(0);
    s = appReducer(s, { type: 'room', room: null });
    expect(s.room).toBeNull();
  });

  it('keeps one bet on screen: a second invite waits until the first is over', () => {
    const live = fromSnapshot(snapshot({ state: 'LOCKED' }));
    const bets = (id: string) => (id === BET ? live : undefined);
    let s = appReducer(signedIn(), { type: 'bet_opened', bet_id: BET }, bets);
    s = appReducer(s, { type: 'bet_opened', bet_id: 'other' }, bets);
    expect(s.activeBetId).toBe(BET);
    const over = fromSnapshot(snapshot({ state: 'PAID' }));
    s = appReducer(s, { type: 'bet_opened', bet_id: 'other' }, () => over);
    expect(s.activeBetId).toBe('other');
    s = appReducer(s, { type: 'bet_dismissed' });
    expect(selectRoute(s, null)).toBe('home');
  });
});

describe('route for a bet (server state drives the screen)', () => {
  const A = signedIn();
  const B = signedIn(ME_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddd0b');

  it('A: DRAFTING -> negotiate -> terms -> locked card until ack -> live', () => {
    let m = fromSnapshot(snapshot());
    expect(routeForBet(A, m)).toBe('negotiate');
    m = fold(m, ev('terms.proposed', { envelope: envelope() }, 3), stateEv('TERMS_PROPOSED', 4));
    expect(routeForBet(A, m)).toBe('negotiate');
    m = fold(
      m,
      stateEv('AWAITING_AUTHORIZATIONS', 5),
      ev('terms.authorize_request', authorizeRequest(), 6),
    );
    expect(routeForBet(A, m)).toBe('terms');
    m = fold(m, stateEv('AWAITING_LOCK', 7));
    expect(routeForBet(A, m)).toBe('terms');
    m = fold(m, stateEv('LOCKED', 8));
    expect(routeForBet(A, m)).toBe('terms');
    const acked = appReducer(A, { type: 'lock_ack', bet_id: BET });
    expect(routeForBet(acked, m)).toBe('live');
  });

  it('B: bet.invited -> incoming (until answered) -> negotiate', () => {
    let m = emptyBet(BET);
    m = fold(m, ev('bet.invited', { challenger: ME_A, room_id: ROOM }, 1));
    expect(m.my_party).toBe('B');
    expect(routeForBet(B, m)).toBe('incoming');
    m = fold(m, stateEv('DRAFTING', 2));
    expect(routeForBet(B, m)).toBe('incoming');
    m = fold(m, ev('bet.invite_answered', { party: 'B', answer: 'accepted' }, 3));
    expect(routeForBet(B, m)).toBe('negotiate');
  });

  it('the recorder device films; the parties watch; REDO -> redo -> next attempt -> live', () => {
    const cam = signedIn(ME_A, DEVICE_CAM);
    let m = fromSnapshot(snapshot({ state: 'LOCKED', last_seq: 8 }));
    m = fold(
      m,
      stateEv('ATTEMPT', 9),
      ev(
        'attempt.started',
        {
          attempt_no: 1,
          performer: 'B',
          max_ms: 6000,
          recorder_device_id: DEVICE_CAM,
          go_at: '2026-11-21T18:07:00.000Z',
        },
        10,
      ),
    );
    expect(routeForBet(cam, m)).toBe('judgeCam');
    expect(routeForBet(A, m)).toBe('live');
    m = fold(
      m,
      stateEv('JUDGING', 11),
      ev('ruling.issued', { ruling: ruling('REDO'), ruling_hash: 'ef'.repeat(32) }, 12),
    );
    expect(routeForBet(A, m)).toBe('redo');
    expect(nextAttemptNo(m)).toBe(2);
    m = fold(
      m,
      stateEv('ATTEMPT', 13),
      ev(
        'attempt.started',
        {
          attempt_no: 2,
          performer: 'B',
          max_ms: 6000,
          recorder_device_id: DEVICE_CAM,
          go_at: '2026-11-21T18:08:00.000Z',
        },
        14,
      ),
    );
    expect(m.ruling).toBeNull();
    expect(routeForBet(A, m)).toBe('live');
    expect(routeForBet(cam, m)).toBe('judgeCam');
  });

  it('ruling -> payout; cancelled/expired -> lockEnded', () => {
    let m = fromSnapshot(snapshot({ state: 'JUDGING', last_seq: 11 }));
    m = fold(
      m,
      ev('ruling.issued', { ruling: ruling('A_WINS'), ruling_hash: 'ef'.repeat(32) }, 12),
      stateEv('RULED', 13),
    );
    expect(routeForBet(A, m)).toBe('ruling');
    m = fold(m, stateEv('CONCEDED', 14));
    expect(routeForBet(A, m)).toBe('payout');
    m = fold(m, stateEv('PAID', 15));
    expect(routeForBet(A, m)).toBe('payout');
    expect(
      routeForBet(A, fold(fromSnapshot(snapshot()), stateEv('CANCELLED', 3, 'declined'))),
    ).toBe('lockEnded');
    expect(routeForBet(A, fold(fromSnapshot(snapshot()), stateEv('EXPIRED', 3)))).toBe('lockEnded');
  });
});

describe('bet store', () => {
  it('a lock request whose terms differ from the proposed terms sets termsMismatch', () => {
    const other = envelope();
    let m = fromSnapshot(snapshot());
    m = fold(m, ev('terms.proposed', { envelope: other }, 3));
    const req = authorizeRequest();
    m = fold(m, ev('terms.authorize_request', req, 4));
    expect(m.termsMismatch).toBe(false);
    // A forged envelope (hash != terms) never parses at all.
    expect(() =>
      ev('terms.proposed', { envelope: { ...other, terms_hash: '00'.repeat(32) } }, 5),
    ).toThrow();
  });

  it('records authorizations, sign requests and the appeal deadline', () => {
    let m = fromSnapshot(snapshot({ state: 'AWAITING_AUTHORIZATIONS' }));
    m = fold(m, ev('terms.authorize_request', authorizeRequest(), 3));
    m = fold(
      m,
      ev(
        'terms.authorized',
        { party: 'B', method: 'faceid_hold', authorized_at: '2026-11-21T18:06:40.000Z', count: 1 },
        4,
      ),
    );
    expect(m.authorized).toEqual({ A: false, B: true });
    expect(
      fromSnapshot(
        snapshot({
          deadlines: {
            accept_deadline: null,
            resolve_deadline: null,
            appeal_deadline: 1_795_000_100,
            appeal_resolve_deadline: null,
          },
        }),
      ).appeal_deadline,
    ).toBe(1_795_000_100);
  });

  it('end reasons', () => {
    expect(endReasonOf({ state: 'CANCELLED', end_reason: 'declined', lockFailed: false })).toBe(
      'declined',
    );
    expect(endReasonOf({ state: 'EXPIRED', end_reason: 'accept_timeout', lockFailed: false })).toBe(
      'expired',
    );
    expect(endReasonOf({ state: 'CANCELLED', end_reason: null, lockFailed: true })).toBe(
      'lock_failed',
    );
    expect(
      endReasonOf({ state: 'CANCELLED', end_reason: 'terms_superseded', lockFailed: false }),
    ).toBe('terms_changed');
  });
});

describe('lock card signals (store -> lockReducer)', () => {
  const run = (
    me: 'A' | 'B',
    events: ReturnType<typeof ev>[],
    extra: Parameters<typeof lockReducer>[1][] = [],
  ): LockState => {
    let m = fromSnapshot(snapshot({ state: 'AWAITING_AUTHORIZATIONS', my_party: me }));
    let lock = initialLock;
    for (const e of events) {
      const next = applyBetEvent(m, e);
      for (const s of lockSignals(m, next, e, me)) lock = lockReducer(lock, s);
      m = next;
      if (e.type === 'terms.authorize_request')
        lock = lockReducer(lock, { type: 'policy', ok: true });
    }
    for (const x of extra) lock = lockReducer(lock, x);
    return lock;
  };

  it('phone-signed path: their signature, mine, AWAITING_AUTHORIZATIONS -> AWAITING_LOCK -> LOCKED', () => {
    const lock = run(
      'A',
      [
        ev('terms.authorize_request', authorizeRequest(), 3),
        ev(
          'terms.authorized',
          {
            party: 'B',
            method: 'faceid_hold',
            authorized_at: '2026-11-21T18:06:40.000Z',
            count: 1,
          },
          4,
        ),
      ],
      [{ type: 'hold_complete' }, { type: 'auth_result', ok: true }],
    );
    expect(lock.theirsIn).toBe(true);
    expect(lock.phase).toBe('signed');
    let l2 = lockReducer(lock, { type: 'submitted' });
    l2 = lockReducer(l2, { type: 'confirmed' });
    expect(l2.phase).toBe('locked');
  });

  it('custodial path: the server just pushes LOCKED', () => {
    const lock = run('B', [
      ev('terms.authorize_request', authorizeRequest(), 3),
      stateEv('LOCKED', 4),
    ]);
    expect(lock.phase).toBe('locked');
  });

  it('decline, lock failure and expiry end the card', () => {
    expect(
      run('A', [
        ev('terms.authorize_request', authorizeRequest(), 3),
        ev('terms.declined', { party: 'B' }, 4),
      ]).endReason,
    ).toBe('declined');
    expect(
      run('A', [
        ev('terms.authorize_request', authorizeRequest(), 3),
        ev('tx.failed', { kind: 'atomic_lock', signature: null, error: 'x' }, 4),
      ]).endReason,
    ).toBe('lock_failed');
    expect(
      run('A', [ev('terms.authorize_request', authorizeRequest(), 3), stateEv('EXPIRED', 4)])
        .endReason,
    ).toBe('expired');
  });

  it('a new terms.proposed after the lock request ends the card: terms changed', () => {
    const changed = { ...envelope() };
    // Same hash -> no change.
    expect(
      run('A', [
        ev('terms.authorize_request', authorizeRequest(), 3),
        ev('terms.proposed', { envelope: changed }, 4),
      ]).phase,
    ).toBe('ready');
  });
});

describe('app event exhaustiveness', () => {
  it('every event type is handled', () => {
    const events: AppEvent[] = [
      { type: 'booted', me: ME_A, deviceId: DEVICE_A },
      { type: 'signed_in', me: ME_A, deviceId: DEVICE_A },
      { type: 'overlay', overlay: 'profile' },
      { type: 'room', room: null },
      { type: 'presence', room_id: ROOM, members: [] },
      { type: 'bet_opened', bet_id: BET },
      { type: 'lock_ack', bet_id: BET },
      { type: 'judge_cam', on: true },
      { type: 'offline', offline: true },
      { type: 'bet_dismissed' },
      { type: 'signed_out' },
    ];
    let s = initialApp;
    for (const e of events) s = appReducer(s, e);
    expect(s.auth).toBe('signedOut');
  });

  it('a judge-cam device with no bet stands by', () => {
    const s = appReducer(signedIn(ME_A, DEVICE_CAM), { type: 'judge_cam', on: true });
    expect(selectRoute(s, null)).toBe('judgeCam');
  });

  it("a judge-cam device of A never shows A's negotiate / terms screens", () => {
    let s = appReducer(signedIn(ME_A, DEVICE_CAM), { type: 'judge_cam', on: true });
    s = appReducer(s, { type: 'bet_opened', bet_id: BET });
    const m = fromSnapshot(snapshot({ state: 'AWAITING_AUTHORIZATIONS' }));
    expect(m.my_party).toBe('A');
    expect(selectRoute(s, m)).toBe('judgeCam');
    expect(selectRoute(s, fromSnapshot(snapshot({ state: 'PAID' })))).toBe('payout');
  });
});
