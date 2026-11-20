// Spoken-bet fixture runner: plays each fixture conversation against the live model and grades
// it. The run passes ("DoD MET") when every non-refusal fixture ends in a valid TermsProposal
// with the fields the fixture expects, and every refusal fixture in a refusal with the right
// RefusalCategory, each within its fixture's clarifying-question limits. The live run needs
// ANTHROPIC_API_KEY.
//
//   ALLOW_SPEND=true ANTHROPIC_API_KEY=… npx tsx apps/server/src/judge/fixture-runner.ts \
//     [--only=01-bottle-flip] [--model=claude-haiku-5-5]
//
// Every fixture makes paid Anthropic calls, so it refuses to run (SPEND_DISABLED, exit 2) unless
// ALLOW_SPEND=true, like every other paid mode (src/providers/spend.ts).
//
// It plays the judge's terms phase as text: the system prompt is the agent's persona
// (packages/shared/src/judge/persona.ts) with the dynamic variables filled in, the only tool is
// propose_terms with the same schema the agent registers (converted from the ElevenLabs subset to
// JSON Schema), and every tool call is answered by the same pure core the server handler uses
// (evaluateProposeTerms + proposeTermsReply). Party lines come from the fixture; each clarifying
// question (a judge turn ending in "?" without a tool call) gets the next scripted answer.
//
// The LLM settings mirror the agent: claude-haiku-5-5, AGENT_MAX_TOKENS, no temperature (Claude
// 5.x rejects non-default sampling), thinking disabled at effort low. This is the Anthropic API,
// not ElevenLabs' serving of the model, so latency numbers from it are not the voice latency.
//
// Deterministic parts (schema conversion, grading, the conversation loop against a scripted
// client) are unit-tested in apps/server/test/judge-fixture-runner.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import {
  DYNAMIC_VARIABLE_PLACEHOLDERS,
  buildJudgePrompt,
  renderPersona,
} from '@youre-on/shared/judge/persona';
import {
  PROPOSE_TERMS_BODY_SCHEMA,
  PROPOSE_TERMS_DESCRIPTION,
  type ElProperty,
} from '@youre-on/shared/judge/propose-terms';
import {
  evaluateProposeTerms,
  proposeTermsReply,
  type ProposeEvaluation,
  type ToolReply,
} from '@youre-on/shared/judge/reply';
import { AGENT_MAX_TOKENS } from '@youre-on/shared/judge/el-config';
import { SpokenBetFixture } from '@youre-on/shared/judge/fixture-schema';
import { assertSpendAllowed } from '../providers/spend';

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/shared/src/judge/fixtures',
);

export function loadFixtures(dir = FIXTURE_DIR): SpokenBetFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => SpokenBetFixture.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/**
 * ElevenLabs schema subset -> JSON Schema for the Messages API; dynamic-variable fields are
 * dropped (the platform fills them).
 */
export function elToJsonSchema(p: ElProperty): Record<string, unknown> {
  switch (p.type) {
    case 'object': {
      const props = Object.entries(p.properties).filter(
        ([, v]) => !('dynamic_variable' in v && v.dynamic_variable),
      );
      return {
        type: 'object',
        ...(p.description ? { description: p.description } : {}),
        properties: Object.fromEntries(props.map(([k, v]) => [k, elToJsonSchema(v)])),
        required: (p.required ?? []).filter((k) => props.some(([n]) => n === k)),
      };
    }
    case 'array':
      return {
        type: 'array',
        ...(p.description ? { description: p.description } : {}),
        items: elToJsonSchema(p.items),
      };
    default:
      return {
        type: p.type,
        ...(p.description ? { description: p.description } : {}),
        ...(p.enum ? { enum: p.enum } : {}),
      };
  }
}

export const PROPOSE_TERMS_TOOL = {
  name: 'propose_terms',
  description: PROPOSE_TERMS_DESCRIPTION,
  input_schema: elToJsonSchema(PROPOSE_TERMS_BODY_SCHEMA) as Anthropic.Tool['input_schema'],
} satisfies Anthropic.Tool;

