/**
 * Draft compile pipeline (§1, §2.7, §2.8, §12.3 `POST /bets/compile`):
 *
 *   transcript ─▶ COMPILER_PROVIDER (surface YAML, title, questions, labels)
 *     ─▶ engine.parseYaml (canonicalize + validate)
 *     ─▶ on invalid: recompile once with the engine errors fed back
 *     ─▶ clarifying questions for what only a human can answer
 *        (PARTICIPANTS_UNRESOLVED → "Who's in?", BAD_SIDES → sides, missing stake)
 *     ─▶ engine.toYaml / programHash / readback
 *
 * `PATCH /drafts/:id` re-canonicalizes deterministically through
 * `applyOverrides` (no LLM).
 */
import {
  canonicalizeDraft,
  MAX_STAKE_UNITS,
  MIN_STAKE_UNITS,
  MARKET_TIME_LIMIT_MAX_S,
  programHash,
  readback,
  TIME_LIMIT_MAX_S,
  toYaml,
  validateProgram,
  parseYaml,
  parseSurface,
  type CompileContext,
  type CompileError,
  type Program,
} from '@verdict/engine';
import { ApiError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import type { CompileResult, CompilerProvider, Question } from '../providers/types.js';
import type { DraftOverrides, DraftStatus } from './records.js';

/** Compiler attempts per compile request (first try + one recompile on invalid). */
export const MAX_COMPILE_ATTEMPTS = 2;

/** Errors a person resolves by answering a question, not by recompiling. */
const CLARIFY_CODES = new Set(['PARTICIPANTS_UNRESOLVED', 'BAD_SIDES']);

export interface Member {
  user: UserRecord;
  enrolled: boolean;
}

export function compileContext(creator: UserRecord, members: Member[]): CompileContext {
  return {
    creator: creator.wallet,
    huddle: members.map((m) => ({ wallet: m.user.wallet, display_name: m.user.display_name, enrolled: m.enrolled })),
  };
}

export const whoQuestion = (names: string[]): Question => ({ id: 'who', text: "Who's in?", kind: 'multi', chips: names, audio_url: null });
export const sidesQuestion = (names: string[]): Question => ({ id: 'sides', text: 'Who is against you?', kind: 'multi', chips: names, audio_url: null });
export const stakeQuestion = (): Question => ({ id: 'stake', text: 'Stake each?', kind: 'choice', chips: ['$1', '$5', '$10'], audio_url: null });

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .slice(-3)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** Entity labels: compiler labels, persons = display names, defaults from phrases. */
export function entityLabels(p: Program, given: Record<string, string>, names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of p.entities) {
    if (e.kind === 'person') {
      const w = p.participants[e.participant];
      out[e.name] = (w && names[w]) || given[e.name] || titleCase(e.name);
    } else if (given[e.name]) {
      out[e.name] = given[e.name]!.split(/\s+/).slice(0, 3).join(' ');
    } else if (e.kind === 'object') {
      out[e.name] = titleCase(e.phrase);
    } else if (e.kind === 'region') {
      out[e.name] = e.shape === 'line' ? 'Line' : 'Zone';
    } else {
      out[e.name] = 'Person';
    }
  }
  return out;
}

export interface Finished {
  program: Program;
  yaml: string;
  program_hash: string;
  readback: string[];
  labels: Record<string, string>;
}

export function finishProgram(p: Program, labels: Record<string, string>, names: Record<string, string>): Finished {
  const l = entityLabels(p, labels, names);
  return { program: p, yaml: toYaml(p), program_hash: programHash(p), readback: readback(p, { names, labels: l }), labels: l };
}

export interface CompileOutcome {
  status: DraftStatus;
  kind: CompileResult['kind'];
  title: string | null;
  questions: Question[];
  source_yaml: string | null;
  program: Program | null;
  labels: Record<string, string>;
  errors: CompileError[];
  warnings: CompileError[];
  source: string;
  attempts: number;
}

