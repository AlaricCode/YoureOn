// Deterministic parts of the PENDING-KEY fixture runner (TASKS D0-J3): the propose_terms tool
// schema it gives Claude, grading, and the conversation loop against a scripted Messages API.
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  elToJsonSchema,
  gradeFixture,
  loadFixtures,
  PROPOSE_TERMS_TOOL,
  runFixture,
  summarize,
  systemPrompt,
  type CreateMessage,
} from '../src/judge/fixture-runner';

const fixtures = loadFixtures();

/** A scripted "judge": asks `questions`, then calls propose_terms with the fixture's sample args. */
function scripted(questions: string[], input: unknown, opts: { refuseText?: boolean } = {}) {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const create: CreateMessage = async (p) => {
    seen.push(structuredClone(p));
    const content: Anthropic.ContentBlock[] =
      i < questions.length
        ? [{ type: 'text', text: questions[i]!, citations: null } as Anthropic.TextBlock]
        : opts.refuseText
          ? [
              {
                type: 'text',
                text: 'Nope. Not on my docket.',
                citations: null,
              } as Anthropic.TextBlock,
            ]
          : [
              { type: 'text', text: 'Noted.', citations: null } as Anthropic.TextBlock,
              {
                type: 'tool_use',
                id: `tu_${i}`,
                name: 'propose_terms',
                input,
              } as unknown as Anthropic.ToolUseBlock,
            ];
    i += 1;
    return {
      content,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    } as Anthropic.Message;
  };
  return { create, seen };
}

describe('fixture runner (PENDING-KEY live run; deterministic parts)', () => {
  it('loads all 12 fixtures', () => {
    expect(fixtures).toHaveLength(12);
  });

  it('the propose_terms tool is the agent schema minus the dynamic-variable ids', () => {
    const s = PROPOSE_TERMS_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(s.properties)).not.toContain('conversation_id');
    expect(Object.keys(s.properties)).not.toContain('bet_id');
    expect(s.required).toHaveLength(11);
    expect(elToJsonSchema({ type: 'string', enum: ['A'], description: 'x' })).toEqual({
      type: 'string',
      enum: ['A'],
      description: 'x',
    });
  });

  it('the system prompt fills the dynamic variables', () => {
    const p = systemPrompt(fixtures[0]!);
    expect(p).toContain('Party A is Logan');
    expect(p).toContain('Party B is Jake');
    expect(p).not.toMatch(/\{\{/);
  });

  for (const f of fixtures) {
    it(`${f.id}: a judge that behaves like the fixture passes`, async () => {
      const qs = Array.from({ length: f.min_questions }, (_, k) => `Question ${k + 1}?`);
      const { create, seen } = scripted(qs, f.sample_args);
      const run = await runFixture(create, f);
      expect(run.stop).toBe(f.kind === 'refusal' ? 'refused' : 'readback');
      expect(gradeFixture(f, run)).toMatchObject({ pass: true, reasons: [] });
      // mirrors the agent's LLM settings: no temperature, thinking off at low effort, 300 tokens
      const p = seen[0]!;
      expect(p).not.toHaveProperty('temperature');
      expect(p).toMatchObject({
        model: 'claude-haiku-5-5',
        max_tokens: 300,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
      });
      // scripted answers reached the model, in order
      for (const [k, a] of f.answers.slice(0, f.min_questions).entries())
        expect(JSON.stringify(seen[k + 1]!.messages)).toContain(a.text);
    });
  }

  it('fails a run with too many questions, a wrong category or wrong terms', async () => {
    const bottle = fixtures.find((f) => f.id === '01-bottle-flip')!;
    const tooMany = await runFixture(
      scripted(['a?', 'b?', 'c?'], bottle.sample_args).create,
      bottle,
    );
    expect(tooMany.stop).toBe('out_of_answers');
    expect(gradeFixture(bottle, tooMany).pass).toBe(false);

    const wrongTerms = await runFixture(
      scripted(['a?'], { ...bottle.sample_args, yes_party: 'A' }).create,
      bottle,
    );
    expect(gradeFixture(bottle, wrongTerms).reasons).toContain('yes_party: got "A", want "B"');

    const chug = fixtures.find((f) => f.id === '10-chug')!;
    const silent = await runFixture(
      scripted([], chug.sample_args, { refuseText: true }).create,
      chug,
      { maxTurns: 2 },
    );
    expect(gradeFixture(chug, silent).reasons[0]).toMatch(/no refusal/);
  });

  it('a question asked in the same turn as a tool call is counted and answered', async () => {
    const bottle = fixtures.find((f) => f.id === '01-bottle-flip')!;
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
    let i = 0;
    const create: CreateMessage = async (p) => {
      seen.push(structuredClone(p));
      const turn = i++;
      const input = turn === 0 ? { ...bottle.sample_args, edge_cases: [] } : bottle.sample_args;
      return {
        content: [
          {
            type: 'text',
            text: turn === 0 ? 'Bold. Cap counts, or base only?' : 'Noted.',
            citations: null,
          } as Anthropic.TextBlock,
          {
            type: 'tool_use',
            id: `tu_${turn}`,
            name: 'propose_terms',
            input,
          } as unknown as Anthropic.ToolUseBlock,
        ],
        stop_reason: 'tool_use',
      } as Anthropic.Message;
    };
    const run = await runFixture(create, bottle);
    expect(run.questions).toEqual(['Bold. Cap counts, or base only?']);
    expect(run.stop).toBe('readback');
    // the tool result and the scripted answer go back in one user turn, tool_result first
    const second = seen[1]!.messages.at(-1)!;
    expect(Array.isArray(second.content)).toBe(true);
    const blocks = second.content as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(blocks[1]!.text).toContain(bottle.answers[0]!.text);
    expect(gradeFixture(bottle, run).pass).toBe(true);
  });

  it('summary: the DoD needs 8/8 benign and 4/4 refusals', () => {
    const g = fixtures.map((f) => ({ id: f.id, kind: f.kind, pass: true, reasons: [] }));
    expect(summarize(g)).toEqual({ benign: '8/8', refusals: '4/4', dod: true });
    g[0]!.pass = false;
    expect(summarize(g).dod).toBe(false);
  });
});
