// Odds on the projector: the ticker folds odds.* with the shared reducer (same state as the
// phones and the server gate), the judge's odds card shows the performer's record it is grounded
// in (with the Demo history badge), the offer / counter strip, the terms card's odds chip, the
// odds cue lines the stage says, and the ?preview=odds sample at each step.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hashJcs } from '@youre-on/shared/jcs';
import { foldOdds } from '@youre-on/shared/odds';
import { eventLabel } from '../src/format';
import { JudgeOddsCard, OddsChip, OddsStrip, showsOdds } from '../src/odds';
import {
  judgeOdds,
  oddsChip,
  oddsCueLine,
  oddsSteps,
  oddsOnTable,
  stepText,
  type OddsView,
} from '../src/odds-state';
import {
  isOddsPreview,
  ODDS_LOOP_MS,
  ODDS_STEPS,
  previewOddsAt,
  type OddsStep,
} from '../src/preview-odds';
import { phaseOf } from '../src/phase';
import { applyFrame, initialTicker, type BetView, type TickerState } from '../src/ticker';
import { StageView, TermsCard } from '../src/view';
import { freshVoiceLines } from '../src/voice';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const at = (step: OddsStep) => previewOddsAt(START, START, `odds-${step}`);
const focus = (s: TickerState): BetView => s.bets[s.focusBetId!]!;
const render = (step: OddsStep) => {
  const f = at(step);
  return text(renderToString(<StageView state={f.state} now={f.now} preview={`odds-${step}`} />));
};

const BET = '9d0dd5e2-7a41-4c1e-9b2f-3c4d5e6f7a8b';
const O1 = '00000000-0000-4000-8000-000000000101';
const O2 = '00000000-0000-4000-8000-000000000102';
const O3 = '00000000-0000-4000-8000-000000000103';
const HASH = 'ab'.repeat(32);
let seq = 0;
const ev = (type: string, payload: unknown) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: ++seq,
  ts: new Date(START + seq * 1000).toISOString(),
  source: 'server',
  payload,
});
const offer = (
  id: string,
  n: number,
  from: 'A' | 'B' | 'judge',
  a: string,
  b: string,
  parent: string | null,
  suggestion: unknown = null,
) => ({
  offer: {
    offer_id: id,
    n,
    parent_id: parent,
    from,
    stakes: { a, b },
    ratio_label: 'x',
    favored: a === b ? null : BigInt(a) > BigInt(b) ? 'A' : 'B',
    terms_hash: HASH,
    suggestion,
    created_at: new Date(START).toISOString(),
  },
});
const stats = (over: Record<string, unknown> = {}) => ({
  performer: { party: 'B', display_name: 'Jake' },
  category: 'bottle_flip',
  category_label: 'Bottle flip',
  overall: { wins: 14, losses: 6, pushes: 0 },
  in_category: { made: 10, tries: 12 },
  as_performer: { made: 12, tries: 15 },
  recent: ['W', 'W', 'L', 'W', 'W'],
  streak: { kind: 'W', n: 2 },
  h2h: {
    wins: 7,
    losses: 4,
    pushes: 0,
    net: '15000000',
    net_display: '+$15',
    last_settled_at: null,
    includes_seed: true,
  },
  includes_seed: true,
  ...over,
});
const sugg = (over: Record<string, unknown> = {}) => ({
  ratio: '2:1',
  favored: 'B',
  stakes: { a: '5000000', b: '10000000' },
  chance_pct: 69,
  fair_ratio: 2.2,
  allowed: ['2:1', '3:1'],
  base_rate_pct: 25,
  sample_meaningful: true,
  stats: stats(),
  reason: 'Jake has landed 10 of his last 12 bottle flips.',
  source: 'model',
  model: 'claude-opus-5-5',
  cache_key: 'cd'.repeat(32),
  ...over,
});

function fold(raws: unknown[]): TickerState {
  let s = initialTicker;
  for (const raw of raws) s = applyFrame(s, { kind: 'frame', raw, receivedAt: START });
  return s;
}