/** Runs the compiler (with one engine-guided recompile) and classifies the result. */
export async function runCompile(args: {
  compiler: CompilerProvider;
  creator: UserRecord;
  members: Member[];
  transcript: string;
  previous: { yaml: string | null; title: string | null; transcript: string | null } | null;
  answers: { question_id: string; answer: string }[];
  /** chip choices / answer-derived overrides applied on top of the compiler's YAML */
  overrides?: WalletOverrides | null;
}): Promise<CompileOutcome> {
  const reqMembers = args.members.map((m) => ({ user_id: m.user.id, display_name: m.user.display_name, wallet: m.user.wallet }));
  let errors: CompileError[] = [];
  let result: CompileResult | null = null;
  let attempts = 0;
  for (; attempts < MAX_COMPILE_ATTEMPTS; ) {
    attempts++;
    result = await args.compiler.compile({
      transcript: args.transcript,
      creator_user_id: args.creator.id,
      members: reqMembers,
      answers: args.answers,
      ...(args.previous ? { previous: args.previous } : {}),
      ...(errors.length ? { errors, rejected_yaml: result?.yaml ?? null } : {}),
    });
    if (!result.yaml) break;
    const parsed = parseWithOverrides(result.yaml, args.overrides ?? null, args.creator, args.members);
    if (parsed.ok) {
      return {
        status: result.questions.some((q) => q.kind !== 'region') ? 'needs_clarification' : 'ready',
        kind: parsed.program.kind,
        title: result.title,
        questions: result.questions,
        source_yaml: result.yaml,
        program: parsed.program,
        labels: result.labels,
        errors: [],
        warnings: parsed.warnings,
        source: result.source,
        attempts,
      };
    }
    errors = parsed.errors;
    if (errors.every((e) => CLARIFY_CODES.has(e.code))) break;
  }
  const r = result!;
  const others = args.members.filter((m) => m.user.id !== args.creator.id).map((m) => m.user.display_name);
  const questions = [...r.questions];
  const add = (q: Question) => {
    if (!questions.some((x) => x.id === q.id)) questions.push(q);
  };
  if (errors.some((e) => e.code === 'PARTICIPANTS_UNRESOLVED')) add(whoQuestion(others));
  if (errors.some((e) => e.code === 'BAD_SIDES')) add(sidesQuestion(others));
  if (errors.some((e) => e.code === 'BAD_STAKE' && /missing|required/i.test(e.message))) add(stakeQuestion());
  const blocking = questions.some((q) => q.kind !== 'region');
  const unresolvable = errors.filter((e) => !CLARIFY_CODES.has(e.code));
  const status: DraftStatus = r.yaml === null ? (blocking ? 'needs_clarification' : 'invalid') : unresolvable.length === 0 && blocking ? 'needs_clarification' : 'invalid';
  return {
    status,
    kind: r.kind,
    title: r.title,
    questions,
    source_yaml: r.yaml,
    program: null,
    labels: r.labels,
    errors: r.yaml === null && blocking ? [] : errors,
    warnings: [],
    source: r.source,
    attempts,
  };
}

// ---- PATCH /drafts/:id -------------------------------------------------------------

export function checkOverrides(o: DraftOverrides, kind: Program['kind']): void {
  if (o.stake_each_units !== undefined) {
    const s = o.stake_each_units;
    if (!Number.isSafeInteger(s) || s < MIN_STAKE_UNITS || s > MAX_STAKE_UNITS) throw new ApiError('BAD_STAKE');
  }
  if (o.time_limit_s !== undefined) {
    const max = kind === 'market' ? MARKET_TIME_LIMIT_MAX_S : TIME_LIMIT_MAX_S;
    if (!Number.isSafeInteger(o.time_limit_s) || o.time_limit_s < 1 || o.time_limit_s > max) {
      throw new ApiError('WRONG_STATE', 'time_limit_s out of range', 400);
    }
  }
}

/** Overrides resolved to wallets (participant 0 = the creator). */
export interface WalletOverrides {
  stake_each_units?: number;
  time_limit_s?: number;
  participants?: string[];
  sides?: Record<string, 0 | 1>;
}

export function hasOverrides(o: WalletOverrides | null | undefined): o is WalletOverrides {
  return !!o && (o.stake_each_units !== undefined || o.time_limit_s !== undefined || !!o.participants || !!o.sides);
}

