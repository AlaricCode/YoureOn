// Dance Off on the projector (dance.ts, preview-dance.ts): a dance_off bet (performer null, both
// dance) folds and renders at every step without the single-performer assumptions, `dance.scored`
// lands on the card, the play phase reads "Dance off", the phones both glow with the recorder
// filming, and the ruling shows both scores, the per-move grid and "Too close to call" for a void
// (a score, never a confidence percent).
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getRoutine } from '@youre-on/shared/dance/routine';
import { DANCE_OFF_MODEL } from '@youre-on/shared/ruling';
import {
  danceResult,
  danceRoutineOf,
  danceScoreLine,
  danceScoreText,
  danceSummaryLine,
  dancePlayStep,
  gradeTally,
  isDanceBet,
  keyMoveRows,
  tallyLine,
  type DanceView,
} from '../src/dance';
import { eventLabel } from '../src/format';
import { cueText, phoneCues, railSummary } from '../src/panes';
import { phaseOf, phaseSteps } from '../src/phase';
import { previewAt } from '../src/preview';
import { DANCE_LOOP_MS, DANCE_STEPS, isDancePreview, previewDanceAt } from '../src/preview-dance';
import { PAID_MOMENT_MS, shouldAutoPlay } from '../src/slowmo';
import { emptyBet, type BetView, type RulingView } from '../src/ticker';
import { BetCard } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

type Step = keyof typeof DANCE_STEPS;
const at = (step: Step, variant: '' | 'tie-' = '') => {
  const f = previewDanceAt(START, START, `dance-${variant}${step}`);
  return { ...f, bet: f.state.bets[f.state.focusBetId!]! };
};
const card = (step: Step, variant: '' | 'tie-' = '') => {
  const { bet, now } = at(step, variant);
  return text(renderToString(<BetCard bet={bet} now={now} />));
};
const STEPS = Object.keys(DANCE_STEPS) as Step[];
const WAVE_POP = getRoutine('wave-pop')!;

describe('the dance sample parses end to end', () => {
  for (const variant of ['', 'tie-'] as const)
    it(`every frame folds (${variant || 'win'})`, () => {
      const f = previewDanceAt(START, START + DANCE_LOOP_MS - 1, `dance${variant ? '-tie' : ''}`);
      expect(f.state.dropped).toBe(0);
      expect(f.state.errors).toEqual([]);
      const bet = f.state.bets[f.state.focusBetId!]!;
      expect(bet.envelope?.terms.type).toBe('dance_off');
      expect(bet.envelope?.terms.performer).toBeNull();
      expect(bet.dance).not.toBeNull();
      expect(bet.ruling?.model).toBe(DANCE_OFF_MODEL);
      expect(bet.payout).not.toBeNull();
    });

  it('?preview=dance and its steps are the dance sample', () => {
    expect(isDancePreview('dance')).toBe(true);
    expect(isDancePreview('dance-tie')).toBe(true);
    expect(isDancePreview('dance-ruling')).toBe(true);
    expect(isDancePreview('ruling')).toBe(false);
    expect(isDancePreview(null)).toBe(false);
  });

  it('renders every step of both variants without a single-performer crash', () => {
    for (const v of ['', 'tie-'] as const)
      for (const step of STEPS) {
        expect(() => card(step, v)).not.toThrow();
        const { bet } = at(step, v);
        expect(() => railSummary(bet)).not.toThrow();
        expect(() => phoneCues(bet)).not.toThrow();
      }
  });
});

