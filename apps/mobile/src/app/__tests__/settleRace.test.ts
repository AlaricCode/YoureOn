// A refunded bet never reads as a loss, and a finished bet never moves back (prod bet 07c2b5a9…,
// a call-off VOID: both phones showed the loser's payout, "GG -$1.00", while it settled).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppealResult } from '@youre-on/shared/appeal';
import { hashJcs } from '@youre-on/shared/jcs';
import { Ruling } from '@youre-on/shared/ruling';

import {
  applyBetEvent,
  finalOutcome,
  fromSnapshot,
  movesFinishedBetBack,
  type BetModel,
} from '../../bets/store';
import { screenResult } from '../../bets/view';
import { appReducer, initialApp, routeForBet, type AppState } from '../machine';
import { appealResult, BET, DEVICE_A, ev, ME_A, ruling, snapshot, stateEv } from './fixtures';

const A: AppState = appReducer(initialApp, { type: 'signed_in', me: ME_A, deviceId: DEVICE_A });
const fold = (m: BetModel, ...events: ReturnType<typeof ev>[]) => events.reduce(applyBetEvent, m);
const voidRuling = () =>
  Ruling.parse({
    ...ruling('A_WINS'),
    outcome: 'VOID',
    claim_result: 'UNCLEAR',
    void_reason: 'max_redos',
  });
const ruled = (outcome: 'VOID' | 'A_WINS', seq = 21) =>
  fold(
    fromSnapshot(snapshot({ state: 'JUDGING', last_seq: seq - 1 })),
    ev(
      'ruling.issued',
      { ruling: outcome === 'VOID' ? voidRuling() : ruling(outcome), ruling_hash: 'ef'.repeat(32) },
      seq,
    ),
    stateEv('RULED', seq + 1),
  );
const processed = (state: string, seq: number) =>
  ev(
    'bet.state',
    {
      state,
      prev: state,
      onchain_status: 'Resolved',
      chain_ack: 'rpc',
      pending_tx: {
        kind: 'finalize',
        signature: '5'.repeat(88),
        submitted_at: '2026-11-21T18:09:00.000Z',
        rpc_processed_at: '2026-11-21T18:09:01.000Z',
        rpc_confirmed_at: null,
      },
      reason: 'processed',
    },
    seq,
  );

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('a VOID outcome is a refund on every screen', () => {
  it('the prod sequence (RULED, FINALIZED, FINALIZED processed, VOIDED) never routes to the payout', () => {
    let m = ruled('VOID', 31);
    const routes = [routeForBet(A, m)];
    for (const e of [stateEv('FINALIZED', 33), processed('FINALIZED', 35), stateEv('VOIDED', 36)]) {
      m = applyBetEvent(m, e);
      routes.push(routeForBet(A, m));
      expect(screenResult(finalOutcome(m), m.state, 'A')).toBe('void');
      expect(screenResult(finalOutcome(m), m.state, 'B')).toBe('void');
    }
    expect(routes).toEqual(['ruling', 'ruling', 'ruling', 'ruling']);
    expect(m.state).toBe('VOIDED');
  });

  it('CONCEDED / FINALIZED with a VOID outcome stay on the ruling', () => {
    for (const s of ['CONCEDED', 'FINALIZED'] as const)
      expect(routeForBet(A, fold(ruled('VOID'), stateEv(s, 40)))).toBe('ruling');
  });

  it('an appealed VOID the panel upholds (APPEAL_RESOLVED, then VOIDED) never routes to the payout', () => {
    const upheld = appealResult(['ABSTAIN', 'ABSTAIN', 'ABSTAIN']);
    const result = AppealResult.parse({
      ...upheld,
      appellant: 'A',
      original_outcome: 'VOID',
      final_outcome: 'VOID',
      decided_by: 'upheld_no_majority',
      flipped: false,
    });
    let m = fold(
      ruled('VOID'),
      stateEv('APPEALED', 30),
      ev('appeal.result', { result, ruling_hash: hashJcs(result) }, 31),
      stateEv('APPEAL_RESOLVED', 32),
    );
    expect(finalOutcome(m)).toBe('VOID');
    expect(routeForBet(A, m)).toBe('appeal'); // the panel's result, until Continue
    const acked = appReducer(A, { type: 'appeal_ack', bet_id: BET });
    expect(routeForBet(acked, m)).toBe('ruling');
    expect(screenResult(finalOutcome(m), m.state, 'A')).toBe('void');
    m = fold(m, stateEv('VOIDED', 33));
    expect(routeForBet(acked, m)).toBe('ruling');
  });

  it('a decisive outcome still goes to the payout (won / lost)', () => {
    const m = fold(ruled('A_WINS'), stateEv('FINALIZED', 40));
    expect(routeForBet(A, m)).toBe('payout');
    expect(screenResult(finalOutcome(m), m.state, 'A')).toBe('won');
    expect(screenResult(finalOutcome(m), m.state, 'B')).toBe('lost');
    expect(routeForBet(A, fold(m, stateEv('PAID', 41)))).toBe('payout');
  });

  it('screenResult: VOID in any state, a VOIDED bet, or no outcome is a refund', () => {
    for (const s of ['RULED', 'FINALIZED', 'CONCEDED', 'PAID', 'VOIDED', null])
      expect(screenResult('VOID', s, 'B')).toBe('void');
    expect(screenResult('A_WINS', 'VOIDED', 'B')).toBe('void');
    expect(screenResult(null, 'FINALIZED', 'B')).toBe('void');
    expect(screenResult('A_WINS', 'FINALIZED', null)).toBe('void');
    expect(screenResult('B_WINS', 'PAID', 'B')).toBe('won');
  });
});