/** User-id overrides → wallet overrides (unknown users are UNKNOWN_PARTICIPANT at validation). */
export function toWalletOverrides(o: DraftOverrides, creator: UserRecord, members: Member[]): WalletOverrides {
  const byId = new Map(members.map((m) => [m.user.id, m.user.wallet]));
  const out: WalletOverrides = {};
  if (o.stake_each_units !== undefined) out.stake_each_units = o.stake_each_units;
  if (o.time_limit_s !== undefined) out.time_limit_s = o.time_limit_s;
  if (o.participants) {
    const ids = [creator.id, ...o.participants.filter((id) => id !== creator.id)];
    out.participants = [...new Set(ids.map((id) => byId.get(id) ?? `unknown:${id}`))];
  }
  if (o.sides) {
    out.sides = {};
    for (const [id, side] of Object.entries(o.sides)) out.sides[byId.get(id) ?? `unknown:${id}`] = side;
  }
  return out;
}

/**
 * parseYaml with chip choices applied at the surface level, then the
 * engine's canonicalize + validate (so PATCH and answers are deterministic,
 * no LLM). With no overrides this is exactly `engine.parseYaml`.
 * For a canonical program, pass `toYaml(program)` as `src`.
 */
export function parseWithOverrides(
  src: string,
  o: WalletOverrides | null,
  creator: UserRecord,
  members: Member[],
): { ok: true; program: Program; warnings: CompileError[] } | { ok: false; errors: CompileError[] } {
  const ctx = compileContext(creator, members);
  if (!hasOverrides(o)) return parseYaml(src, ctx);
  const surface = parseSurface(src);
  if (!surface.draft) return { ok: false, errors: surface.errors };
  const d = structuredClone(surface.draft);
  for (const w of [...(o.participants ?? []), ...Object.keys(o.sides ?? {})]) {
    if (w.startsWith('unknown:')) {
      return { ok: false, errors: [{ path: 'participants', code: 'UNKNOWN_PARTICIPANT', message: `${w.slice(8)} is not a confirmed member` }] };
    }
  }
  if (o.stake_each_units !== undefined && d.kind !== 'market') d.stake_each = o.stake_each_units;
  if (o.time_limit_s !== undefined) d.time_limit_s = o.time_limit_s;

  const sideOf = new Map<string, 0 | 1>();
  if (Array.isArray(d.sides) && d.participants) d.participants.forEach((w, i) => sideOf.set(w, (d.sides as (0 | 1)[])[i] ?? 1));
  const oldStakes = new Map((d.participants ?? []).map((w, i) => [w, d.stakes?.[i]]));
  if (o.participants) d.participants = o.participants;
  for (const [w, s] of Object.entries(o.sides ?? {})) sideOf.set(w, s);
  if (!d.participants && o.sides) {
    const inHuddle = members.map((m) => m.user.wallet).filter((w) => w !== creator.wallet && o.sides![w] !== undefined);
    d.participants = [creator.wallet, ...inHuddle];
  }
  if ((o.participants || o.sides) && d.participants) {
    d.sides = d.participants.map((w, i) => (i === 0 ? 0 : (sideOf.get(w) ?? 1)));
    if (d.kind === 'market' && d.stakes) d.stakes = d.participants.map((w) => oldStakes.get(w) ?? d.stakes![0]!);
  }
  const canon = canonicalizeDraft(d, ctx);
  if (!canon.program) return { ok: false, errors: canon.errors };
  const v = validateProgram(canon.program, ctx, { sideEntities: canon.sideEntities });
  if (v.errors.length) return { ok: false, errors: v.errors };
  return { ok: true, program: canon.program, warnings: v.warnings };
}

/** "sides" answer (comma list of names / user ids on the other side) → overrides. */
export function sidesFromAnswer(answer: string, creator: UserRecord, members: Member[]): Record<string, 0 | 1> {
  const picked = answer
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: Record<string, 0 | 1> = {};
  for (const m of members) {
    if (m.user.id === creator.id) continue;
    out[m.user.id] = picked.includes(m.user.display_name.toLowerCase()) || picked.includes(m.user.id) ? 1 : 0;
  }
  return out;
}