describe('dance.scored on the card', () => {
  it('keeps the server scores, the winner, the grades, the checks and the validation', () => {
    const { bet } = at('ruling');
    const d = bet.dance!;
    expect(d.scores).toEqual({ a: 874, b: 710 });
    expect(d.winner).toBe('A');
    expect(d.too_close).toBe(false);
    expect(d.failed).toBeNull();
    expect(d.routine_id).toBe('wave-pop');
    expect(d.key_moves).toHaveLength(WAVE_POP.key_moves.length);
    expect(d.checks.max_people).toBe(2);
    expect(d.validation.verdict).toBe('valid');
    expect(d.announcer_line).toBe(bet.ruling!.reason);
  });

  it('is not there before the round is scored', () => {
    expect(at('dancing').bet.dance).toBeNull();
    expect(at('scoring').bet.dance).toBeNull();
  });

  it('the ticker row reads the scores', () => {
    const label = eventLabel(
      'dance.scored',
      { evidence: { scores: { a: 874, b: 710 } } },
      { A: 'Logan', B: 'Jake' },
    );
    expect(label).toBe('Dance scored · Logan 87.4 · Jake 71.0');
  });
});

describe('isDanceBet / the routine', () => {
  it('only dance offs', () => {
    expect(isDanceBet(at('terms').bet)).toBe(true);
    expect(isDanceBet(emptyBet('x'))).toBe(false);
    expect(isDanceBet(null)).toBe(false);
    const flip = previewAt(START, START, 'attempt');
    expect(isDanceBet(flip.state.bets[flip.state.focusBetId!]!)).toBe(false);
  });

  it('the routine from success_criteria[0]: title and key-move names', () => {
    const r = danceRoutineOf(at('terms').bet)!;
    expect(r.id).toBe('wave-pop');
    expect(r.title).toBe(WAVE_POP.title);
    expect(Object.keys(r.moves)).toHaveLength(WAVE_POP.key_moves.length);
    expect(r.moves[WAVE_POP.key_moves[0]!.id]).toBe(WAVE_POP.key_moves[0]!.name);
  });

  it('falls back to the claim, then to the scored record', () => {
    const base = at('terms').bet;
    const env = base.envelope!;
    const odd: BetView = {
      ...base,
      envelope: {
        ...env,
        terms: {
          ...env.terms,
          success_criteria: ['Routine somewhere-else v9 sha256:0123456789abcdef'],
        },
      },
    };
    expect(danceRoutineOf(odd)?.title).toBe(WAVE_POP.title); // "Dance Off: Wave Pop, 15 seconds…"
    const cold: BetView = { ...emptyBet('y'), dance: at('ruling').bet.dance };
    expect(danceRoutineOf(cold)?.title).toBe(WAVE_POP.title);
  });

  it('key-move rows carry the names and both grades', () => {
    const rows = keyMoveRows(at('ruling').bet);
    expect(rows).toHaveLength(WAVE_POP.key_moves.length);
    expect(rows[0]!.name).toBe(WAVE_POP.key_moves[0]!.name);
    expect(rows[0]!.a).toBe('PERFECT');
    expect(rows[0]!.b).toBe('GOOD');
    expect(keyMoveRows(at('dancing').bet)).toEqual([]);
  });
});

describe('scores and tallies', () => {
  it('tenths print with one decimal, clamped', () => {
    expect(danceScoreText(874)).toBe('87.4');
    expect(danceScoreText(1000)).toBe('100.0');
    expect(danceScoreText(0)).toBe('0.0');
    expect(danceScoreText(1500)).toBe('100.0');
    expect(danceScoreText(Number.NaN)).toBe('—');
  });

  it('the winner first in the score line', () => {
    expect(danceScoreLine({ scores: { a: 874, b: 710 }, winner: 'A' })).toBe('87.4 to 71.0');
    expect(danceScoreLine({ scores: { a: 650, b: 702 }, winner: 'B' })).toBe('70.2 to 65.0');
  });

  it('counts each grade', () => {
    const moves = [
      { a: 'PERFECT', b: 'MISS' },
      { a: 'PERFECT', b: 'GOOD' },
      { a: 'GOOD', b: 'MISS' },
    ] as const;
    expect(gradeTally(moves, 'A')).toEqual({ PERFECT: 2, GOOD: 1, MISS: 0 });
    expect(tallyLine(gradeTally(moves, 'A'))).toBe('2 perfect · 1 good');
    expect(tallyLine(gradeTally(moves, 'B'))).toBe('1 good · 2 miss');
    expect(tallyLine(gradeTally([], 'A'))).toBe('no key moves');
  });
});

