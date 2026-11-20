// Beat 5 on the phone: the loser's "I appeal!" (tap + Face ID through the shared device policy),
// APPEALED -> the appeal screen with the votes streaming in (appeal.vote) and the panel's result
// (appeal.result / BetSnapshot.appeal), and the payout by the panel's final outcome.
import { hashJcs } from '@youre-on/shared/jcs';
import { renderSignCard } from '@youre-on/shared/sign-card';
import { describe, expect, it } from 'vitest';

import {
  applyBetEvent,
  finalOutcome,
  fromSnapshot,
  isAppealed,
  type BetModel,
} from '../../bets/store';
import { appealSeats, appealVerdict, myResult } from '../../bets/view';
import { appeal } from '../actions';
import { appReducer, initialApp, routeForBet, type AppState } from '../machine';
import {
  appealResult,
  appealVote,
  BET,
  DEVICE_A,
  envelope,
  ev,
  ME_B,
  ruling,
  snapshot,
  stateEv,
} from './fixtures';

const DEADLINE = 1_795_000_100;
const signedIn = (): AppState =>
  appReducer(initialApp, { type: 'signed_in', me: ME_B, deviceId: DEVICE_A });
const fold = (m: BetModel, ...events: ReturnType<typeof ev>[]) => events.reduce(applyBetEvent, m);

/** B's phone at RULED: A_WINS, so B is the loser (and the appellant). */
function ruledForB(): BetModel {
  let m = fromSnapshot(
    snapshot({
      state: 'JUDGING',
      my_party: 'B',
      envelope: envelope(),
      last_seq: 10,
      deadlines: {
        accept_deadline: null,
        resolve_deadline: null,
        appeal_deadline: DEADLINE,
        appeal_resolve_deadline: null,
      },
    }),
  );
  const r = ruling('A_WINS');
  m = fold(
    m,
    ev('ruling.issued', { ruling: r, ruling_hash: hashJcs(r) }, 11),
    stateEv('RULED', 12),
  );
  return m;
}

const signed = {
  signature: new Uint8Array(64),
  signatureBase58: '5'.repeat(88),
  publicKey: 'x',
  method: 'faceid_hold' as const,
  authorizedAt: '2026-11-21T18:08:03.000Z',
  authSucceededAtMs: 1000,
  messageSha256: 'ab'.repeat(32),
  prompts: 1 as const,
  policy: {
    ok: true as const,
    kind: 'appeal' as never,
    party: 'B' as const,
    bet_id: BET,
    terms_hash: envelope().terms_hash,
    message_sha256: 'ab'.repeat(32),
  },
};

describe('appeal routing', () => {
  it('RULED -> ruling; APPEALED -> appeal (votes stream); the result stays up until Continue -> payout', () => {
    const app = signedIn();
    let m = ruledForB();
    expect(routeForBet(app, m)).toBe('ruling');
    m = fold(m, stateEv('APPEALED', 13));
    expect(routeForBet(app, m)).toBe('appeal');
    expect(isAppealed(m)).toBe(false);
    m = fold(
      m,
      ev('appeal.vote', { vote: appealVote(2, 'B_WINS') }, 14),
      ev('appeal.vote', { vote: appealVote(0, 'B_WINS') }, 15),
    );
    expect(m.appealVotes.map((v) => v.seat)).toEqual([0, 2]);
    expect(isAppealed(m)).toBe(true);
    const result = appealResult(['B_WINS', 'A_WINS', 'B_WINS']);
    m = fold(
      m,
      ev('appeal.vote', { vote: appealVote(1, 'A_WINS') }, 16),
      ev('appeal.result', { result, ruling_hash: hashJcs(result) }, 17),
    );
    expect(m.appealResult).toMatchObject({ final_outcome: 'B_WINS', flipped: true });
    expect(finalOutcome(m)).toBe('B_WINS'); // the panel's, not the ruling's A_WINS
    expect(myResult(finalOutcome(m)!, 'B')).toBe('won');
    // resolve_appeal goes out, then lands: still the appeal screen until this phone continues
    m = fold(m, stateEv('APPEAL_RESOLVED', 18));
    expect(routeForBet(app, m)).toBe('appeal');
    m = fold(m, stateEv('PAID', 19));
    expect(routeForBet(app, m)).toBe('appeal');
    const acked = appReducer(app, { type: 'appeal_ack', bet_id: BET });
    expect(appReducer(acked, { type: 'appeal_ack', bet_id: BET })).toBe(acked); // idempotent
    expect(routeForBet(acked, m)).toBe('payout');
  });

  it('an upheld VOID goes back to the ruling screen after Continue; a bet never appealed is unchanged', () => {
    const app = signedIn();
    let m = fold(ruledForB(), stateEv('APPEALED', 13));
    const result = appealResult(['ABSTAIN', 'ABSTAIN', 'ABSTAIN']);
    m = fold(m, ev('appeal.result', { result, ruling_hash: hashJcs(result) }, 14));
    expect(m.appealVotes).toHaveLength(3);
    expect(m.appealResult).toMatchObject({ decided_by: 'upheld_no_majority', flipped: false });
    m = fold(m, stateEv('VOIDED', 15));
    expect(routeForBet(app, m)).toBe('appeal');
    expect(routeForBet(appReducer(app, { type: 'appeal_ack', bet_id: BET }), m)).toBe('ruling');
    // no appeal: VOIDED -> ruling, PAID -> payout, as before Beat 5
    expect(routeForBet(app, fold(ruledForB(), stateEv('VOIDED', 13)))).toBe('ruling');
    expect(routeForBet(app, fold(ruledForB(), stateEv('PAID', 13)))).toBe('payout');
  });

  it('a cold start / resync takes the result from BetSnapshot.appeal', () => {
    const result = appealResult(['B_WINS', 'B_WINS', 'A_WINS']);
    const m = fromSnapshot(snapshot({ state: 'APPEAL_RESOLVED', my_party: 'B', appeal: result }));
    expect(m.appealResult).toEqual(result);
    expect(m.appealVotes).toHaveLength(3);
    expect(routeForBet(signedIn(), m)).toBe('appeal');
    // a later snapshot without it keeps what the phone already folded
    expect(fromSnapshot(snapshot({ state: 'PAID', appeal: null }), m).appealResult).toEqual(result);
  });

  it('the seats: voting until a vote lands, then upholds / overturns / abstains the appealed outcome', () => {
    expect(appealSeats([], 'A_WINS')).toEqual([
      { name: 'Claude', vote: 'voting', reason: null },
      { name: 'GPT', vote: 'voting', reason: null },
      { name: 'Google', vote: 'voting', reason: null },
    ]);
    const seats = appealSeats(
      [appealVote(0, 'A_WINS'), appealVote(1, 'B_WINS'), appealVote(2, 'ABSTAIN')],
      'A_WINS',
    );
    expect(seats.map((s) => s.vote)).toEqual(['upholds', 'overturns', 'abstains']);
    expect(seats[0]!.reason).toMatch(/frame 6/);
    expect(seats[2]!.reason).toBeNull(); // a failed seat has no reason
    expect(appealVerdict(null)).toBeNull();
    expect(appealVerdict(appealResult(['B_WINS', 'B_WINS', 'ABSTAIN']))).toBe('flipped');
    expect(appealVerdict(appealResult(['A_WINS', 'B_WINS', 'ABSTAIN']))).toBe('stands');
  });
});

