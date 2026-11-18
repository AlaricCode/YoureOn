// The GG moment + spoken review contract (src/gg.ts; API-CONTRACT §3.4 bet.gg / review.requested /
// review.closed, §4.3 request_review, §4.5 PAID via): schemas, the record helpers, the realtime
// envelopes, the judge's tool + prompt, and the stage's GG line.
import { describe, expect, it } from 'vitest';
import { JudgeCueName } from '../src/api';
import {
  BetGgPayload,
  GG_RIVAL_MIN,
  PairRecord,
  PayoutVia,
  recordAfter,
  recordLine,
  REVIEW_HEARD_MAX,
  REVIEW_MIN_LEAD_MS,
  ReviewClosedPayload,
  ReviewFix,
  reviewOpen,
  ReviewRequestedPayload,
} from '../src/gg';
import {
  agentBody,
  DEFAULT_WEBHOOK_TOOLS,
  SKIP_TURN_TOOL,
  WEBHOOK_TOOL_SPECS,
  webhookToolConfig,
} from '../src/judge/el-config';
import { buildJudgePrompt, type JudgeToolName } from '../src/judge/persona';
import { parseRealtimeEvent } from '../src/realtime';
import { stageLineFor } from '../src/stage-voice';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const REVIEW = '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516';
const env = (type: string, payload: unknown) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: 9,
  ts: '2026-11-21T18:06:31.000Z',
  source: 'server',
  payload,
});
const rec = (o: Partial<PairRecord> = {}): PairRecord => ({
  a_wins: 4,
  b_wins: 7,
  pushes: 0,
  total: 11,
  streak: { party: 'B', length: 2 },
  rival: true,
  includes_seed: true,
  ...o,
});

describe('bet.gg', () => {
  const gg = {
    by: 'B',
    winner: 'A',
    to_a: '10000000',
    to_b: '0',
    record: { before: rec(), after: recordAfter(rec(), 'A') },
    conceded_at: '2026-11-21T18:06:31.000Z',
  };

  it('parses, with or without the record', () => {
    expect(BetGgPayload.parse(gg)).toEqual(gg);
    expect(BetGgPayload.parse({ ...gg, record: null }).record).toBeNull();
  });

  it('the loser is never the winner; amounts are micro-USDC strings', () => {
    expect(BetGgPayload.safeParse({ ...gg, by: 'A' }).success).toBe(false);
    expect(BetGgPayload.safeParse({ ...gg, to_a: 10 }).success).toBe(false);
    expect(BetGgPayload.safeParse({ ...gg, to_a: '-1' }).success).toBe(false);
    expect(BetGgPayload.safeParse({ ...gg, conceded_at: 'now' }).success).toBe(false);
  });

  it('is a realtime event (and a stale client drops an unknown one, never throws)', () => {
    const r = parseRealtimeEvent(env('bet.gg', gg));
    expect(r.ok && r.event.type).toBe('bet.gg');
    expect(parseRealtimeEvent(env('bet.ggg', gg)).ok).toBe(false);
  });
});

describe('review.requested / review.closed', () => {
  const req = {
    review_id: REVIEW,
    for_party: 'B',
    source: 'voice',
    requested_at: '2026-11-21T18:06:31.000Z',
    confirm_by: '2026-11-21T18:06:39.000Z',
  };

  it('parse as realtime events; no speech, no speaker on the wire', () => {
    expect(parseRealtimeEvent(env('review.requested', req)).ok).toBe(true);
    // the payload is closed to what the clients need: unknown fields are stripped, not carried
    expect(ReviewRequestedPayload.parse({ ...req, heard: 'check it' })).not.toHaveProperty('heard');
    expect(ReviewRequestedPayload.safeParse({ ...req, source: 'judge' }).success).toBe(false);
    for (const reason of ['declined', 'lapsed'])
      expect(parseRealtimeEvent(env('review.closed', { review_id: REVIEW, reason })).ok).toBe(true);
    expect(ReviewClosedPayload.safeParse({ review_id: REVIEW, reason: 'confirmed' }).success).toBe(
      false,
    );
  });

  it('reviewOpen: open until confirm_by, while RULED, not closed or confirmed', () => {
    const at = Date.parse(req.confirm_by);
    const rv = { confirm_by: req.confirm_by, closed: null, confirmed: false };
    expect(reviewOpen(rv, 'RULED', at - 1)).toBe(true);
    expect(reviewOpen(rv, 'RULED', at)).toBe(false);
    expect(reviewOpen({ ...rv, closed: 'declined' }, 'RULED', at - 1)).toBe(false);
    expect(reviewOpen({ ...rv, confirmed: true }, 'RULED', at - 1)).toBe(false);
    expect(reviewOpen(rv, 'CONCEDED', at - 1)).toBe(false);
    expect(reviewOpen(null, 'RULED', at - 1)).toBe(false);
  });

  it('constants and enums', () => {
    expect(REVIEW_MIN_LEAD_MS).toBe(1_500);
    expect(REVIEW_HEARD_MAX).toBe(80);
    expect(PayoutVia.options).toEqual(['gg', 'timeout', 'appeal']);
    expect(ReviewFix.options).toContain('WINDOW_CLOSED');
    expect(JudgeCueName.options).toContain('REVIEW_CLOSED');
  });
});

