import { describe, expect, it } from 'vitest';
import { conditionRows, formatUsd, parseYaml, readback } from '../src/lang/index.js';
import { marketHashHex } from '../src/lang/readback.js';
import type { Program } from '../src/types.js';
import { AI_JUDGED_AST, CREATOR, CTX2, CUP_TOWER_AST, FRIEND, NAMES, oneLeg, PAPER_BALL_AST, PUSHUPS_AST } from './lang-fixtures.js';

const rctx = { names: NAMES };

function prog(src: string): Program {
  const r = parseYaml(src, CTX2);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.program;
}
/** First readback line of a one-leg program with the given success expression and rule. */
function line(success: string, rule = 'success'): string {
  return readback(prog(oneLeg({ success, rule })), rctx)[0]!;
}

describe('readback (§2.8)', () => {
  it('worked example 15.1', () => {
    expect(readback(PAPER_BALL_AST as Program, { names: NAMES, labels: { ball: 'Paper Ball' } })).toEqual([
      'Counts if: Maya releases paper ball and Maya is behind the line',
      'Wins an attempt if: paper ball goes into the opening of trash can or (paper ball is inside trash can and paper ball stays still for 1s)',
      'Needs at least 1 of 3 attempts',
      'Maya win if leg 1; otherwise Alex win',
      '$5.00 each',
      'Time limit 3m',
    ]);
  });

  it('worked examples 15.2–15.4', () => {
    expect(readback(CUP_TOWER_AST as Program, rctx)).toEqual([
      'cup tower stays standing for 10s straight',
      'Alex win if leg 1; otherwise Maya win',
      '$2.00 each',
      'Time limit 30s',
    ]);
    expect(readback(PUSHUPS_AST as Program, rctx)).toEqual([
      'Alex does at least 20 reps within 1m',
      'Alex win if leg 1; otherwise Maya win',
      '$10.00 each',
      'Time limit 1m 30s',
    ]);
    expect(readback(AI_JUDGED_AST as Program, rctx)).toEqual([
      'Question: Does Sam finish the hot sauce wing without drinking anything?',
      'Maya win if yes; otherwise Alex win',
      '$3.00 each',
      'Time limit 2m',
    ]);
  });

  it('every expression template', () => {
    const cases: [string, string][] = [
      ['ball overlaps can', 'ball overlaps can'],
      ['ball inside area', 'ball is inside the zone'],
      ['ball above can', 'ball is above can'],
      ['ball below can.interior', 'ball is below the inside of can'],
      ['ball behind mark', 'ball is behind the line'],
      ['ball beyond mark', 'ball is past the line'],
      ['ball near can 900', 'ball is near can'],
      ['ball moving', 'ball is moving'],
      ['ball present', 'ball is visible'],
      ['ball intact', 'ball stays standing'],
      ['anyone standing', 'someone is standing'],
      ['ball at_rest 1.5s', 'ball stays still for 1.5s'],
      ['ball speed >= 300', 'ball moves at least 300'],
      ['ball speed != 300', 'ball moves not exactly 300'],
      ['ball direction up', 'ball moves up'],
      ['rep_count(anyone) == 5', 'someone does exactly 5 reps'],
      ['ball enters can.opening', 'ball enters the opening of can'],
      ['ball leaves area', 'ball leaves the zone'],
      ['ball disappears_into can', 'ball goes into the opening of can'],
      ['ball touches anyone', 'ball touches someone'],
      ['ball crosses mark', 'ball crosses the line'],
      ['ball released_by anyone', 'someone releases ball'],
      ['not ball present', 'not: ball is visible'],
      ['ball present then_within 2s can present', 'ball is visible, then within 2s, can is visible'],
      ['ball moving for_duration 70s', 'ball is moving for 1m 10s'],
      ['ball moving before 0.5s', 'ball is moving before 0.5s'],
      ['ball present and can present and ball moving', 'ball is visible and can is visible and ball is moving'],
      ['ball present or can present and ball moving', 'ball is visible or (can is visible and ball is moving)'],
      ['(ball present or can present) for_duration 1s', '(ball is visible or can is visible) for 1s'],
    ];
    for (const [src, want] of cases) expect(line(src), src).toBe(want);
  });

  it('every rule template', () => {
    expect(line('ball present', 'never(success)')).toBe('Never: ball is visible');
    expect(line('ball present', 'count(success) > 2')).toBe('ball is visible, more than 2 times');
    expect(line('ball present', 'count(success) < 2')).toBe('ball is visible, fewer than 2 times');
    expect(line('ball present', 'count(success) <= 2')).toBe('ball is visible, at most 2 times');
    expect(line('ball present', 'holds(success) for 2.5s')).toBe('ball is visible for 2.5s straight');
    expect(line('ball present', 'success before_deadline 90s')).toBe('ball is visible within 1m 30s');
  });

  it('outcome conditions, multi-name sides and money', () => {
    const p = prog(
      oneLeg({
        success: 'ball present',
        extraLeg: '  - id: 2\n    actor_bound: false\n    success: can present\n    rule: success\n',
        outcome: 'side(B) wins iff not leg 1 or (leg 1 and leg 2 false); else side(A)',
      }).replace('stake_each: 1000000', 'stake_each: 123_456_789_012'),
    );
    const lines = readback(p, rctx);
    expect(lines[2]).toBe('Maya win if not leg 1 or (leg 1 and not leg 2); otherwise Alex win');
    expect(lines[3]).toBe('$123,456.78 each');
  });

  it('formatUsd', () => {
    expect(formatUsd(10_000)).toBe('$0.01');
    expect(formatUsd(19_999)).toBe('$0.01');
    expect(formatUsd(1_234_500_000)).toBe('$1,234.50');
    expect(formatUsd(1_000_000_000_000)).toBe('$1,000,000.00');
    expect(formatUsd(-5_000_000)).toBe('−$5.00');
  });

  it('market legs use labels by market hash, else event/contract', () => {
    const p: Program = {
      version: 2,
      kind: 'market',
      participants: [CREATOR, FRIEND],
      sides: [0, 1],
      entities: [],
      legs: [
        { id: 1, actor_bound: false, attempt_window_frames: 0, market: { venue: 'gemini', event_id: 'E1', contract_id: 'C1', side: 'yes', prob_bps: 6000 } },
        { id: 2, actor_bound: false, attempt_window_frames: 0, market: { venue: 'gemini', event_id: 'E2', contract_id: 'C2', side: 'no', prob_bps: 3000 } },
      ],
      outcome: { if_true: 0, condition: { op: 'and', args: [{ op: 'leg', id: 1 }, { op: 'leg', id: 2 }] }, else: 1 },
      stakes: [4_210_000, 5_790_000],
      time_limit_s: 86400,
    };
    expect(readback(p, { names: NAMES, markets: { [marketHashHex('E1', 'C1')]: 'Lakers beat Celtics' } })).toEqual([
      'Lakers beat Celtics resolves yes',
      'E2/C2 resolves no',
      'Alex win if leg 1 and leg 2; otherwise Maya win',
      'Stakes $4.21 / $5.79',
      'Time limit 1440m',
    ]);
    // sha256("gemini:E1:C1")
    expect(marketHashHex('E1', 'C1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('conditionRows (§12.10)', () => {
  it('paper ball rows with labels', () => {
    const rows = conditionRows(PAPER_BALL_AST as Program, { ball: 'Paper ball', can: 'Trash can', shooter: 'Maya' });
    expect(rows).toEqual([
      { leg: 1, field: 'valid_attempt', path: '0', label: 'Paper ball released' },
      { leg: 1, field: 'valid_attempt', path: '1', label: 'Behind line' },
      { leg: 1, field: 'success', path: '0', label: 'Into Trash can' },
      { leg: 1, field: 'success', path: '1.0', label: 'In Trash can' },
      { leg: 1, field: 'success', path: '1.1', label: 'Paper ball still' },
    ]);
  });

  it('dedups structurally equal atoms (first path wins), root leaf has path ""', () => {
    const p = prog(oneLeg({ success: 'ball present and (can present or ball present)' }));
    expect(conditionRows(p, {})).toEqual([
      { leg: 1, field: 'success', path: '0', label: 'ball visible' },
      { leg: 1, field: 'success', path: '1.0', label: 'can visible' },
    ]);
    expect(conditionRows(prog(oneLeg({ success: 'ball moving' })), {})[0]!.path).toBe('');
  });

  it('labels longer than 3 words fall back to the last word', () => {
    const p = prog(oneLeg({ success: 'ball moving and ball leaves can and ball direction left and rep_count(anyone) >= 2' }));
    expect(conditionRows(p, { ball: 'Crumpled paper ball', can: 'Big green can' }).map((r) => r.label)).toEqual([
      'ball moving',
      'Out of can',
      'ball left',
      'Reps',
    ]);
  });
});
