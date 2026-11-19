import { describe, expect, it } from 'vitest';

import { canRematch } from '../../app/rematch';
import { bottleFlip, btcCloser, danceOff } from '../../preview/data';
import {
  betView,
  canAppeal,
  canConcede,
  clockLabel,
  countdownLabel,
  myResult,
  rulingEnds,
  rulingFooter,
  rulingRematch,
  signedUsd,
} from '../view';

describe('betView (SCHEMAS §2.5 bottle flip)', () => {
  const { terms, termsHash } = bottleFlip('Logan');
  it('reads the same terms from either phone', () => {
    const a = betView(terms, termsHash, 'A');
    const b = betView(terms, termsHash, 'B');
    expect([a.myName, a.theirName, b.myName, b.theirName]).toEqual([
      'Logan',
      'Jake',
      'Jake',
      'Logan',
    ]);
    expect(a.termsCode).toBe(b.termsCode);
    expect(a.termsCode).toMatch(/^[0-9a-f]{8}$/);
  });
  it('shows dollars, never micro-units', () => {
    const v = betView(terms, termsHash, 'A');
    expect([v.myStakeUsd, v.theirStakeUsd, v.potUsd]).toEqual(['$5', '$5', '$10']);
    expect(v.odds).toBeNull();
    expect(v.performerName).toBe('Jake');
    expect(v.evidence).toBe('Camera');
    expect(v.attempts).toBe('1 try');
    expect(v.edgeCases[0]?.question).toBe('Does landing on the cap count?');
  });
});

describe('betView (SCHEMAS §2.6 BTC closer)', () => {
  const { terms, termsHash } = btcCloser('Logan');
  it('shows fair stakes and odds from each side', () => {
    const a = betView(terms, termsHash, 'A');
    const b = betView(terms, termsHash, 'B');
    expect([a.myStakeUsd, a.theirStakeUsd, a.odds]).toEqual(['$6.20', '$3.80', '62/38']);
    expect([b.myStakeUsd, b.odds]).toEqual(['$3.80', '38/62']);
    expect(a.kind).toBe('market');
    expect(a.evidence).toBe('Gemini market');
    // A holds YES (Up), B the other side; both see the line bound into the terms
    expect([a.mySide, b.mySide]).toEqual(['Up', 'Down']);
    expect(a.lineUsd).toBe('$97,250.03');
    const bottle = bottleFlip('Logan');
    expect(betView(bottle.terms, bottle.termsHash, 'A')).toMatchObject({
      mySide: null,
      lineUsd: null,
    });
  });
});

describe('betView (DANCE-OFF §1 dance off)', () => {
  const { terms, termsHash } = danceOff('Logan', 'Jake');
  it('is its own kind: even money, no performer, no odds, the round instead of tries', () => {
    const a = betView(terms, termsHash, 'A');
    const b = betView(terms, termsHash, 'B');
    expect(a.kind).toBe('dance');
    expect([a.myStakeUsd, a.theirStakeUsd, a.potUsd]).toEqual(['$5', '$5', '$10']);
    expect([a.odds, a.ratio, a.toWin, a.mySide, a.lineUsd]).toEqual([null, null, null, null, null]);
    expect(a.performerName).toBeNull();
    expect(a.evidence).toBe('Pose score');
    expect(a.attempts).toBe('15 seconds');
    expect([a.myName, b.myName]).toEqual(['Logan', 'Jake']);
  });
  it('reads the routine line as the routine, only for the bundled routine', () => {
    const v = betView(terms, termsHash, 'A');
    expect(v.routineTitle).toBe('Wave Pop');
    expect(v.success[0]).toBe('Wave Pop, 15 seconds');
    expect(v.success[1]).toBe(terms.success_criteria[1]);
    expect(betView(bottleFlip('Logan').terms, 'ab'.repeat(32), 'A').routineTitle).toBeNull();
  });
  it('the round line is the routine\'s own length (a 32.6 s routine reads "33 seconds")', () => {
    const long = danceOff('Logan', 'Jake', 'bye-bye-shuffle');
    const v = betView(long.terms, long.termsHash, 'A');
    expect(long.terms.claim).toBe(
      'Dance Off: Bye Bye Shuffle, 33 seconds, higher match score wins, $5 each',
    );
    expect(v.attempts).toBe('33 seconds');
    expect(v.success[0]).toBe('Bye Bye Shuffle, 33 seconds');
  });
  it('no appeal on a dance off: the score is deterministic', () => {
    const v = betView(terms, termsHash, 'B');
    expect(canAppeal(v, 'lost', 10_000, 0)).toBe(false);
    expect(canConcede('lost', 10_000, 0)).toBe(true);
  });
});