describe('ticker fold of odds.*', () => {
  it('equals the shared foldOdds of the same events (offer, judge counter, two accepts)', () => {
    seq = 0;
    const raws = [
      ev('odds.offered', offer(O1, 1, 'A', '5000000', '15000000', null)),
      ev('odds.offered', offer(O2, 2, 'judge', '5000000', '10000000', O1, sugg())),
      ev('odds.answered', { offer_id: O1, party: 'A', answer: 'countered', by_offer_id: O2 }),
      ev('odds.answered', { offer_id: O2, party: 'A', answer: 'accepted', by_offer_id: null }),
    ];
    const s = fold(raws);
    expect(s.dropped).toBe(0);
    const v = s.bets[BET]!.odds!;
    expect(v.state).toEqual(foldOdds(raws as Array<{ type: string; payload: unknown }>));
    expect(v.state.open?.offer_id).toBe(O2);
    expect(v.state.accepted_by).toEqual(['A']);
    // the judge needs both taps
    const j = judgeOdds(v)!;
    expect(j.waiting).toEqual(['B']);
    const done = fold([
      ...raws,
      ev('odds.answered', { offer_id: O2, party: 'B', answer: 'accepted', by_offer_id: null }),
    ]).bets[BET]!.odds!;
    expect(done.state.open).toBeNull();
    expect(done.state.agreed.map((x) => [x.a, x.b])).toEqual([['5000000', '10000000']]);
    expect(judgeOdds(done)!.status).toBe('agreed');
  });

  it('a rebuild (out-of-order event) folds odds the same as in order', () => {
    seq = 0;
    const raws = [
      ev('odds.offered', offer(O1, 1, 'A', '5000000', '15000000', null)),
      ev('odds.offered', offer(O2, 2, 'B', '7500000', '5000000', O1)),
    ];
    const inOrder = fold(raws).bets[BET]!.odds!.state;
    const reversed = fold([raws[1], raws[0]]).bets[BET]!.odds!.state;
    expect(reversed).toEqual(inOrder);
  });
});

describe('the offer / counter strip', () => {
  const names = { A: 'Logan', B: 'Jake' };
  it('words offers neutrally: asks / offers / counters / judge suggests', () => {
    const o = (from: 'A' | 'B' | 'judge', a: string, b: string, parent: string | null) =>
      offer(O1, 1, from, a, b, parent).offer as Parameters<typeof stepText>[0];
    expect(stepText(o('A', '5000000', '15000000', null), names)).toBe('Logan asks 3 to 1');
    expect(stepText(o('A', '15000000', '5000000', null), names)).toBe('Logan offers 3 to 1');
    expect(stepText(o('B', '5000000', '7500000', O2), names)).toBe('Jake counters 3 to 2');
    expect(stepText(o('judge', '5000000', '10000000', O1), names)).toBe('Judge suggests 2 to 1');
    expect(stepText(o('A', '5000000', '5000000', null), names)).toBe('Logan offers even money');
  });

  it("hides an offer its own author replaced, keeps a counter's parent", () => {
    seq = 0;
    const s = fold([
      ev('odds.offered', offer(O1, 1, 'A', '5000000', '15000000', null)),
      // Logan re-offers (supersedes his own): the first one leaves the strip
      ev('odds.offered', offer(O2, 2, 'A', '5000000', '10000000', null)),
      ev('odds.answered', { offer_id: O1, party: 'A', answer: 'superseded', by_offer_id: O2 }),
      // Jake counters
      ev('odds.offered', offer(O3, 3, 'B', '5000000', '7500000', O2)),
    ]);
    const steps = oddsSteps(s.bets[BET]!.odds, names);
    expect(steps.map((x) => x.text)).toEqual(['Logan asks 2 to 1', 'Jake counters 3 to 2']);
    expect(steps.map((x) => x.status)).toEqual(['superseded', 'open']);
    const html = text(
      renderToString(<OddsStrip bet={{ ...s.bets[BET]!, names: names as BetView['names'] }} />),
    );
    expect(html).toContain('Logan asks 2 to 1');
    expect(html).toContain('Jake counters 3 to 2');
    expect(html).toContain('Logan $5 · Jake $7.50');
  });
});

