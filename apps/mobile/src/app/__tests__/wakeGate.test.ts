import { describe, expect, it } from 'vitest';

import {
  HOLD_MS,
  heldUtterance,
  homeWakeAction,
  judgeAutoStarts,
  judgeWaitsForWake,
  loopReducer,
  namedOpponent,
  wakeListening,
  type LoopEvent,
  type LoopState,
  type WakeListenInput,
} from '../wakeGate';

const base: WakeListenInput = {
  flag: true,
  signedIn: true,
  judgeCam: false,
  route: 'home',
  inRoom: true,
  judgePending: false,
  judgeBusy: false,
};

describe('wakeListening: where the phone listens for "Jarvis"', () => {
  it("Home in a room, and A's negotiate screen while the judge waits", () => {
    expect(wakeListening(base)).toBe(true);
    expect(wakeListening({ ...base, inRoom: false })).toBe(false);
    expect(wakeListening({ ...base, route: 'negotiate', judgePending: true })).toBe(true);
    expect(wakeListening({ ...base, route: 'negotiate', judgePending: false })).toBe(false);
  });

  it('never while a judge session holds (or just released) the audio session', () => {
    expect(wakeListening({ ...base, judgeBusy: true })).toBe(false);
    expect(
      wakeListening({ ...base, route: 'negotiate', judgePending: true, judgeBusy: true }),
    ).toBe(false);
  });

  it('never on other screens (a dance round, the attempt, the terms card), a judge cam, signed out or flag off', () => {
    for (const route of ['dance', 'danceWatch', 'live', 'terms', 'scan', 'incoming', 'ruling'])
      expect(wakeListening({ ...base, route, judgePending: true }), route).toBe(false);
    expect(wakeListening({ ...base, judgeCam: true })).toBe(false);
    expect(wakeListening({ ...base, signedIn: false })).toBe(false);
    expect(wakeListening({ ...base, flag: false })).toBe(false);
  });
});

describe('judgeWaitsForWake / judgeAutoStarts', () => {
  it('waits when the module is there (or still loading); the old auto-start when off or missing', () => {
    expect(judgeWaitsForWake({ flag: true, available: true, status: 'listening' })).toBe(true);
    expect(judgeWaitsForWake({ flag: true, available: false, status: 'off' })).toBe(true);
    expect(judgeWaitsForWake({ flag: true, available: true, status: 'denied' })).toBe(true);
    expect(judgeWaitsForWake({ flag: true, available: true, status: 'error' })).toBe(true);
    expect(judgeWaitsForWake({ flag: true, available: false, status: 'unavailable' })).toBe(false);
    expect(judgeWaitsForWake({ flag: false, available: true, status: 'listening' })).toBe(false);
  });

  it('without a wake gate the judge starts at once, as before', () => {
    expect(judgeAutoStarts({ waits: false, state: 'DRAFTING', over: false })).toBe(true);
  });

  it('with one, only once the bet left the negotiation, and never for a bet that is over', () => {
    expect(judgeAutoStarts({ waits: true, state: 'DRAFTING', over: false })).toBe(false);
    expect(judgeAutoStarts({ waits: true, state: 'TERMS_PROPOSED', over: false })).toBe(false);
    expect(judgeAutoStarts({ waits: true, state: 'AWAITING_AUTHORIZATIONS', over: false })).toBe(
      true,
    );
    expect(judgeAutoStarts({ waits: true, state: 'LOCKED', over: false })).toBe(true);
    expect(judgeAutoStarts({ waits: true, state: 'CANCELLED', over: true })).toBe(false);
  });
});

const jake = { user_id: 'u-jake', display_name: 'Jake', online: true };
const mo = { user_id: 'u-mo', display_name: 'Mo Rahman', online: true };
const sam = { user_id: 'u-sam', display_name: 'Sam', online: false };