describe('"I appeal!" (appeal action)', () => {
  const pushedFor = (party: 'A' | 'B') => ({ kind: 'appeal', for_parties: [party] }) as never;

  it("signs on the 'appeal' screen with the phone's own card and the verified ruling, then posts", async () => {
    const calls: Record<string, unknown>[] = [];
    const model = { ...ruledForB(), signRequests: { concede: null, appeal: pushedFor('B') } };
    const out = await appeal(
      {
        wallet: {
          async authorizeTransaction(request, prompt) {
            calls.push({ request, prompt });
            return signed;
          },
        },
        api: {
          async getAppeal() {
            throw new Error('the pushed request is used, no GET');
          },
          async appeal(s, key) {
            calls.push({ s, key });
            return { status: 'submitted', signature: '6'.repeat(88), appeal_id: 'x' } as never;
          },
        },
      },
      model,
      'Appeal the ruling',
      'k-appeal',
    );
    expect(out).toMatchObject({ status: 'submitted' });
    const req = calls[0]!.request as Record<string, unknown>;
    expect(req.screen).toBe('appeal');
    expect(req.verifiedRulingOutcome).toBe('A_WINS');
    expect(req.verifiedRulingHash).toBe(model.ruling!.ruling_hash);
    expect(req.renderedCard).toEqual(
      renderSignCard({
        kind: 'appeal',
        terms: envelope().terms,
        terms_hash: envelope().terms_hash,
        me: 'B',
        appeal_deadline: DEADLINE,
      }),
    );
    expect(calls[1]).toMatchObject({
      key: 'k-appeal',
      s: { bet_id: BET, kind: 'appeal', party: 'B', method: 'faceid_hold' },
    });
  });

  it("GETs a request when the pushed one is the other party's; refuses without a verified ruling", async () => {
    let got = 0;
    const api = {
      async getAppeal() {
        got++;
        return { kind: 'appeal', for_parties: ['B'] } as never;
      },
      async appeal() {
        return { status: 'submitted', signature: '6'.repeat(88), appeal_id: 'x' } as never;
      },
    };
    const wallet = { authorizeTransaction: async () => signed };
    const model = { ...ruledForB(), signRequests: { concede: null, appeal: pushedFor('A') } };
    await appeal({ wallet, api }, model, 'x', 'k');
    expect(got).toBe(1);
    const forged = { ...model, ruling: { ...model.ruling!, ruling_hash: '00'.repeat(32) } };
    await expect(appeal({ wallet, api }, forged, 'x', 'k')).rejects.toMatchObject({
      code: 'NOT_READY',
    });
  });
});