export type CreateMessage = (
  p: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface ToolCallRecord {
  input: unknown;
  evaluation: ProposeEvaluation;
  reply: ToolReply;
}

export interface FixtureRun {
  id: string;
  questions: string[];
  calls: ToolCallRecord[];
  judgeLines: string[];
  stop: 'readback' | 'refused' | 'out_of_answers' | 'max_turns' | 'model_refusal' | 'error';
  error?: string;
}

export interface RunOptions {
  model?: string;
  maxTurns?: number;
}

const FAKE_CONV = 'conv_fixture';
const FAKE_BET = DYNAMIC_VARIABLE_PLACEHOLDERS.bet_id;

export function systemPrompt(f: SpokenBetFixture): string {
  return renderPersona(buildJudgePrompt(new Set(['propose_terms'])), {
    bet_id: FAKE_BET,
    party_a_name: f.party_a_name,
    party_b_name: f.party_b_name,
    max_stake_usd: '20',
  });
}

const lineOf = (f: SpokenBetFixture, l: { speaker: 'A' | 'B'; text: string }) =>
  `${l.speaker === 'A' ? f.party_a_name : f.party_b_name} (party ${l.speaker}): ${l.text}`;

/** One fixture conversation. `create` is the Messages API (or a scripted fake in tests). */
export async function runFixture(
  create: CreateMessage,
  f: SpokenBetFixture,
  o: RunOptions = {},
): Promise<FixtureRun> {
  const run: FixtureRun = { id: f.id, questions: [], calls: [], judgeLines: [], stop: 'max_turns' };
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: f.opening.map((l) => lineOf(f, l)).join('\n') },
  ];
  let rev = 0;
  let lastFp = '';
  try {
    for (let turn = 0; turn < (o.maxTurns ?? 8); turn++) {
      const res = await create({
        model: o.model ?? 'claude-haiku-5-5',
        max_tokens: AGENT_MAX_TOKENS,
        system: systemPrompt(f),
        tools: [PROPOSE_TERMS_TOOL],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        messages,
      });
      if (res.stop_reason === 'refusal') {
        run.stop = 'model_refusal';
        return run;
      }
      messages.push({ role: 'assistant', content: res.content });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      if (text) run.judgeLines.push(text);
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      if (uses.length) {
        const results: Anthropic.ToolResultBlockParam[] = [];
        let done: FixtureRun['stop'] | null = null;
        for (const u of uses) {
          const body = { conversation_id: FAKE_CONV, bet_id: FAKE_BET, ...(u.input as object) };
          const evaluation = evaluateProposeTerms(body, { realWorldEnabled: true });
          let reply: ToolReply;
          if (evaluation.kind === 'proposal') {
            const fp = JSON.stringify(evaluation.proposal);
            if (fp !== lastFp) {
              rev += 1;
              lastFp = fp;
            }
            reply = proposeTermsReply(evaluation, { rev });
            if (reply.next === 'readback') done = 'readback';
          } else reply = proposeTermsReply(evaluation);
          if (evaluation.kind === 'refused') done = 'refused';
          run.calls.push({ input: u.input, evaluation, reply });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(reply) });
        }
        if (done) {
          messages.push({ role: 'user', content: results });
          run.stop = done;
          return run;
        }
        // A question spoken in the same turn as a tool call (e.g. after a forced pre-tool line)
        // still counts toward the ≤ 2 limit, and its scripted answer follows the tool results.
        const content: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [
          ...results,
        ];
        if (text.includes('?')) {
          run.questions.push(text);
          const answer = f.answers[run.questions.length - 1];
          if (!answer) {
            messages.push({ role: 'user', content });
            run.stop = 'out_of_answers';
            return run;
          }
          content.push({ type: 'text', text: lineOf(f, answer) });
        }
        messages.push({ role: 'user', content });
        continue;
      }

      // A judge turn without a tool call: a clarifying question gets the next scripted answer.
      if (text.includes('?')) {
        run.questions.push(text);
        const answer = f.answers[run.questions.length - 1];
        if (!answer) {
          run.stop = 'out_of_answers';
          return run;
        }
        messages.push({ role: 'user', content: lineOf(f, answer) });
      } else {
        messages.push({
          role: 'user',
          content: `${f.party_a_name} (party A): So what are the terms?`,
        });
      }
    }
  } catch (e) {
    run.stop = 'error';
    run.error = e instanceof Error ? e.message : String(e);
  }
  return run;
}