describe('the result of a dance off', () => {
  const ruling = (outcome: string): RulingView => ({
    outcome,
    reason: 'line',
    confidence: 1,
    cited_frames: [],
    model: DANCE_OFF_MODEL,
    stage: 'attempt',
    void_reason: outcome === 'VOID' ? 'undecidable' : null,
    ruling_hash: 'a'.repeat(64),
    attempt_no: 1,
    redo_reason: null,
  });
  const scored = at('ruling').bet.dance!;
  const bet = (outcome: string, dance: Partial<DanceView> = {}): BetView => ({
    ...emptyBet('z'),
    ruling: ruling(outcome),
    dance: { ...scored, ...dance },
  });

  it('a winner, too close to call, or no contest', () => {
    expect(danceResult(bet('A_WINS'))).toEqual({ kind: 'win', winner: 'A' });
    expect(danceResult(bet('B_WINS'))).toEqual({ kind: 'win', winner: 'B' });
    expect(danceResult(bet('VOID', { too_close: true }))).toEqual({ kind: 'too_close' });
    expect(danceResult(bet('VOID', { failed: 'coverage_b' }))).toEqual({ kind: 'too_close' });
    expect(
      danceResult(bet('VOID', { validation: { verdict: 'invalid', notes: 'Jake left' } })),
    ).toEqual({ kind: 'no_contest' });
    expect(danceResult({ ...emptyBet('z'), ruling: ruling('VOID') })).toEqual({
      kind: 'too_close',
    });
    expect(danceResult({ ...emptyBet('z'), dance: scored })).toBeNull();
  });

  it('the summary line', () => {
    const name = (p: 'A' | 'B') => (p === 'A' ? 'Logan' : 'Jake');
    expect(danceSummaryLine(bet('A_WINS'), name)).toBe('Logan wins · Logan 87.4 · Jake 71.0');
    expect(danceSummaryLine({ ...emptyBet('z'), dance: scored }, name)).toBe(
      'Logan 87.4 · Jake 71.0',
    );
    expect(danceSummaryLine(emptyBet('z'), name)).toBeNull();
  });
});

describe('the phase rail and the play steps', () => {
  it('the play phase reads "Dance off"', () => {
    const steps = phaseSteps(at('dancing').bet);
    expect(steps.find((s) => s.key === 'play')).toMatchObject({
      label: 'Dance off',
      status: 'current',
    });
    expect(phaseSteps(null).find((s) => s.key === 'play')?.label).toBe('Attempt');
  });

  it('framing -> dancing -> scoring', () => {
    expect(dancePlayStep(at('framing').bet)).toBe('framing');
    expect(dancePlayStep(at('dancing').bet)).toBe('dancing');
    expect(dancePlayStep(at('scoring').bet)).toBe('scoring');
    expect(phaseOf(at('scoring').bet)).toBe('play');
    expect(phaseOf(at('ruling').bet)).toBe('ruling');
  });
});

describe('the phones (panes.ts)', () => {
  it('both glow in the round; the recorder films, the other dances', () => {
    for (const step of ['framing', 'dancing'] as const) {
      const { bet } = at(step);
      expect(phoneCues(bet)).toEqual({ A: 'act', B: 'act' });
      expect(cueText(bet, 'act', 'A')).toBe('filming');
      expect(cueText(bet, 'act', 'B')).toBe('dancing');
    }
  });

  it('nothing while it is scored; winner / loser once ruled; nothing on a void', () => {
    expect(phoneCues(at('scoring').bet)).toEqual({ A: null, B: null });
    expect(phoneCues(at('ruling').bet)).toEqual({ A: 'win', B: 'lose' });
    expect(phoneCues(at('ruling', 'tie-').bet)).toEqual({ A: null, B: null });
  });

  it('the status rail never names a single performer', () => {
    expect(railSummary(at('framing').bet).status).toBe('Locked · Logan left, Jake right');
    expect(railSummary(at('dancing').bet).status).toBe(
      `Dance off · ${WAVE_POP.title} · Logan and Jake are dancing`,
    );
    expect(railSummary(at('dancing').bet).phase).toBe('Dance off');
    expect(railSummary(at('scoring').bet).status).toBe('Scored · checking the round');
    expect(railSummary(at('ruling').bet).status).toBe('Logan wins · 87.4 to 71.0');
    expect(railSummary(at('ruling', 'tie-').bet)).toMatchObject({
      status: 'Too close to call · stakes refunded',
      tone: 'bad',
    });
    for (const step of STEPS) expect(railSummary(at(step).bet).status).not.toMatch(/is up/);
  });
});

