import { MeBetItem } from '@youre-on/shared/api';
import type { OddsOffer } from '@youre-on/shared/odds';
import { describe, expect, it } from 'vitest';

import { applyBetEvent, emptyBet, fromSnapshot } from '../../bets/store';
import { betView } from '../../bets/view';
import { ApiClientError } from '../../net/signedFetch';
import { bottleFlip, JUDGE_ODDS, ODDS_STAKES, previewOdds } from '../../preview/data';
import { COPY, fill, t } from '../../screens/copy';
import { checkCopy } from '../../ui/copyRule';
import { historyItemOf } from '../history';
import {
  acceptOdds,
  canAccept,
  canCounter,
  canWithdraw,
  controlOf,
  controlStakes,
  emptyOdds,
  evenControl,
  offerCardView,
  oddsAgreedShown,
  oddsErrorNote,
  oddsSettled,
  offerOdds,
  pickBase,
  pickDir,
  pickPreset,
  readout,
  stakesLine,
  suggestOdds,
  typedSuggestBody,
  withdrawOdds,
  type OddsControl,
} from '../odds';
import { BET, ME_B, ev, snapshot } from './fixtures';

const flip = bottleFlip('Logan', 'Jake');
const atOdds = bottleFlip('Logan', 'Jake', ODDS_STAKES); // Logan $15 vs Jake $5
const HASH = flip.termsHash;

const O1 = '0dd50000-0000-4000-8000-0000000000a1';
const O2 = '0dd50000-0000-4000-8000-0000000000a2';
const offer = (o: Partial<OddsOffer> & Pick<OddsOffer, 'from' | 'stakes'>): OddsOffer => ({
  offer_id: O1,
  n: 1,
  parent_id: null,
  ratio_label: '3 to 1',
  favored: BigInt(o.stakes.a) > BigInt(o.stakes.b) ? 'A' : 'B',
  terms_hash: HASH,
  suggestion: null,
  created_at: '2026-11-21T18:06:00.000Z',
  ...o,
});
const offered = (o: OddsOffer) => ev('odds.offered', { offer: o });
const answered = (
  offer_id: string,
  party: 'A' | 'B',
  answer: 'accepted' | 'countered' | 'withdrawn' | 'superseded',
  by: string | null = null,
) => ev('odds.answered', { offer_id, party, answer, by_offer_id: by });

const proposed = (bet = flip) =>
  fromSnapshot(
    snapshot({
      state: 'TERMS_PROPOSED',
      envelope: {
        terms: bet.terms,
        terms_hash: bet.termsHash,
        presentation: {
          title: 'Bottle flip',
          readback: 'One flip.',
          stakes_display: '$15 vs $5',
          odds_display: '3 to 1',
          party_a_avatar_url: null,
          party_b_avatar_url: null,
        },
      },
    }),
  );

describe('the odds fold on BetModel (bets/store)', () => {
  it('starts empty; odds.* events fold into m.odds; a replay is a no-op', () => {
    expect(emptyBet(BET).odds.open).toBeNull();
    const e = offered(offer({ from: 'A', stakes: ODDS_STAKES }));
    const m = applyBetEvent(proposed(), e);
    expect(m.odds.open?.offer_id).toBe(O1);
    expect(m.odds.accepted_by).toEqual(['A']);
    expect(applyBetEvent(m, e).odds).toEqual(m.odds);
    // A resync keeps what the log already brought.
    expect(fromSnapshot(snapshot({ state: 'TERMS_PROPOSED' }), m).odds).toBe(m.odds);
  });

  it('offer -> counter -> accept: agreed by stakes, the open offer closes', () => {
    let m = proposed(atOdds);
    m = applyBetEvent(m, offered(offer({ from: 'A', stakes: { a: '10000000', b: '5000000' } })));
    // B counters 3 to 1 (Logan's $15 against Jake's $5).
    m = applyBetEvent(
      m,
      offered(offer({ offer_id: O2, n: 2, parent_id: O1, from: 'B', stakes: ODDS_STAKES })),
    );
    m = applyBetEvent(m, answered(O1, 'B', 'countered', O2));
    expect(m.odds.open?.offer_id).toBe(O2);
    expect(oddsSettled(m.odds, atOdds.terms)).toBe(false);
    m = applyBetEvent(m, answered(O2, 'A', 'accepted'));
    expect(m.odds.open).toBeNull();
    expect(oddsSettled(m.odds, atOdds.terms)).toBe(true);
    expect(oddsAgreedShown({ odds: m.odds, me: 'A', state: m.state, terms: atOdds.terms })).toBe(
      true,
    );
  });

  it('a judge offer needs both taps', () => {
    let m = applyBetEvent(proposed(), offered(JUDGE_ODDS));
    expect(m.odds.accepted_by).toEqual([]);
    m = applyBetEvent(m, answered(JUDGE_ODDS.offer_id, 'A', 'accepted'));
    expect(m.odds.open).not.toBeNull();
    expect(canAccept(m.odds, 'A', 'TERMS_PROPOSED')).toBe(false);
    expect(canAccept(m.odds, 'B', 'TERMS_PROPOSED')).toBe(true);
    m = applyBetEvent(m, answered(JUDGE_ODDS.offer_id, 'B', 'accepted'));
    expect(m.odds.open).toBeNull();
  });
});