describe('a finished bet never moves back on the phone', () => {
  it('a FINALIZED frame after VOIDED (or PAID) is ignored, with a warning', () => {
    for (const end of ['VOIDED', 'PAID'] as const) {
      const done = fold(ruled('VOID'), stateEv('FINALIZED', 33), stateEv(end, 36));
      const late = applyBetEvent(done, processed('FINALIZED', 37));
      expect(late.state).toBe(end);
      expect(late.pending_tx).toBe(done.pending_tx);
      expect(late.lastSeq).toBe(37); // the seq is consumed, the state is not
      expect(routeForBet(A, late)).toBe(routeForBet(A, done));
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a stale snapshot (FINALIZED) after the VOIDED frame is ignored; a PAID winner is not put back on "Paying"', () => {
    const voided = fold(ruled('VOID'), stateEv('FINALIZED', 33), stateEv('VOIDED', 36));
    const kept = fromSnapshot(snapshot({ state: 'FINALIZED', last_seq: 35 }), voided);
    expect(kept.state).toBe('VOIDED');
    expect(kept.lastSeq).toBe(36);
    const paid = fold(ruled('A_WINS'), stateEv('FINALIZED', 33), stateEv('PAID', 36));
    const stale = fromSnapshot(
      snapshot({ state: 'FINALIZED', onchain_status: 'Resolved', last_seq: 35 }),
      paid,
    );
    expect(stale.state).toBe('PAID');
    expect(routeForBet(A, stale)).toBe('payout');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('every non-terminal state is refused after each terminal one; the same state is fine', () => {
    for (const from of ['PAID', 'VOIDED', 'CANCELLED', 'EXPIRED'] as const) {
      for (const to of ['RULED', 'CONCEDED', 'FINALIZED', 'APPEALED', 'LOCKED'] as const)
        expect(movesFinishedBetBack(from, to, null)).toBe(true);
      expect(movesFinishedBetBack(from, from, null)).toBe(false);
    }
    expect(movesFinishedBetBack('PAID', 'VOIDED', 'Settled')).toBe(true);
    expect(movesFinishedBetBack('VOIDED', 'FINALIZED', 'Settled')).toBe(true);
    // Not finished yet: anything goes (the server orders those).
    expect(movesFinishedBetBack('FINALIZED', 'RULED', 'Resolved')).toBe(false);
    expect(movesFinishedBetBack(null, 'PAID', null)).toBe(false);
  });

  it('the one revive the server allows still applies: EXPIRED -> LOCKED when the lock landed', () => {
    const expired = fold(fromSnapshot(snapshot({ state: 'AWAITING_LOCK' })), stateEv('EXPIRED', 5));
    const revived = applyBetEvent(
      expired,
      ev(
        'bet.state',
        {
          state: 'LOCKED',
          prev: 'EXPIRED',
          onchain_status: 'Locked',
          chain_ack: 'stream',
          pending_tx: null,
          reason: null,
        },
        6,
      ),
    );
    expect(revived.state).toBe('LOCKED');
    // ...but not from a frame without the chain behind it.
    expect(applyBetEvent(expired, stateEv('LOCKED', 6)).state).toBe('EXPIRED');
  });
});
