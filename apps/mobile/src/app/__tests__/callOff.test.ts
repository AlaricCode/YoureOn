import { describe, expect, it } from 'vitest';

import { CALL_OFF_TTL_MS, CALLED_OFF_REASON } from '@youre-on/shared/call-off';
import { CALLED_OFF_MODEL, Ruling } from '@youre-on/shared/ruling';

import { applyBetEvent, emptyBet, type BetModel } from '../../bets/store';
import { COPY, fill, t } from '../../screens/copy';
import { checkCopy } from '../../ui/copyRule';
import {
  CALL_OFF_ROUTES,
  callOffAllowed,
  callOffName,
  callOffOnRoute,
  callOffView,
} from '../callOff';
import { appReducer, initialApp, routeForBet, type Route } from '../machine';
import { BET, DEVICE_A, envelope, ev, flip, ME_A, ruling, stateEv } from './fixtures';

const NOW = Date.parse('2026-11-21T18:07:00.000Z');
const later = (ms: number) => new Date(NOW + ms).toISOString();

const calledOff = () =>
  Ruling.parse({
    ...ruling('A_WINS'),
    outcome: 'VOID',
    claim_result: 'UNCLEAR',
    confidence: 1,
    void_reason: 'safety_stop',
    reason: CALLED_OFF_REASON,
    cited_frames: [],
    frame_hashes: [],
    model: CALLED_OFF_MODEL,
  });

const fold = (m: BetModel, ...events: ReturnType<typeof ev>[]) => events.reduce(applyBetEvent, m);
const locked = (me: 'A' | 'B' = 'A'): BetModel =>
  fold(emptyBet(BET, me), ev('terms.proposed', { envelope: envelope() }), stateEv('LOCKED'));
const asked = (by: 'A' | 'B', expiresInMs = CALL_OFF_TTL_MS) =>
  ev('bet.call_off', { status: 'requested', by, expires_at: later(expiresInMs) });
const view = (b: BetModel, o: { nowMs?: number; judgeCam?: boolean } = {}) =>
  callOffView(b, { nowMs: o.nowMs ?? NOW, judgeCam: o.judgeCam ?? false });

describe('callOffAllowed (the server rule)', () => {
  it('LOCKED, ATTEMPT, and JUDGING right after a REDO only', () => {
    const b = locked();
    expect(callOffAllowed(b)).toBe(true);
    expect(callOffAllowed({ ...b, state: 'ATTEMPT' })).toBe(true);
    expect(callOffAllowed({ ...b, state: 'JUDGING', ruling: null })).toBe(false); // in flight
    const redo = { ruling: ruling('REDO'), ruling_hash: 'ab'.repeat(32) };
    expect(callOffAllowed({ ...b, state: 'JUDGING', ruling: redo })).toBe(true);
    const won = { ruling: ruling('A_WINS'), ruling_hash: 'ab'.repeat(32) };
    expect(callOffAllowed({ ...b, state: 'JUDGING', ruling: won })).toBe(false);
    const off = { ruling: calledOff(), ruling_hash: 'ab'.repeat(32) };
    expect(callOffAllowed({ ...b, state: 'JUDGING', ruling: off })).toBe(false);
    for (const s of ['RULED', 'VOIDED', 'PAID', 'TERMS_PROPOSED', 'AWAITING_LOCK'] as const)
      expect(callOffAllowed({ ...b, state: s })).toBe(false);
  });
});