describe('gates', () => {
  const s = previewOdds('party'); // Jake (B) offers 3 to 1
  it('the other party accepts or counters; the author withdraws', () => {
    expect(canAccept(s, 'A', 'TERMS_PROPOSED')).toBe(true);
    expect(canCounter(s, 'A', 'TERMS_PROPOSED')).toBe(true);
    expect(canWithdraw(s, 'A', 'TERMS_PROPOSED')).toBe(false);
    expect(canAccept(s, 'B', 'TERMS_PROPOSED')).toBe(false);
    expect(canCounter(s, 'B', 'TERMS_PROPOSED')).toBe(false);
    expect(canWithdraw(s, 'B', 'TERMS_PROPOSED')).toBe(true);
  });
  it('only while the card is on the table (not DRAFTING, not after the freeze)', () => {
    for (const st of ['DRAFTING', 'AWAITING_AUTHORIZATIONS', 'LOCKED'] as const) {
      expect(canAccept(s, 'A', st)).toBe(false);
      expect(canCounter(s, 'A', st)).toBe(false);
      expect(canWithdraw(s, 'B', st)).toBe(false);
    }
    expect(canAccept(emptyOdds, 'A', 'TERMS_PROPOSED')).toBe(false);
  });
  it('oddsSettled: even stakes need nothing; odds need an agreement and nothing open', () => {
    expect(oddsSettled(emptyOdds, flip.terms)).toBe(true);
    expect(oddsSettled(emptyOdds, atOdds.terms)).toBe(false);
    // Anything open blocks, even on an even card.
    expect(oddsSettled(s, flip.terms)).toBe(false);
    // A market card never waits on odds.
    const market = { ...atOdds.terms, type: 'real_world' as const };
    expect(oddsSettled(s, market)).toBe(true);
  });
});

describe('the odds picker', () => {
  const ok = (c: OddsControl, me: 'A' | 'B' = 'A') => {
    const r = controlStakes(c, me);
    if (!r.ok) throw new Error(r.note);
    return r.stakes;
  };
  it('presets x direction x base -> stakes, from either side', () => {
    expect(ok(evenControl(5))).toEqual({ a: '5000000', b: '5000000' });
    const c = pickPreset(evenControl(5), '3:1');
    expect(ok(c)).toEqual({ a: '15000000', b: '5000000' }); // A gives 3 to 1
    expect(ok(pickDir(c, 'get'))).toEqual({ a: '5000000', b: '15000000' });
    expect(ok(c, 'B')).toEqual({ a: '5000000', b: '15000000' }); // B gives
    expect(ok(pickPreset(evenControl(1), '5:1'))).toEqual({ a: '5000000', b: '1000000' });
    expect(ok(pickPreset(evenControl(5), '2:1'))).toEqual({ a: '10000000', b: '5000000' });
    // The favourite is capped at $20: the underdog comes down instead.
    expect(ok(pickBase(pickPreset(evenControl(5), '5:1'), 20))).toEqual({
      a: '20000000',
      b: '4000000',
    });
  });
  it('direction means nothing at Even; Even resets custom', () => {
    expect(pickDir(evenControl(5), 'get')).toEqual(evenControl(5));
    const custom = controlOf({ a: '7500000', b: '5000000' }, 'A');
    expect(custom.preset).toBe('custom');
    expect(pickDir(custom, 'get').custom).toEqual({ mine: '5000000', theirs: '7500000' });
    expect(pickPreset(custom, 'Even')).toEqual(evenControl(5));
    expect(pickBase(custom, 10)).toEqual(evenControl(10));
  });
  it('controlOf round-trips presets from either side', () => {
    for (const me of ['A', 'B'] as const)
      for (const preset of ['Even', '2:1', '3:1', '5:1'] as const)
        for (const dir of ['give', 'get'] as const)
          for (const baseUsd of [1, 5, 10]) {
            const c =
              preset === 'Even' ? evenControl(baseUsd) : { preset, dir, baseUsd, custom: null };
            const st = ok(c, me);
            const back = controlOf(st, me);
            expect(ok(back, me)).toEqual(st);
            // Clamped at the $20 cap (3 to 1 over $10: $20 vs $6.66) it is custom stakes.
            const capped = BigInt(st.a) === 20_000_000n || BigInt(st.b) === 20_000_000n;
            if (!capped || preset === 'Even') expect(back.preset).toBe(preset);
          }
  });
  it('readout and the draft line', () => {
    expect(readout({ a: '15000000', b: '5000000' }, 'A', 'Jake Lee')).toBe('You $15 · Jake $5');
    expect(readout({ a: '15000000', b: '5000000' }, 'B', 'Logan')).toBe('You $5 · Logan $15');
    expect(stakesLine('15000000', '5000000')).toBe('$15 vs $5 · 3 to 1');
    expect(stakesLine('5000000', '5000000')).toBe('$5 vs $5');
  });
});

