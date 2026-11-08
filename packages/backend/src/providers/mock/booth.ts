/**
 * Mock booth providers (§13): advocates produce deterministic text; judges
 * vote the pre-ruling if any (confidence 8000). AI-judged → side 0 with
 * 7000, unless the transcript contains "no".
 */
import { MOCK_JUDGE_AI_CONF_BPS, MOCK_JUDGE_CONF_BPS, PRERULING_NO_CONTEST, PRERULING_WINNER } from '@verdict/engine';
import type { AdvocateBrief, AdvocateProvider, BoothCase, JudgeProvider, JudgeVote } from '../types.js';

export class MockAdvocate implements AdvocateProvider {
  readonly name = 'mock';

  async brief(c: BoothCase, side: 0 | 1, exhibitSlots: number): Promise<AdvocateBrief> {
    const exhibits = c.exhibits.slice(0, Math.max(0, exhibitSlots)).map((e) => e.id);
    const citations = c.exhibits
      .filter((e) => e.witness && exhibits.includes(e.id))
      .map((e) => `${e.witness}@${(Math.floor(e.t_start_ms / 100) / 10).toFixed(1)}s`)
      .filter((x) => /^(cam|mic)[1-8]@[0-9]{1,5}(\.[0-9])?s$/.test(x));
    const lead = c.readback[0] ?? 'the terms';
    const claim = `Side ${side === 0 ? 'A' : 'B'} wins: the footage shows ${lead.toLowerCase()} ${
      side === c.preruling_side ? 'as the pre-ruling found' : 'contrary to the pre-ruling'
    }.`.slice(0, 600);
    return { side, claim, citations, exhibits };
  }
}

export function mockJudgeVote(c: BoothCase): JudgeVote {
  if (c.ai_judged) {
    const no = /\bno\b/i.test(c.transcript);
    // §10.3: "yes" ⇒ the if_true side, "no" ⇒ the else side (outcome = side + 1)
    const ifTrue = c.program.outcome?.if_true ?? 0;
    const elseSide = c.program.outcome?.else ?? 1;
    const side = no ? elseSide : ifTrue;
    return { outcome: (side + 1) as 1 | 2, confidence_bps: MOCK_JUDGE_AI_CONF_BPS, rationale: `Mock judge: answered ${no ? 'no' : 'yes'}.` };
  }
  if (c.preruling === PRERULING_WINNER && c.preruling_side !== null) {
    return {
      outcome: (c.preruling_side + 1) as 1 | 2,
      confidence_bps: MOCK_JUDGE_CONF_BPS,
      rationale: 'Mock judge: the pre-ruling stands.',
    };
  }
  if (c.preruling === PRERULING_NO_CONTEST) {
    return { outcome: 0, confidence_bps: MOCK_JUDGE_CONF_BPS, rationale: 'Mock judge: no contest stands.' };
  }
  return { outcome: 0, confidence_bps: MOCK_JUDGE_CONF_BPS, rationale: 'Mock judge: no pre-ruling to uphold.' };
}

export class MockJudge implements JudgeProvider {
  readonly name = 'mock';
  readonly videoNative = true;
  async judge(c: BoothCase): Promise<JudgeVote> {
    return mockJudgeVote(c);
  }
}