describe('recordAfter / recordLine', () => {
  it('ticks the winner over, extends or restarts the streak, flags a rivalry', () => {
    expect(recordAfter(rec(), 'A')).toEqual(
      rec({ a_wins: 5, total: 12, streak: { party: 'A', length: 1 } }),
    );
    expect(recordAfter(rec(), 'B').streak).toEqual({ party: 'B', length: 3 });
    const first = rec({ a_wins: 0, b_wins: 0, total: 0, streak: null, rival: false });
    expect(recordAfter(first, 'B')).toMatchObject({
      b_wins: 1,
      total: 1,
      streak: { party: 'B', length: 1 },
      rival: false,
    });
    expect(recordAfter(rec({ total: GG_RIVAL_MIN - 2, rival: false }), 'A').rival).toBe(false);
    expect(recordAfter(rec({ total: GG_RIVAL_MIN - 1, rival: false }), 'A').rival).toBe(true);
    // pushes don't change
    expect(recordAfter(rec({ pushes: 2 }), 'A').pushes).toBe(2);
  });

  it('recordLine: "Logan 5-7 Jake" (ASCII hyphen)', () => {
    expect(recordLine(recordAfter(rec(), 'A'), { A: 'Logan', B: 'Jake' })).toBe('Logan 5-7 Jake');
  });
});

describe('the judge: request_review + skip_turn (el-config, persona)', () => {
  const tools = (extra: JudgeToolName[]) =>
    new Set<JudgeToolName>(['propose_terms', 'confirm_terms', 'cue', ...extra]);

  it('request_review is a registered webhook tool; file_appeal (a speaker it cannot know) is gone', () => {
    expect(DEFAULT_WEBHOOK_TOOLS).toContain('request_review');
    expect(Object.keys(WEBHOOK_TOOL_SPECS)).not.toContain('file_appeal');
    const t = webhookToolConfig('request_review', 'https://x.example/', 'sec_1');
    expect(t).toMatchObject({
      name: 'request_review',
      pre_tool_speech: 'off',
      api_schema: { url: 'https://x.example/el/tools/request_review' },
    });
    const body = t.api_schema.request_body_schema;
    expect(body.required).toEqual(['heard']);
    expect(Object.keys(body.properties).sort()).toEqual(['bet_id', 'conversation_id', 'heard']);
    expect(t.description).toMatch(/check that again/);
    expect(t.description).toMatch(/decides nothing/);
  });

  it('the prompt: "# After the ruling" only with the tool; never names who asked; GG is not a request', () => {
    const p = buildJudgePrompt(tools(['request_review', 'skip_turn']));
    expect(p).toContain('# After the ruling');
    expect(p).toContain('call request_review at once');
    expect(p).toContain('never name who asked');
    expect(p).toContain('"GG" or "good game" said out loud is not a review request');
    expect(p).toContain('After "[EVENT] PAID" or "[EVENT] VOIDED" the bet is over');
    expect(p).toContain('call skip_turn');
    // the [EVENT] rule still holds
    expect(p).toContain("never a party's words");
    const without = buildJudgePrompt(tools([]));
    expect(without).not.toContain('# After the ruling');
    expect(without).not.toContain('request_review');
    expect(without).not.toContain('skip_turn');
  });

  it('agentBody: skip_turn is a built-in system tool (prompt.built_in_tools), only when asked for', () => {
    const on = agentBody({ toolIds: ['t1'], promptTools: tools(['request_review', 'skip_turn']) });
    expect(on.conversation_config.agent.prompt.built_in_tools).toEqual({
      skip_turn: SKIP_TURN_TOOL,
    });
    expect(SKIP_TURN_TOOL.params).toEqual({ system_tool_type: 'skip_turn', wait_timeout_secs: -1 });
    const off = agentBody({ toolIds: ['t1'], promptTools: tools([]) });
    expect(off.conversation_config.agent.prompt).not.toHaveProperty('built_in_tools');
    expect(on.name).toBe('youre-on-judge');
    expect(
      agentBody({ toolIds: [], promptTools: tools([]), name: 'x-test', tags: ['t'] }),
    ).toMatchObject({ name: 'x-test', tags: ['t'] });
  });
});

describe('the stage line for a GG payout', () => {
  const cue = (text: string) => ({
    type: 'judge.cue',
    payload: { cue: 'PAID', text, speak: true },
  });
  it('"Jake says GG. Logan takes $10." for via=gg; the plain line otherwise', () => {
    expect(
      stageLineFor(
        cue(
          '[EVENT] PAID winner=Logan amount=$10 to_a=$10 to_b=$0 via=gg loser=Jake record="Logan 5-7 Jake" :: Jake said GG.',
        ),
        { A: 'Logan', B: 'Jake' },
      ),
    ).toEqual({ voice: 'judge', text: 'Jake says GG. Logan takes $10.' });
    expect(
      stageLineFor(
        cue('[EVENT] PAID winner=Logan amount=$10 to_a=$10 to_b=$0 via=timeout loser=Jake :: x'),
        { A: null, B: null },
      )!.text,
    ).toBe('Paid. Logan takes $10.');
  });
});