describe('the offer card', () => {
  it("a party's offer reads from my side: Accept / Counter for me, Withdraw for them", () => {
    const odds = previewOdds('party');
    const a = offerCardView({ odds, me: 'A', state: 'TERMS_PROPOSED', terms: flip.terms })!;
    expect(a.title).toBe('Jake offers 3 to 1: your $5 to win $20');
    expect(a.toWin).toBe('You put in $5 to win $20');
    expect(a).toMatchObject({ canAccept: true, canCounter: true, canWithdraw: false });
    expect(a.waitingOn).toBeNull();
    expect(a.counterFrom).toMatchObject({ preset: '3:1', dir: 'get', baseUsd: 5 });
    const b = offerCardView({ odds, me: 'B', state: 'TERMS_PROPOSED', terms: flip.terms })!;
    expect(b.title).toBe('You offer 3 to 1: your $15 to win $20');
    expect(b).toMatchObject({ canAccept: false, canWithdraw: true, waitingOn: 'Logan' });
  });

  it("the judge's offer shows the record, the reason, the chance and Demo history", () => {
    const c = offerCardView({
      odds: previewOdds('judge'),
      me: 'A',
      state: 'TERMS_PROPOSED',
      terms: flip.terms,
    })!;
    expect(c.fromJudge).toBe(true);
    expect(c.header).toBe('Judge suggests 2:1');
    expect(c.judge).toEqual({
      stats: 'Bottle flips 10–2 · vs Logan 12–4',
      reason: 'Jake has landed 10 of his last 12 bottle flips, so he gives 2 to 1.',
      chance: '69% for Jake',
      demo: true,
      byDefault: false,
    });
    expect(c.toWin).toBe('You put in $5 to win $15');
    expect(c.canAccept).toBe(true);
  });

  it('every line passes the copy rule', () => {
    const lines = [
      offerCardView({
        odds: previewOdds('party'),
        me: 'A',
        state: 'TERMS_PROPOSED',
        terms: flip.terms,
      })!,
      offerCardView({
        odds: previewOdds('judge'),
        me: 'B',
        state: 'TERMS_PROPOSED',
        terms: flip.terms,
      })!,
    ];
    for (const c of lines) {
      for (const body of [c.title, c.toWin, c.judge?.reason ?? 'x'])
        expect(checkCopy(body, 'body')).toEqual([]);
      if (c.header) expect(checkCopy(c.header, 'label')).toEqual([]);
      if (c.judge) {
        expect(checkCopy(c.judge.chance, 'label')).toEqual([]);
        expect(checkCopy(c.judge.stats, 'data')).toEqual([]);
      }
    }
    for (const l of [
      fill.waitingOn('Eva Santos'),
      fill.judgeSuggests('10:1'),
      fill.chanceFor(9, 'Eva Santos'),
    ])
      expect(checkCopy(l, 'label')).toEqual([]);
  });
});

describe('displays of unequal stakes', () => {
  it('terms card: odds row, "You put in $5 to win $20", and nothing new for even stakes', () => {
    const a = betView(atOdds.terms, atOdds.termsHash, 'A');
    const b = betView(atOdds.terms, atOdds.termsHash, 'B');
    expect(a).toMatchObject({ odds: '3 to 1', ratio: '3 to 1', myStakeUsd: '$15', potUsd: '$20' });
    expect(a.toWin).toBe('You put in $15 to win $20');
    expect(b.toWin).toBe('You put in $5 to win $20');
    const even = betView(flip.terms, flip.termsHash, 'A');
    expect(even).toMatchObject({ odds: null, ratio: null, toWin: null });
  });

  it('history: "$5 vs $15" when the stakes differ', () => {
    const row = (o: Partial<MeBetItem>) =>
      historyItemOf(
        MeBetItem.parse({
          ...snapshot({ state: 'PAID' }),
          title: 'Bottle flip',
          opponent: ME_B,
          my_stake: '5000000',
          my_payout: '20000000',
          outcome: 'PartyA',
          settled_at: '2026-11-18T05:00:00.000Z',
          is_seed: false,
          ...o,
        }),
      );
    expect(row({ their_stake: '15000000' })).toMatchObject({
      net: '15000000',
      stakes: '$5 vs $15',
    });
    expect(row({ their_stake: '5000000', my_payout: '10000000' })).not.toHaveProperty('stakes');
    expect(row({})).not.toHaveProperty('stakes');
  });
});

