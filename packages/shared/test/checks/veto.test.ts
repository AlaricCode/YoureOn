// SAM 3.1 camera checks, design final.md §7: how a CheckReport combines with Claude's verdict.
// Checks only ever refuse: a veto turns MET/NOT_MET into REDO, never picks or flips a winner.
import { describe, expect, it } from 'vitest';
import {
  type CheckReport,
  type CheckValue,
  checksVeto,
  kleeneAnd,
  kleeneOr,
} from '../../src/checks/report';
import { CheckSpec } from '../../src/checks/spec';

const SPEC = CheckSpec.parse({
  predicates: 'p1',
  entities: [
    { key: 'paper', prompt: 'paper ball', count: 1 },
    { key: 'person', prompt: 'person', count: 1 },
    { key: 'table', prompt: 'table', count: 1 },
  ],
  assertions: [
    { role: 'gate', test: { p: 'visible', e: 'table', window: 'end' } },
    { role: 'need', test: { p: 'ends_at', a: 'paper', b: 'table' } },
    { role: 'need', test: { p: 'switched_sides', a: 'person', b: 'table' } },
  ],
});

function rep(values: CheckValue[], status: 'ok' | 'unavailable' = 'ok'): CheckReport {
  const off = status === 'unavailable';
  return {
    schema_version: 1,
    predicates: 'p1',
    status,
    sam_rev: 'test',
    sam_reply_hash: off ? null : 'c'.repeat(64),
    terms_hash: 'a'.repeat(64),
    frame_hashes: ['b'.repeat(64)],
    results: off
      ? []
      : values.map((value) => ({
          value,
          why: value === 'abstain' ? 'never_seen' : 'ok',
          frames: [],
          measures: [],
        })),
    gate: off ? 'unknown' : kleeneAnd(values.slice(0, 1)),
    need: off ? 'unknown' : kleeneAnd(values.slice(1)),
    created_at: '2026-11-18T00:00:00.000Z',
  };
}
const kind = (claim: 'MET' | 'NOT_MET' | 'UNCLEAR', values: CheckValue[]) =>
  checksVeto(claim, SPEC, rep(values))?.kind ?? null;

describe('Kleene logic (§7)', () => {
  it('AND: false dominates, then unknown; abstain rows drop out; empty is true', () => {
    expect(kleeneAnd([])).toBe('true');
    expect(kleeneAnd(['abstain'])).toBe('true');
    expect(kleeneAnd(['true', 'unknown'])).toBe('unknown');
    expect(kleeneAnd(['unknown', 'false'])).toBe('false');
    expect(kleeneAnd(['true', 'abstain', 'true'])).toBe('true');
  });
  it('OR: true dominates, then unknown', () => {
    expect(kleeneOr(['false', 'unknown'])).toBe('unknown');
    expect(kleeneOr(['false', 'true', 'unknown'])).toBe('true');
    expect(kleeneOr(['false', 'false'])).toBe('false');
  });
});

describe('checksVeto truth table (§7)', () => {
  it('checks: null, no report, or SAM unavailable: no veto (v1 behaviour)', () => {
    expect(checksVeto('MET', null, rep(['false', 'false', 'false']))).toBeNull();
    expect(checksVeto('MET', SPEC, null)).toBeNull();
    expect(checksVeto('MET', SPEC, rep([], 'unavailable'))).toBeNull();
    expect(checksVeto('NOT_MET', SPEC, rep([], 'unavailable'))).toBeNull();
  });

  it('UNCLEAR is already REDO: the checks add nothing', () => {
    expect(kind('UNCLEAR', ['false', 'false', 'false'])).toBeNull();
  });

  it('gate not true: MET -> REDO; NOT_MET stands (out of shot never overturns a miss)', () => {
    for (const g of ['false', 'unknown'] as const) {
      expect(kind('MET', [g, 'true', 'true'])).toBe('not_on_camera');
      expect(kind('NOT_MET', [g, 'true', 'true'])).toBeNull();
    }
    expect(checksVeto('MET', SPEC, rep(['unknown', 'true', 'true']))?.why).toBe(
      "Couldn't see the table at the end. Keep it in frame and run it back.",
    );
  });

  it('MET, gate true: a false need contradicts, before any unknown need', () => {
    expect(kind('MET', ['true', 'unknown', 'false'])).toBe('contradicts');
    const v = checksVeto('MET', SPEC, rep(['true', 'unknown', 'false']));
    expect(v).toEqual({
      kind: 'contradicts',
      index: 2,
      why: 'Checks disagree: the person ended on the same side of the table.',
    });
  });

  it('MET, gate true: an unknown need is unconfirmed, with its filming hint', () => {
    expect(checksVeto('MET', SPEC, rep(['true', 'unknown', 'true']))).toEqual({
      kind: 'unconfirmed',
      index: 1,
      why: "Couldn't confirm the paper ball not seen lying away from the table. Keep both in view.",
    });
    expect(checksVeto('MET', SPEC, rep(['true', 'true', 'unknown']))?.why).toBe(
      "Couldn't confirm the person starts on one side of the table and ends on the other. Film from the side.",
    );
  });

  it('MET, gate true, needs true (or abstaining): MET stands', () => {
    expect(kind('MET', ['true', 'true', 'true'])).toBeNull();
    expect(kind('MET', ['true', 'abstain', 'true'])).toBeNull();
  });

  it('NOT_MET, gate true: stands whatever the needs say (needs are never sufficient)', () => {
    for (const n of ['true', 'false', 'unknown', 'abstain'] as const)
      expect(kind('NOT_MET', ['true', n, n])).toBeNull();
  });

  it('no gates at all: the gate side is true', () => {
    const s = CheckSpec.parse({
      predicates: 'p1',
      entities: [{ key: 'bottle', prompt: 'bottle', count: 1 }],
      assertions: [{ role: 'need', test: { p: 'upright', e: 'bottle' } }],
    });
    expect(checksVeto('NOT_MET', s, rep(['false']))).toBeNull();
    expect(checksVeto('MET', s, rep(['false']))?.why).toBe(
      'Checks disagree: the bottle ended lying down.',
    );
  });

  it('touching last_Ns too short says so', () => {
    const s = CheckSpec.parse({
      predicates: 'p1',
      entities: [
        { key: 'face', prompt: 'face', count: 1 },
        { key: 'spoon', prompt: 'spoon', count: 1 },
      ],
      assertions: [
        { role: 'need', test: { p: 'touching', a: 'spoon', b: 'face', window: 'last_3s' } },
      ],
    });
    const r = rep(['false']);
    r.results[0]!.why = 'clip_too_short';
    expect(checksVeto('MET', s, r)?.why).toBe(
      'Checks disagree: the clip is shorter than 3 seconds.',
    );
    r.results[0]!.value = 'unknown';
    expect(checksVeto('MET', s, r)?.why).toContain("Stop filming while it's still balanced.");
  });
});