describe("the judge's odds card", () => {
  const betWith = (suggestion: unknown): BetView => {
    seq = 0;
    const s = fold([
      ev('odds.offered', offer(O2, 1, 'judge', '5000000', '10000000', null, suggestion)),
    ]);
    return { ...s.bets[BET]!, names: { A: 'Logan', B: 'Jake' } };
  };

  it("shows the ratio, the performer's chance and record, the reason, and Demo history", () => {
    const html = text(renderToString(<JudgeOddsCard bet={betWith(sugg())} />));
    expect(html).toContain("Judge's odds");
    expect(html).toContain('Demo history');
    expect(html).toContain('2 to 1');
    expect(html).toContain('Jake 69%');
    expect(html).toContain('Logan $5 · Jake $10');
    expect(html).toContain('Bottle flips 10–2');
    expect(html).toContain('83%');
    expect(html).toContain('vs Logan 7–4');
    expect(html).toContain('Overall 14–6');
    expect(html).toContain('2 straight');
    expect(html).toContain('Jake has landed 10 of his last 12 bottle flips.');
    expect(html).toContain('reason worded by claude-opus-5-5');
    expect(html).toContain('Waiting on both');
  });

  it('real history: no Demo history badge; no record: the default footnote', () => {
    const real = sugg({ stats: stats({ includes_seed: false }) });
    expect(text(renderToString(<JudgeOddsCard bet={betWith(real)} />))).not.toContain(
      'Demo history',
    );
    const none = sugg({
      ratio: '3:1',
      favored: 'A',
      stakes: { a: '15000000', b: '5000000' },
      chance_pct: 25,
      fair_ratio: 3,
      allowed: ['3:1'],
      sample_meaningful: false,
      source: 'default',
      model: null,
      reason: "Bottle flips land about a quarter of the time. That's my default.",
      stats: stats({
        includes_seed: false,
        in_category: { made: 0, tries: 0 },
        recent: [],
        streak: null,
      }),
    });
    const html = text(renderToString(<JudgeOddsCard bet={betWith(none)} />));
    expect(html).toContain('3 to 1');
    expect(html).toContain('no record yet');
    expect(html).toContain('Default odds for this kind of bet');
    expect(html).toContain('small sample');
  });

  it('nothing without a judge suggestion', () => {
    seq = 0;
    const s = fold([ev('odds.offered', offer(O1, 1, 'A', '5000000', '15000000', null))]);
    expect(judgeOdds(s.bets[BET]!.odds)).toBeNull();
    expect(renderToString(<JudgeOddsCard bet={s.bets[BET]!} />)).toBe('');
  });
});

describe('terms card odds chip', () => {
  it('unequal skill stakes: both stakes, who gives what odds, the pot', () => {
    const f = at('agreed');
    const html = text(renderToString(<TermsCard bet={focus(f.state)} />));
    expect(html).toContain('Logan $5');
    expect(html).toContain('Jake $10');
    expect(html).toContain('Jake gives 2 to 1');
    expect(html).toContain('pot $15');
    expect(renderToString(<OddsChip bet={focus(f.state)} />)).toContain('odds-chip');
  });

  it('even stakes and Gemini bets get no chip', () => {
    const names = { A: 'Logan', B: 'Jake' };
    expect(
      oddsChip({ type: 'skill', market: null, stakes: { a: '5000000', b: '5000000' } }, names),
    ).toBeNull();
    expect(
      oddsChip(
        { type: 'real_world', market: { venue: 'gemini' }, stakes: { a: '6100000', b: '3900000' } },
        names,
      ),
    ).toBeNull();
    expect(
      oddsChip({ type: 'skill', market: null, stakes: { a: '15000000', b: '5000000' } }, names),
    ).toBe('Logan gives 3 to 1');
  });
});