describe('calls', () => {
  const fail = (code: string, status: number, details?: Record<string, unknown>, msg = 'x') => {
    throw new ApiClientError(code, status, msg, false, details);
  };
  it('offer sends dollar strings; accept sends n; withdraw', async () => {
    const seen: unknown[] = [];
    const api = {
      offerOdds: async (id: string, body: unknown) => {
        seen.push({ id, body });
        return { offer: JUDGE_ODDS, agreed: false, terms_hash: null };
      },
      acceptOdds: async (id: string, offerId: string, n: number) => {
        seen.push({ id, offerId, n });
        return { offer: JUDGE_ODDS, agreed: true, terms_hash: HASH };
      },
      withdrawOdds: async (id: string, offerId: string) => {
        seen.push({ id, offerId });
      },
    };
    expect(
      await offerOdds({ api }, { betId: BET, stakes: { a: '7500000', b: '5000000' } }),
    ).toEqual({ ok: true, agreed: false });
    expect(await acceptOdds({ api }, { betId: BET, offerId: O1, n: 3 })).toEqual({
      ok: true,
      agreed: true,
    });
    expect(await withdrawOdds({ api }, { betId: BET, offerId: O1 })).toEqual({
      ok: true,
      agreed: false,
    });
    expect(seen).toEqual([
      { id: BET, body: { stakes_usd: { a: '7.50', b: '5' } } },
      { id: BET, offerId: O1, n: 3 },
      { id: BET, offerId: O1 },
    ]);
  });

  it('suggest: the typed form sends the claim as it stands; errors become short notes', async () => {
    const bodies: unknown[] = [];
    const api = {
      suggestOdds: async (_id: string, body: unknown) => {
        bodies.push(body);
        return { offer: JUDGE_ODDS, say: 'Jake is 10 for 12. I would make it 2 to 1.' };
      },
    };
    const r = await suggestOdds(
      { api },
      { betId: BET, body: typedSuggestBody(' Jake  flips. ', 5) },
    );
    expect(r).toMatchObject({ ok: true, offer: { offer_id: JUDGE_ODDS.offer_id } });
    expect(bodies[0]).toEqual({
      base_usd: '5',
      claim: 'Jake flips.',
      performer: 'B',
      attempts: { count: 1, rule: 'single' },
    });
    const down = await suggestOdds(
      { api: { suggestOdds: async () => fail('INTERNAL', 500) } },
      { betId: BET, body: {} },
    );
    expect(down).toEqual({ ok: false, note: t(COPY.app.failed) });
  });

  it('error notes', () => {
    const note = (
      code: string,
      status: number,
      details?: Record<string, unknown>,
      msg?: string,
    ) => {
      try {
        fail(code, status, details, msg);
      } catch (e) {
        return oddsErrorNote(e);
      }
      return '';
    };
    expect(note('INSUFFICIENT_FUNDS', 409, { party: 'B' }, "Jake can't cover $15.")).toBe(
      "Jake can't cover $15.",
    );
    expect(note('VALIDATION_FAILED', 422, { issue: { code: 'ODDS_TOO_LONG' } })).toBe(
      t(COPY.odds.tooLong),
    );
    expect(note('INVALID_STATE', 409, { reason: 'stale' })).toBe(t(COPY.odds.changed));
    expect(note('INVALID_STATE', 409, { reason: 'odds_pending' })).toBe(t(COPY.odds.pending));
    expect(note('INVALID_STATE', 409, { reason: 'x' }, 'Terms are locked in.')).toBe(
      'Terms are locked in.',
    );
    expect(note('RATE_LIMITED', 429)).toBe(t(COPY.home.slowDown));
    // A server line that breaks the copy rule never reaches the screen.
    expect(note('INSUFFICIENT_FUNDS', 409, {}, 'Top up your wallet')).toBe(t(COPY.app.failed));
    expect(oddsErrorNote(new Error('boom'))).toBe(t(COPY.app.failed));
  });
});
