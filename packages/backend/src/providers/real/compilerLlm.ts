/**
 * Real bet compiler (COMPILER_PROVIDER=anthropic|openai|gemini|xai; paid,
 * behind the §13 spend guard via `llmEndpoint`). One JSON-producing chat
 * call per attempt: transcript + huddle → surface YAML (§2.5), title,
 * clarifying questions, labels. The drafts service validates the YAML with
 * `engine.parseYaml` and re-asks once with the engine errors (`req.errors`).
 *
 * All four adapters use plain HTTPS (`fetch`, injectable for tests), so the
 * backend carries no vendor SDKs and every provider shares one prompt.
 */
import { DEFAULT_TIME_LIMIT_S } from '@verdict/engine';
import type { CompileRequest, CompileResult, CompilerProvider, Question } from '../types.js';
import type { LlmEndpoint } from './llm.js';

export type FetchFn = typeof fetch;

export const DEFAULT_COMPILER_MODELS: Record<LlmEndpoint['provider'], string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4.1',
  gemini: 'gemini-2.5-flash',
  xai: 'grok-4',
};

export const ANTHROPIC_VERSION = '2023-06-01';

export const COMPILER_SYSTEM_PROMPT = `You compile a spoken friendly bet into the Verdict rule language (YAML, version 2).
Reply with ONE JSON object and nothing else:
{"kind":"rules"|"ai_judged","title":string (1-5 words, <=40 chars),"yaml":string|null,
 "questions":[{"id":string,"text":string (<=6 words),"kind":"choice"|"multi"|"free"|"region","chips":[string],"entity"?:string}],
 "labels":{entity_name: "1-3 word Title Case label"}}
Set "yaml" to null while a blocking question (any kind but "region") is open.

YAML keys: version (2), kind (rules|ai_judged), participants (optional), sides (optional; required with >2 participants, list of 0/1 aligned with participants, creator = 0), entities, legs, question (ai_judged only), outcome, stake_each (USDC base units, 1 USDC = 1_000_000, min 10_000), time_limit_s (default ${DEFAULT_TIME_LIMIT_S}).
Entities (name: [a-z][a-z0-9_]*): person(pN) for huddle member N (p0 = creator), person(any), object("noun phrase"), region(tap).
Legs: id (1..8), actor_bound (true iff success/valid_attempt mention a person(pN) entity), valid_attempt (optional), success, rule, attempt_window_s (optional).
Expression atoms: A overlaps|inside|above|below|behind|beyond|enters|leaves|disappears_into|touches|crosses|released_by B; A near B [dist]; A moving|present|intact|standing; A at_rest 1s; A speed >= N; A direction up|down|left|right; rep_count(A) >= N.
Combinators: and, or, not, while, X then_within 2s Y, X for_duration 2s, X before 10s. behind/beyond/crosses need a region B. B may be obj.opening or obj.interior. Never put "not" directly on a primitive.
Rules: success | never(success) | count(success) >= K [within attempts N] (needs valid_attempt when "within attempts") | holds(success) for 10s | success before 60s.
Actor-bound legs must be positive: no never(...), no count with < <= == !=; instead swap the outcome sides.
Outcome: "side(<person entity>|creator|A|B) wins iff leg 1 [and/or/not leg 2]; else side(other|creator|...)"; ai_judged: "side(A) wins iff yes; else side(B)".
If the bet cannot be checked by a camera with these primitives, use kind ai_judged with a yes/no question (<=280 chars), no entities/legs.
Questions: ask "Stake each?" (id "stake", chips ["$1","$5","$10"]) when no amount was said; "Who's in?" (id "who", kind "multi", chips = member names) when participants are unclear; one "region" question per region(tap) entity (entity = its name) describing where to tap.

Example ("I bet Maya can't get a paper ball in the trash can from behind that line. Three tries. Five bucks", members p0 = creator, p1 = Maya):
version: 2
entities:
  shooter: person(p1)
  ball: object("crumpled paper ball")
  can: object("trash can")
  line: region(tap)
legs:
  - id: 1
    actor_bound: true
    valid_attempt: ball released_by shooter while shooter behind line
    success: ball disappears_into can.opening or (ball inside can and ball at_rest 1s)
    rule: count(success) >= 1 within attempts 3
outcome: side(shooter) wins iff leg 1 true; else side(creator)
stake_each: 5_000_000
time_limit_s: 180`;