describe('odds cue lines (the stage voice when no phone judge hosts)', () => {
  it('says a speak:true judge suggestion and the agreement; ignores speak:false', () => {
    seq = 0;
    const offered = ev('odds.offered', offer(O2, 1, 'judge', '5000000', '10000000', null, sugg()));
    const s = fold([offered]);
    const names = { A: 'Logan', B: 'Jake' };
    const cue = (speak: boolean, name = 'ODDS_OFFERED') => ({
      type: 'judge.cue',
      payload: { cue: name, text: `[EVENT] ${name} name=Judge :: Say it.`, speak },
    });
    expect(oddsCueLine(cue(true), s.bets[BET]!.odds, names)).toBe(
      "Jake has landed 10 of his last 12 bottle flips. I'd make it 2 to 1: Logan puts in $5, Jake puts in $10. Both agree?",
    );
    expect(oddsCueLine(cue(false), s.bets[BET]!.odds, names)).toBeNull();
    const agreed = fold([
      offered,
      ev('odds.agreed', {
        offer_id: O2,
        stakes: { a: '5000000', b: '10000000' },
        ratio_label: '2 to 1',
        terms_hash: HASH,
      }),
    ]);
    expect(oddsCueLine(cue(true, 'ODDS_AGREED'), agreed.bets[BET]!.odds, names)).toBe(
      'Odds agreed: Logan $5, Jake $10; winner takes $15.',
    );
  });

  it('freshVoiceLines voices a fresh speak:true odds cue, and leaves it to a phone judge', () => {
    seq = 0;
    const raws = [
      ev('odds.offered', offer(O2, 1, 'judge', '5000000', '10000000', null, sugg())),
      ev('judge.cue', {
        cue: 'ODDS_OFFERED',
        text: '[EVENT] ODDS_OFFERED name=Judge :: Say it.',
        speak: true,
      }),
    ];
    const s = fold(raws);
    const now = Date.parse(raws[1]!.ts);
    const lines = freshVoiceLines(s, BET, new Set(), now, { phoneJudge: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("I'd make it 2 to 1");
    // a voice judge hosts (a judge.line from A's phone): the phone says it
    const hosted = fold([...raws, ev('judge.line', { utterance_id: O3, text: 'hi', final: true })]);
    const phone = freshVoiceLines(hosted, BET, new Set(), now);
    expect(phone[0]!.phone).toBe(true);
  });
});

describe('ticker labels', () => {
  it('names the odds events', () => {
    const names = { A: 'Logan', B: 'Jake' };
    expect(
      eventLabel('odds.offered', { offer: { from: 'judge', ratio_label: '2 to 1' } }, names),
    ).toBe('Judge suggests 2 to 1');
    expect(
      eventLabel(
        'odds.offered',
        { offer: { from: 'B', ratio_label: '3 to 2', parent_id: O1 } },
        names,
      ),
    ).toBe('Jake counters 3 to 2');
    expect(eventLabel('odds.answered', { party: 'B', answer: 'accepted' }, names)).toBe(
      'Odds accepted · Jake',
    );
    expect(eventLabel('odds.agreed', { ratio_label: '2 to 1' }, names)).toBe(
      'Odds agreed · 2 to 1',
    );
  });
});

describe('?preview=odds', () => {
  it('is recognised and every step folds with no dropped frames', () => {
    expect(isOddsPreview('odds')).toBe(true);
    expect(isOddsPreview('odds-agreed')).toBe(true);
    expect(isOddsPreview('gemini')).toBe(false);
    expect(isOddsPreview(null)).toBe(false);
    for (const step of Object.keys(ODDS_STEPS) as OddsStep[]) {
      const f = at(step);
      expect(f.state.dropped, step).toBe(0);
      expect(f.state.errors, step).toEqual([]);
      expect(f.t).toBe(ODDS_STEPS[step]);
    }
    const end = previewOddsAt(START, START + ODDS_LOOP_MS - 1);
    expect(end.state.dropped).toBe(0);
  });

  it('the card is recomposed with the agreed stakes (a valid skill Terms hash)', () => {
    const b = focus(at('agreed').state);
    expect(b.envelope!.terms.stakes).toMatchObject({ a: '5000000', b: '10000000' });
    expect(b.envelope!.terms_hash).toBe(hashJcs(b.envelope!.terms));
    expect(b.odds!.state.agreed.at(-1)!.terms_hash).toBe(b.envelope!.terms_hash);
  });

  it('offer: Logan asks 3 to 1, Jake to answer', () => {
    const html = render('offer');
    expect(html).toContain('PREVIEW · sample data');
    expect(html).toContain('Logan made an offer. Jake taps Accept or Counter.');
    expect(html).toContain('Logan asks 3 to 1');
    expect(html).toContain('Jake gives 3 to 1');
    expect(html).not.toContain("Judge's odds");
  });

  it("suggest / waiting: the judge's odds from Jake's record, who still has to accept", () => {
    const s = render('suggest');
    expect(s).toContain("Judge's odds");
    expect(s).toContain('Bottle flips 10–2');
    expect(s).toContain('Demo history');
    expect(s).toContain('Logan asks 3 to 1');
    expect(s).toContain('Judge suggests 2 to 1');
    expect(s).toContain('Waiting on both');
    expect(render('waiting')).toContain('Waiting on Jake');
  });

  it('agreed: the strip ends Agreed, the moment says both confirm', () => {
    const html = render('agreed');
    expect(showsOdds(focus(at('agreed').state))).toBe(true);
    expect(html).toContain('Agreed · both confirm with Face ID');
    expect(html).toContain('Judge suggests 2 to 1 ✓');
    expect(html).toContain('Agreed · winner takes $15');
  });

  it('locked: the odds leave the moment; the terms card keeps them; $15 in escrow', () => {
    const f = at('locked');
    const b = focus(f.state);
    expect(phaseOf(b)).toBe('play');
    expect(oddsOnTable(b.odds, b.envelope!.terms)).toBe(true); // still the card's odds…
    const html = render('locked');
    expect(html).not.toContain("Judge's odds"); // …but the moment is the lock now
    expect(html).toContain('Jake gives 2 to 1');
    expect(html).toContain('$15 in escrow');
  });

  it('the moment is the odds only in the terms phase', () => {
    const v: OddsView | null = focus(at('offer').state).odds;
    expect(v?.state.open).not.toBeNull();
    expect(phaseOf(focus(at('offer').state))).toBe('terms');
  });
});