describe('rulingFooter', () => {
  it('GG for the loser while open, Back home once the bet is over, else waiting', () => {
    expect(rulingFooter('lost', false)).toBe('gg');
    expect(rulingFooter('won', false)).toBe('waiting');
    expect(rulingFooter('void', false)).toBe('waiting');
    for (const r of ['won', 'lost', 'void', 'redo'] as const)
      expect(rulingFooter(r, true)).toBe('home');
  });
});

describe('the ruling footer never jumps (a VOID: call-off, too close to call, three REDOs)', () => {
  it('a VOID ruling gets the end footer from the moment it shows, every state through VOIDED', () => {
    // RULED -> FINALIZED -> VOIDED: Back home all along, never the "Final in" countdown first.
    for (const over of [false, false, true])
      expect(rulingFooter('void', rulingEnds('void', over))).toBe('home');
  });
  it('decisive rulings keep theirs: the loser GG, the winner waiting, until the bet is over', () => {
    expect(rulingFooter('lost', rulingEnds('lost', false))).toBe('gg');
    expect(rulingFooter('won', rulingEnds('won', false))).toBe('waiting');
    expect(rulingEnds('won', true)).toBe(true);
    expect(rulingEnds('lost', true)).toBe(true);
  });
  it('Double or nothing holds its place, disabled, until the server takes it', () => {
    // RULED, FINALIZED, VOIDED on a party phone: the secondary button is there in every frame.
    const frames = (['RULED', 'FINALIZED', 'VOIDED'] as const).map((s) =>
      rulingRematch(canRematch(s), true),
    );
    expect(frames).toEqual(['soon', 'ready', 'ready']);
    // The judge cam never rematches: Back home alone, as before.
    expect(rulingRematch(false, false)).toBeNull();
  });
});

describe('time', () => {
  it('formats a deadline as a clock time', () => {
    expect(clockLabel('2026-11-21T18:15:00.000Z', 0)).toBe('6:15 PM');
    expect(clockLabel('2026-11-21T18:15:00.000Z', -6 * 60)).toBe('12:15 PM');
    expect(clockLabel('2026-11-21T06:05:00.000Z', -6 * 60)).toBe('12:05 AM');
  });
  it('counts down without going negative', () => {
    expect(countdownLabel(295_000)).toBe('4:55');
    expect(countdownLabel(8_200)).toBe('0:09');
    expect(countdownLabel(-5)).toBe('0:00');
  });
});

describe('ruling on each phone', () => {
  it('maps the outcome to this party', () => {
    expect(myResult('A_WINS', 'A')).toBe('won');
    expect(myResult('A_WINS', 'B')).toBe('lost');
    expect(myResult('REDO', 'A')).toBe('redo');
    expect(myResult('VOID', 'B')).toBe('void');
  });
  it('offers the appeal to the loser of a camera bet until 1 s before the window ends', () => {
    const skill = { kind: 'skill' as const };
    expect(canAppeal(skill, 'lost', 10_000, 8_999)).toBe(true);
    expect(canAppeal(skill, 'lost', 10_000, 9_000)).toBe(false);
    expect(canAppeal(skill, 'won', 10_000, 0)).toBe(false);
    expect(canAppeal({ kind: 'market' }, 'lost', 10_000, 0)).toBe(false);
  });
  it('offers GG to the loser only', () => {
    expect(canConcede('lost', 10_000, 5_000)).toBe(true);
    expect(canConcede('void', 10_000, 5_000)).toBe(false);
    expect(canConcede('lost', 10_000, 11_500)).toBe(false);
  });
  it('formats a signed head-to-head net', () => {
    expect(signedUsd('-7000000')).toBe('−$7.00');
    expect(signedUsd('5000000')).toBe('+$5.00');
    expect(signedUsd('0')).toBe('$0.00');
    expect(signedUsd('-5000000')).toBe('−$5.00');
  });
});