describe('callOffView', () => {
  it('the button by default; nothing on the judge-cam device or a non-party', () => {
    expect(view(locked())).toEqual({ kind: 'ask' });
    expect(view(locked(), { judgeCam: true })).toEqual({ kind: 'none' });
    expect(view({ ...locked(), my_party: null })).toEqual({ kind: 'none' });
  });

  it('my request: waiting; theirs: the prompt naming who asked', () => {
    const mine = fold(locked('A'), asked('A'));
    expect(view(mine)).toEqual({ kind: 'waiting', expiresAtMs: NOW + CALL_OFF_TTL_MS });
    const theirs = fold(locked('B'), asked('A'));
    expect(view(theirs)).toEqual({ kind: 'prompt', by: 'A', expiresAtMs: NOW + CALL_OFF_TTL_MS });
  });

  it('a lapsed or cleared request is gone: the button again', () => {
    const b = fold(locked('B'), asked('A'));
    expect(view(b, { nowMs: NOW + CALL_OFF_TTL_MS })).toEqual({ kind: 'ask' });
    const cleared = fold(b, ev('bet.call_off', { status: 'cleared', by: 'B', expires_at: null }));
    expect(view(cleared)).toEqual({ kind: 'ask' });
  });

  it('once both agreed (VOID ruling, JUDGING) nothing shows, and the VOIDED path follows', () => {
    let b = fold(locked('B'), asked('A'), stateEv('JUDGING'));
    // the uploaded round in flight: no button, no prompt (the server would refuse)
    expect(view(b)).toEqual({ kind: 'none' });
    b = fold(
      locked('B'),
      asked('A'),
      stateEv('JUDGING'),
      ev('bet.call_off', { status: 'agreed', by: 'B', expires_at: null }),
      ev('ruling.issued', { ruling: calledOff(), ruling_hash: 'ab'.repeat(32) }),
    );
    expect(b.callOff).toEqual({ status: 'agreed', by: 'B', expires_at: null });
    expect(view(b)).toEqual({ kind: 'none' });
    const app = appReducer(
      appReducer(initialApp, { type: 'signed_in', me: ME_A, deviceId: DEVICE_A }),
      { type: 'bet_opened', bet_id: BET },
    );
    const acked = appReducer(app, { type: 'lock_ack', bet_id: BET });
    expect(routeForBet(acked, b)).toBe('live');
    expect(routeForBet(acked, fold(b, stateEv('RULED')))).toBe('ruling');
    const voided = fold(b, stateEv('RULED'), stateEv('VOIDED'));
    expect(routeForBet(acked, voided)).toBe('ruling');
    // over: the next invite opens (B is no longer pinned to this bet)
    const next = appReducer(acked, { type: 'bet_opened', bet_id: 'other-bet' }, (id) =>
      id === BET ? voided : undefined,
    );
    expect(next.activeBetId).toBe('other-bet');
    const stuck = appReducer(acked, { type: 'bet_opened', bet_id: 'other-bet' }, (id) =>
      id === BET ? fold(locked('B'), asked('A')) : undefined,
    );
    expect(stuck.activeBetId).toBe(BET);
  });

  it('the asking name comes from the parties, else the terms', () => {
    const b = locked('B');
    expect(callOffName(b, 'A')).toBe(flip.terms.party_a.display_name);
    expect(callOffName({ ...emptyBet(BET), envelope: null }, 'B')).toBe('They');
  });
});

describe('the screens it shows on', () => {
  it('every post-lock, pre-ruling route, and none of the others', () => {
    const on: Route[] = ['live', 'judgeCam', 'redo', 'dance', 'danceDisplay', 'danceWatch'];
    for (const r of on) expect(callOffOnRoute(r)).toBe(true);
    const off: Route[] = ['home', 'terms', 'negotiate', 'ruling', 'payout', 'appeal', 'market'];
    for (const r of off) expect(callOffOnRoute(r)).toBe(false);
    expect(CALL_OFF_ROUTES.size).toBe(on.length);
  });
});

describe('call-off copy passes the copy rule', () => {
  it.each(Object.entries(COPY.callOff))('%s', (_k, line) => {
    expect(checkCopy(line[0], line[1])).toEqual([]);
  });
  it('the prompt is contract copy, the confirm body is body copy (first names)', () => {
    for (const n of ['Jake', 'Eva Santos', 'Zoë-Anne'])
      expect(checkCopy(fill.callOffAsk(n), 'contract')).toEqual([]);
    expect(fill.callOffAsk('Eva Santos')).toBe('Eva wants to call it off. Refund both?');
    expect(fill.callOffBody('Eva Santos')).toBe(
      'Both of you get your money back. Eva has to agree.',
    );
    expect(checkCopy(fill.callOffBody('Jake'), 'body')).toEqual([]);
    expect(t(COPY.callOff.button)).toBe('Call it off');
    expect(checkCopy(fill.waitingFor('Jake'), 'label')).toEqual([]);
  });
});
