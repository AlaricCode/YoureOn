// checks.compiled / checks.report (src/checks/events.ts; API-CONTRACT §3.4): the envelope parses
// through RealtimeEvent, and malformed payloads are dropped like any unknown event.
import { describe, expect, it } from 'vitest';
import { parseRealtimeEvent } from '../../src/realtime';

const env = (type: string, payload: unknown) => ({
  v: 1,
  type,
  bet_id: '7b1f0a52-2a43-4f7e-9d0e-0d1c2b3a4f5e',
  seq: 9,
  ts: '2026-11-18T00:00:00.000Z',
  source: 'server',
  payload,
});
const HASH = 'ab'.repeat(32);

const report = {
  attempt_no: 1,
  status: 'ok',
  gate: 'true',
  need: 'unknown',
  veto: {
    kind: 'unconfirmed',
    why: "Couldn't confirm the bottle stands upright. Film from the side.",
  },
  results: [
    {
      role: 'gate',
      label: 'the bottle fully in shot at the end',
      value: 'true',
      why: 'ok',
      frames: [9, 10, 11],
      measures: [{ k: 'score', v: 0.95 }],
    },
    {
      role: 'need',
      label: 'the bottle stands upright',
      value: 'unknown',
      why: 'between_bands',
      frames: [9, 10, 11],
      measures: [
        { k: 'tilt_deg', v: 25.1 },
        { k: 'elong', v: 2.26 },
      ],
    },
  ],
  boxes: {
    '11': [{ key: 'bottle', prompt: 'bottle', box_xyxy: [120, 300, 160, 420], score: 0.95 }],
  },
  frame_size: { w: 288, h: 512 },
  report_hash: HASH,
};

describe('camera checks events', () => {
  it('checks.compiled and checks.report parse as RealtimeEvents', () => {
    expect(
      parseRealtimeEvent(
        env('checks.compiled', { terms_hash: HASH, decision: 'checks', readback: 'Ref cam: x.' }),
      ).ok,
    ).toBe(true);
    expect(parseRealtimeEvent(env('checks.report', report)).ok).toBe(true);
    expect(
      parseRealtimeEvent(
        env('checks.report', {
          ...report,
          status: 'unavailable',
          gate: 'unknown',
          need: 'unknown',
          veto: null,
          results: [],
          boxes: {},
          frame_size: null,
        }),
      ).ok,
    ).toBe(true);
  });

  it('malformed payloads are refused (dropped by clients)', () => {
    expect(
      parseRealtimeEvent(
        env('checks.compiled', { terms_hash: HASH, decision: 'maybe', readback: '' }),
      ).ok,
    ).toBe(false);
    expect(parseRealtimeEvent(env('checks.report', { ...report, boxes: { '12': [] } })).ok).toBe(
      false,
    );
    expect(
      parseRealtimeEvent(env('checks.report', { ...report, veto: { kind: 'flip', why: 'x' } })).ok,
    ).toBe(false);
    expect(parseRealtimeEvent(env('checks.reports', report)).ok).toBe(false);
  });
});