/** The user turn: everything the model needs, as JSON. */
export function compilerUserMessage(req: CompileRequest): string {
  return JSON.stringify({
    transcript: [req.previous?.transcript, req.transcript].filter(Boolean).join(' '),
    members: req.members.map((m, i) => ({ ref: `p${i}`, name: m.display_name, creator: m.user_id === req.creator_user_id })),
    answers: req.answers ?? [],
    previous_yaml: req.previous?.yaml ?? null,
    ...(req.errors?.length
      ? { rejected_yaml: req.rejected_yaml ?? null, validation_errors: req.errors, instruction: 'Fix every validation error and return corrected YAML.' }
      : {}),
  });
}

/** Extracts the first JSON object from model text (tolerates code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('compiler: no JSON object in model output');
  return JSON.parse(body.slice(start, end + 1));
}

const QUESTION_KINDS = new Set(['choice', 'multi', 'free', 'region']);

/** Validates and clamps the model's JSON into a CompileResult. */
export function toCompileResult(raw: unknown, source: string): CompileResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('compiler: output is not an object');
  const o = raw as Record<string, unknown>;
  const kind = o['kind'] === 'ai_judged' ? 'ai_judged' : 'rules';
  const titleRaw = typeof o['title'] === 'string' ? o['title'].trim() : '';
  const title = titleRaw ? titleRaw.split(/\s+/).slice(0, 5).join(' ').slice(0, 40) : null;
  const yaml = typeof o['yaml'] === 'string' && o['yaml'].trim() ? o['yaml'] : null;
  const questions: Question[] = [];
  for (const q of Array.isArray(o['questions']) ? o['questions'] : []) {
    if (typeof q !== 'object' || q === null) continue;
    const x = q as Record<string, unknown>;
    if (typeof x['id'] !== 'string' || typeof x['text'] !== 'string' || !QUESTION_KINDS.has(x['kind'] as string)) continue;
    if (questions.some((y) => y.id === x['id'])) continue;
    questions.push({
      id: x['id'].slice(0, 32),
      text: x['text'].trim().split(/\s+/).slice(0, 6).join(' '),
      kind: x['kind'] as Question['kind'],
      chips: Array.isArray(x['chips']) ? x['chips'].filter((c): c is string => typeof c === 'string').slice(0, 10) : [],
      ...(typeof x['entity'] === 'string' ? { entity: x['entity'] } : {}),
      audio_url: null,
    });
  }
  const labels: Record<string, string> = {};
  if (typeof o['labels'] === 'object' && o['labels'] !== null) {
    for (const [k, v] of Object.entries(o['labels'] as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) labels[k] = v.trim().split(/\s+/).slice(0, 3).join(' ');
    }
  }
  return { kind, title, yaml, questions, labels, source };
}

export interface LlmCompilerOptions {
  model?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export class LlmCompiler implements CompilerProvider {
  readonly name: string;
  readonly model: string;
  private readonly f: FetchFn;
  private readonly timeoutMs: number;

  constructor(
    readonly endpoint: LlmEndpoint,
    opts: LlmCompilerOptions = {},
  ) {
    this.name = endpoint.provider;
    this.model = opts.model ?? DEFAULT_COMPILER_MODELS[endpoint.provider];
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async compile(req: CompileRequest): Promise<CompileResult> {
    const text = await this.complete(COMPILER_SYSTEM_PROMPT, compilerUserMessage(req));
    return toCompileResult(extractJson(text), `${this.name}:${this.model}`);
  }

  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    const r = await this.f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw new Error(`compiler ${this.name}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json();
  }

  /** One system + user turn → model text. */
  async complete(system: string, user: string): Promise<string> {
    const { provider, apiKey, baseUrl } = this.endpoint;
    switch (provider) {
      case 'anthropic': {
        const j = (await this.post(
          `${baseUrl}/v1/messages`,
          { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': 'server-side-fallback-2026-07-01' },
          {
            model: this.model,
            max_tokens: 16000,
            system,
            messages: [{ role: 'user', content: user }],
            fallbacks: 'default',
          },
        )) as { stop_reason?: string; content?: { type: string; text?: string }[] };
        if (j.stop_reason === 'refusal') throw new Error('compiler anthropic: request declined');
        return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      }
      case 'openai':
      case 'xai': {
        const j = (await this.post(
          `${baseUrl}/v1/chat/completions`,
          { authorization: `Bearer ${apiKey}` },
          {
            model: this.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
          },
        )) as { choices?: { message?: { content?: string } }[] };
        return j.choices?.[0]?.message?.content ?? '';
      }
      case 'gemini': {
        const j = (await this.post(
          `${baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
          { 'x-goog-api-key': apiKey },
          {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { responseMimeType: 'application/json' },
          },
        )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      }
    }
  }
}