describe('homeWakeAction: "Jarvis, …" on Home starts a challenge', () => {
  it('the person the sentence names (online, exactly one)', () => {
    expect(namedOpponent("I bet Jake's not doing ten pushups", [jake, mo])).toBe(jake);
    expect(namedOpponent('I bet MO can flip it', [jake, mo])).toBe(mo);
    expect(namedOpponent('Jake and Mo race', [jake, mo])).toBeNull();
    expect(namedOpponent('Sam cannot', [jake, sam])).toBeNull();
    expect(namedOpponent('Jakeline cannot', [jake])).toBeNull();
    expect(
      homeWakeAction({
        text: 'bet Mo flips it',
        inRoom: true,
        canScan: true,
        opponents: [jake, mo],
      }),
    ).toEqual({ kind: 'challenge', userId: 'u-mo' });
  });

  it('else the face scan, else the one person online, else pick', () => {
    const at = (canScan: boolean, opponents = [jake, mo]) =>
      homeWakeAction({ text: 'I bet you cannot', inRoom: true, canScan, opponents });
    expect(at(true)).toEqual({ kind: 'scan' });
    expect(at(false, [jake, sam])).toEqual({ kind: 'challenge', userId: 'u-jake' });
    expect(at(false)).toEqual({ kind: 'pick' });
    expect(at(false, [])).toEqual({ kind: 'pick' });
  });

  it('nothing without a room', () => {
    expect(
      homeWakeAction({ text: 'Jake', inRoom: false, canScan: true, opponents: [jake] }),
    ).toEqual({
      kind: 'none',
    });
  });
});

describe('heldUtterance', () => {
  it('keeps the sentence for HOLD_MS', () => {
    const h = { text: 'ten pushups', atMs: 1_000 };
    expect(heldUtterance(h, 1_000)).toBe('ten pushups');
    expect(heldUtterance(h, 1_000 + HOLD_MS)).toBe('ten pushups');
    expect(heldUtterance(h, 1_001 + HOLD_MS)).toBeNull();
    expect(heldUtterance(h, 999)).toBeNull();
    expect(heldUtterance(null, 1_000)).toBeNull();
  });
});

describe('loopReducer: the rainbow loop', () => {
  const run = (events: LoopEvent[], from: LoopState = 'off') => events.reduce(loopReducer, from);

  it('listening from the wake, thinking while the judge connects, off when it talks', () => {
    expect(run([{ type: 'wake' }])).toBe('listening');
    expect(run([{ type: 'wake' }, { type: 'utterance', toJudge: true }])).toBe('thinking');
    expect(
      run([
        { type: 'wake' },
        { type: 'utterance', toJudge: true },
        { type: 'judge', phase: 'minting', speaking: false },
        { type: 'judge', phase: 'connecting', speaking: false },
        { type: 'judge', phase: 'connected', speaking: false },
      ]),
    ).toBe('thinking');
    expect(run([{ type: 'judge', phase: 'connected', speaking: true }], 'thinking')).toBe('off');
  });

  it('off on cancel, on a failed or stopped session, on Home (scan / pick next) and on reset', () => {
    expect(run([{ type: 'wake' }, { type: 'cancel' }])).toBe('off');
    expect(run([{ type: 'judge', phase: 'failed', speaking: false }], 'thinking')).toBe('off');
    expect(run([{ type: 'judge', phase: 'stopped', speaking: false }], 'thinking')).toBe('off');
    expect(run([{ type: 'wake' }, { type: 'utterance', toJudge: false }])).toBe('off');
    expect(run([{ type: 'reset' }], 'listening')).toBe('off');
  });

  it('Tap to talk thinks; judge updates and cancels do not touch a loop that is not thinking', () => {
    expect(run([{ type: 'tap' }])).toBe('thinking');
    expect(run([{ type: 'judge', phase: 'connected', speaking: true }], 'listening')).toBe(
      'listening',
    );
    expect(run([{ type: 'cancel' }], 'thinking')).toBe('thinking');
  });
});