export interface Grade {
  id: string;
  kind: SpokenBetFixture['kind'];
  pass: boolean;
  reasons: string[];
}

/** Pure grading of one run against its fixture (the pass criteria in the header). */
export function gradeFixture(f: SpokenBetFixture, run: FixtureRun): Grade {
  const reasons: string[] = [];
  const q = run.questions.length;
  if (q > f.max_questions) reasons.push(`${q} questions > max ${f.max_questions}`);
  if (q < f.min_questions) reasons.push(`${q} questions < min ${f.min_questions}`);
  if (f.kind === 'refusal') {
    const refused = run.calls.find((c) => c.evaluation.kind === 'refused');
    if (!refused) reasons.push(`no refusal (stop=${run.stop})`);
    else if (
      refused.evaluation.kind === 'refused' &&
      refused.evaluation.refusal.category !== f.refusal_category
    )
      reasons.push(`category ${refused.evaluation.refusal.category} != ${f.refusal_category}`);
  } else {
    const last = [...run.calls].reverse().find((c) => c.evaluation.kind === 'proposal');
    if (!last || last.evaluation.kind !== 'proposal')
      reasons.push(`no valid TermsProposal (stop=${run.stop})`);
    else {
      const p = last.evaluation.proposal;
      const c = f.checks!;
      const eq = (name: string, got: unknown, want: unknown) => {
        if (JSON.stringify(got) !== JSON.stringify(want))
          reasons.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      };
      eq('type', p.type, c.type);
      eq('performer', p.performer, c.performer);
      eq('yes_party', p.yes_party, c.yes_party);
      eq('amount', p.amount, c.amount);
      if (c.attempts) eq('attempts', p.attempts, c.attempts);
      if (c.market_side) eq('market_side', p.market_query?.a_side, c.market_side);
      for (const kw of c.edge_case_mentions ?? [])
        if (
          !p.edge_cases.some((e) =>
            `${e.question} ${e.answer}`.toLowerCase().includes(kw.toLowerCase()),
          )
        )
          reasons.push(`no edge case mentions "${kw}"`);
    }
  }
  if (run.stop === 'error') reasons.push(`error: ${run.error}`);
  return { id: f.id, kind: f.kind, pass: reasons.length === 0, reasons };
}

export function summarize(grades: Grade[]) {
  const benign = grades.filter((g) => g.kind !== 'refusal');
  const refusals = grades.filter((g) => g.kind === 'refusal');
  return {
    benign: `${benign.filter((g) => g.pass).length}/${benign.length}`,
    refusals: `${refusals.filter((g) => g.pass).length}/${refusals.length}`,
    dod: grades.length > 0 && grades.every((g) => g.pass),
  };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([a-z]+)=(.*)$/.exec(a);
      if (!m) throw new Error(`unknown argument ${a}`);
      return [m[1]!, m[2]!];
    }),
  );
  try {
    assertSpendAllowed({ ALLOW_SPEND: process.env.ALLOW_SPEND === 'true' }, 'fixture-runner');
  } catch (e) {
    process.stderr.write(`fixture-runner: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('fixture-runner: ANTHROPIC_API_KEY is not set (PENDING-KEY)\n');
    process.exit(2);
  }
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient({ apiKey });
  const create: CreateMessage = (p) => client.messages.create(p);
  const fixtures = loadFixtures().filter((f) => !args.only || f.id === args.only);
  const grades: Grade[] = [];
  for (const f of fixtures) {
    const run = await runFixture(create, f, { model: args.model });
    const g = gradeFixture(f, run);
    grades.push(g);
    process.stdout.write(
      `${g.pass ? 'PASS' : 'FAIL'} ${f.id} q=${run.questions.length} calls=${run.calls.length} stop=${run.stop}${g.reasons.length ? ` :: ${g.reasons.join('; ')}` : ''}\n`,
    );
  }
  const s = summarize(grades);
  process.stdout.write(
    `benign ${s.benign}, refusals ${s.refusals}, DoD ${s.dod ? 'MET' : 'NOT MET'}\n`,
  );
  process.exit(s.dod ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