describe('the big panel (view.tsx)', () => {
  it('terms: the routine, not its hash line', () => {
    const html = card('terms');
    expect(html).toContain(`${WAVE_POP.title}: 15 seconds, side by side`);
    expect(html).toContain(`${WAVE_POP.key_moves.length} key moves`);
    expect(html).toContain('PERFECT / GOOD / MISS');
    expect(html).not.toContain('sha256:');
  });

  it('framing: the routine, 15 seconds, who stands where', () => {
    const html = card('framing');
    expect(html).toContain(`>${WAVE_POP.title}<`);
    expect(html).toContain('>15 seconds<');
    expect(html).toContain('Get in frame: Logan on the left, Jake on the right.');
  });

  it('dancing: both names dancing, no single performer', () => {
    const html = card('dancing');
    expect(html).toContain(`>${WAVE_POP.title}<`);
    expect(html).toContain('>15 seconds<');
    expect(html).toContain('Logan and Jake are dancing');
    expect(html).toContain('● REC');
    expect(html).not.toMatch(/is up|Ready when you are/);
  });

  it('scoring: waiting on the server', () => {
    expect(card('scoring')).toContain('Scoring the round…');
  });

  it('ruled: the verdict, both scores, the per-move grid, a GG window, no percent', () => {
    const html = card('ruling');
    expect(html).toContain('>Logan wins<');
    expect(html).toContain('>87.4<');
    expect(html).toContain('>71.0<');
    expect(html).toContain('dance-score won');
    expect(html).toContain(`>${WAVE_POP.key_moves[0]!.name}<`);
    expect(html).toMatch(/class="grade perfect">PERFECT</);
    expect(html).toMatch(/class="grade good">GOOD</);
    expect(html).toMatch(/class="grade miss">MISS</);
    expect(html).toContain('8 perfect');
    expect(html).toContain('GG window');
    expect(html).not.toContain('Appeal window');
    expect(html).not.toMatch(/>[^<]*\d%[^<]*</); // a score, never a confidence percent
  });

  it('too close to call: a void reads as the headline, both refunded', () => {
    const html = card('ruling', 'tie-');
    expect(html).toContain('>Too close to call<');
    expect(html).toContain('Both stakes go back.');
    expect(html).toContain('>78.3<');
    expect(html).toContain('>77.1<');
    expect(html).not.toContain('dance-score won');
    expect(html).not.toContain('undecidable');
    expect(html).not.toMatch(/>[^<]*\d%[^<]*</);
  });

  it('paid: the verdict and the scores under the payout', () => {
    expect(card('paid')).toContain('Logan wins · Logan 87.4 · Jake 71.0');
    const tie = card('paid', 'tie-');
    expect(tie).toContain('Too close to call · Logan 78.3 · Jake 77.1');
    expect(phaseSteps(at('paid', 'tie-').bet).find((s) => s.key === 'paid')?.label).toBe('Refund');
  });
});

describe('slow-mo', () => {
  it('never auto-plays a dance off (no evidence clip: the scoreboard is the replay)', () => {
    const { bet } = at('paid');
    expect(bet.state).toBe('PAID');
    const seen = Date.parse(bet.paid_at!);
    expect(
      shouldAutoPlay({
        bet,
        paidSeenAt: seen,
        now: seen + PAID_MOMENT_MS,
        overlayOpen: false,
        operatorOpen: false,
        played: new Set(),
      }),
    ).toBe(false);
  });
});
