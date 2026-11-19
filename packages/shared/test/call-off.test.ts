// API-CONTRACT §2.9a "Call it off": the CALLED_OFF_MODEL ruling widening (frameless, only ever
// VOID 'safety_stop'), the bet.call_off event and the open-request rule.
import { describe, expect, it } from 'vitest';
import {
  CALL_OFF_TTL_MS,
  CALLED_OFF_MODEL,
  CALLED_OFF_REASON,
  CallOffRecord,
  CallOffRequest,
  callOffOpen,
  callOffPath,
  hashJcs,
  HearingRuling,
  parseRealtimeEvent,
  Ruling,
} from '../src';
import { stageLineFor } from '../src/stage-voice';
import { hearingRulingExample, rulingExample } from './fixtures';

const BET = '7f2c9a4e-1b3d-4c5e-8f6a-0b1c2d3e4f5a';

function record(): CallOffRecord {
  return CallOffRecord.parse({
    schema_version: 1,
    kind: 'call_off',
    bet_id: BET,
    terms_hash: 'ab'.repeat(32),
    attempt_no: 1,
    requested_by: 'A',
    requested_at: '2026-11-21T18:07:04.512Z',
    agreed_by: 'B',
    agreed_at: '2026-11-21T18:07:09.000Z',
  });
}

const calledOff = () => ({
  ...(rulingExample() as Record<string, unknown>),
  bet_id: BET,
  outcome: 'VOID',
  claim_result: 'UNCLEAR',
  redo_reason: null,
  void_reason: 'safety_stop',
  confidence: 1,
  reason: CALLED_OFF_REASON,
  cited_frames: [],
  frame_hashes: [],
  model: CALLED_OFF_MODEL,
  evidence_hash: hashJcs(record()),
});

const issuesAt = (input: unknown): string[] => {
  const r = Ruling.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('Ruling: the call-off widening (SCHEMAS §11)', () => {
  it("a call-off ruling is VOID 'safety_stop' and commits no frames", () => {
    expect(issuesAt(calledOff())).toEqual([]);
  });
  it('a call-off can never be decisive, a REDO, or another VOID reason', () => {
    expect(issuesAt({ ...calledOff(), outcome: 'A_WINS', void_reason: null })).toContain('outcome');
    expect(
      issuesAt({ ...calledOff(), outcome: 'REDO', void_reason: null, redo_reason: 'unclear' }),
    ).toContain('outcome');
    expect(issuesAt({ ...calledOff(), void_reason: 'max_redos' })).toContain('outcome');
  });
  it('a call-off commits no frames; a camera ruling still commits ≥ 1', () => {
    const one = (rulingExample() as { frame_hashes: string[] }).frame_hashes.slice(0, 1);
    expect(issuesAt({ ...calledOff(), frame_hashes: one })).toContain('frame_hashes');
    const camera = rulingExample() as Record<string, unknown>;
    expect(issuesAt({ ...camera, frame_hashes: [], cited_frames: [] })).toContain('frame_hashes');
  });
  it('a hearing ruling is not widened', () => {
    const h = hearingRulingExample() as Record<string, unknown>;
    const r = HearingRuling.safeParse({ ...h, model: CALLED_OFF_MODEL, frame_hashes: [] });
    expect(r.success).toBe(false);
  });
});

describe('bet.call_off and the request', () => {
  const env = (payload: unknown) => ({
    v: 1,
    type: 'bet.call_off',
    bet_id: BET,
    seq: 9,
    ts: '2026-11-21T18:07:04.512Z',
    source: 'server',
    payload,
  });
  it('parses requested / cleared / agreed; rejects unknown statuses', () => {
    const expires = '2026-11-21T18:08:04.512Z';
    expect(parseRealtimeEvent(env({ status: 'requested', by: 'A', expires_at: expires })).ok).toBe(
      true,
    );
    expect(parseRealtimeEvent(env({ status: 'cleared', by: 'B', expires_at: null })).ok).toBe(true);
    expect(parseRealtimeEvent(env({ status: 'agreed', by: 'operator', expires_at: null })).ok).toBe(
      true,
    );
    expect(parseRealtimeEvent(env({ status: 'expired', by: 'A', expires_at: null })).ok).toBe(
      false,
    );
  });
  it('a request is open until expires_at, and only while requested', () => {
    const at = Date.parse('2026-11-21T18:07:04.512Z');
    const p = {
      status: 'requested' as const,
      expires_at: new Date(at + CALL_OFF_TTL_MS).toISOString(),
    };
    expect(callOffOpen(p, at)).toBe(true);
    expect(callOffOpen(p, at + CALL_OFF_TTL_MS)).toBe(false);
    expect(callOffOpen({ ...p, status: 'cleared' }, at)).toBe(false);
    expect(callOffOpen(null, at)).toBe(false);
  });
  it('the body is strict; the path encodes the id', () => {
    expect(CallOffRequest.safeParse({ agree: true }).success).toBe(true);
    expect(CallOffRequest.safeParse({ agree: 'yes' }).success).toBe(false);
    expect(CallOffRequest.safeParse({ agree: true, extra: 1 }).success).toBe(false);
    expect(callOffPath(BET)).toBe(`/v1/bets/${BET}/call-off`);
  });
  it('the stage reads the call-off reason, not "Stopped for safety"', () => {
    const line = stageLineFor(
      { type: 'ruling.issued', payload: { ruling: calledOff() } },
      { A: 'Logan', B: 'Jake' },
    );
    expect(line?.text).toBe(CALLED_OFF_REASON);
  });
});
