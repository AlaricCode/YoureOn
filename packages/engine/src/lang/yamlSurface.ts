/**
 * YAML surface syntax (§2.5) → `ProgramDraft`.
 *
 * The document is read with the YAML *failsafe* schema, so every scalar is a
 * string and all typing (ints with `_` separators, booleans, durations) is
 * done here, deterministically. Multi-line plain scalars are folded to single
 * spaces by the YAML parser before lexing (§2.5.1).
 */
import { parseDocument } from 'yaml';
import {
  INT_SEPARATOR_RE,
  YAML_AI_JUDGED_SYNONYM_KEY,
  YAML_LEG_KEYS,
  YAML_MARKET_KEYS,
  YAML_TOP_KEYS,
  DEFAULT_MARKET_VENUE,
} from '../constants.js';
import type {
  CompileError,
  CompileErrorCode,
  DraftEntity,
  DraftLeg,
  DraftMarketRef,
  DraftOutcome,
  Expr,
  ProgramDraft,
  ProgramKind,
  Rule,
  Side,
  SidesInput,
} from '../types.js';
import { compileError, ParseFailure } from './errors.js';
import { DURATION_RE, durationToFrames } from './duration.js';
import { entityNameProblem, parseEntityValue } from './entities.js';
import { parseExpr, parseOutcome, parseRule } from './parser.js';

type YVal = string | null | YVal[] | Map<string, YVal>;

const TOP_KEYS: ReadonlySet<string> = new Set<string>([...YAML_TOP_KEYS, YAML_AI_JUDGED_SYNONYM_KEY]);
const LEG_KEYS: ReadonlySet<string> = new Set<string>(YAML_LEG_KEYS);
const MARKET_KEYS: ReadonlySet<string> = new Set<string>(YAML_MARKET_KEYS);

export interface SurfaceResult {
  draft: ProgramDraft | null;
  errors: CompileError[];
}

class Ctx {
  errors: CompileError[] = [];
  err(path: string, code: CompileErrorCode, message: string, col?: number): void {
    this.errors.push(compileError(path, code, message, col));
  }

  /** Parse a string with one of the DSL parsers, converting failures into errors. */
  dsl<T>(path: string, v: YVal | undefined, fn: (s: string) => T): T | undefined {
    if (typeof v !== 'string' || v.trim() === '') {
      this.err(path, 'PARSE_ERROR', 'expected a non-empty string');
      return undefined;
    }
    try {
      return fn(v);
    } catch (e) {
      if (e instanceof ParseFailure) {
        this.err(path, e.code, e.message, e.col);
        return undefined;
      }
      throw e;
    }
  }

  /** Int field: an int scalar, or a string matching the `_`-separator pattern ([D-4]). */
  int(path: string, v: YVal | undefined, rangeCode: CompileErrorCode = 'PARSE_ERROR'): number | undefined {
    if (typeof v !== 'string' || !INT_SEPARATOR_RE.test(v)) {
      this.err(path, 'PARSE_ERROR', `expected a non-negative integer, got ${show(v)}`);
      return undefined;
    }
    const n = Number(v.replace(/_/g, ''));
    if (!Number.isSafeInteger(n)) {
      this.err(path, rangeCode, `integer ${v} is out of range`);
      return undefined;
    }
    return n;
  }

  bool(path: string, v: YVal | undefined): boolean | undefined {
    if (v === 'true') return true;
    if (v === 'false') return false;
    this.err(path, 'PARSE_ERROR', `expected true or false, got ${show(v)}`);
    return undefined;
  }

  str(path: string, v: YVal | undefined): string | undefined {
    if (typeof v !== 'string') {
      this.err(path, 'PARSE_ERROR', `expected a string, got ${show(v)}`);
      return undefined;
    }
    return v;
  }
}

function show(v: YVal | undefined): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return 'a list';
  return 'a map';
}

function isMap(v: YVal | undefined): v is Map<string, YVal> {
  return v instanceof Map;
}

/** Parse YAML source into a draft program. */
export function parseSurface(src: string): SurfaceResult {
  const c = new Ctx();
  const doc = parseDocument(src, { schema: 'failsafe', uniqueKeys: true, prettyErrors: false, strict: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const lp = e.linePos?.[0];
      c.err('', 'PARSE_ERROR', lp ? `YAML (line ${lp.line}, column ${lp.col}): ${e.message}` : `YAML: ${e.message}`);
    }
    return { draft: null, errors: c.errors };
  }
  let root: unknown;
  try {
    root = doc.toJS({ mapAsMap: true });
  } catch (e) {
    c.err('', 'PARSE_ERROR', `YAML: ${(e as Error).message}`);
    return { draft: null, errors: c.errors };
  }
  if (!isMap(root as YVal)) {
    c.err('', 'PARSE_ERROR', 'the program must be a YAML mapping');
    return { draft: null, errors: c.errors };
  }
  const top = root as Map<string, YVal>;
  for (const k of top.keys()) {
    if (typeof k !== 'string' || !TOP_KEYS.has(k)) c.err(String(k), 'PARSE_ERROR', `unknown top-level key ${JSON.stringify(String(k))}`);
  }

  // version
  if (!top.has('version')) c.err('version', 'PARSE_ERROR', 'version is required (must be 2)');
  else if (top.get('version') !== '2') c.err('version', 'PARSE_ERROR', `version must be 2, got ${show(top.get('version'))}`);

  // kind (+ ai_judged synonym)
  let kind: ProgramKind | undefined;
  if (top.has('kind')) {
    const k = top.get('kind');
    if (k === 'rules' || k === 'ai_judged' || k === 'market') kind = k;
    else c.err('kind', 'BAD_KIND', `kind must be rules, ai_judged or market, got ${show(k)}`);
  }
  if (top.has(YAML_AI_JUDGED_SYNONYM_KEY)) {
    const b = c.bool(YAML_AI_JUDGED_SYNONYM_KEY, top.get(YAML_AI_JUDGED_SYNONYM_KEY));
    if (b === true) {
      if (kind !== undefined && kind !== 'ai_judged') c.err('ai_judged', 'BAD_KIND', `ai_judged: true conflicts with kind: ${kind}`);
      kind = 'ai_judged';
    } else if (b === false && kind === 'ai_judged') {
      c.err('ai_judged', 'BAD_KIND', 'ai_judged: false conflicts with kind: ai_judged');
    }
  }

  // participants
  let participants: string[] | undefined;
  if (top.has('participants')) {
    const v = top.get('participants');
    if (!Array.isArray(v)) c.err('participants', 'PARSE_ERROR', 'participants must be a list of wallet keys');
    else {
      participants = [];
      v.forEach((p, i) => {
        const s = c.str(`participants[${i}]`, p);
        if (s !== undefined) participants!.push(s);
      });
    }
  }

  // sides
  let sides: SidesInput | undefined;
  if (top.has('sides')) sides = parseSides(c, top.get('sides'));

  // entities
  const entities: DraftEntity[] = [];
  if (top.has('entities')) {
    const v = top.get('entities');
    if (isMap(v)) {
      for (const [name, val] of v) {
        const path = `entities.${name}`;
        const problem = entityNameProblem(name);
        if (problem) {
          c.err(path, 'PARSE_ERROR', problem);
          continue;
        }
        if (typeof val !== 'string') {
          c.err(path, 'PARSE_ERROR', `entity value must be a string, got ${show(val)}`);
          continue;
        }
        const r = parseEntityValue(name, val.trim());
        if ('error' in r) c.err(path, 'PARSE_ERROR', r.error);
        else entities.push(r.entity);
      }
    } else if (!(typeof v === 'string' && v === '')) {
      c.err('entities', 'PARSE_ERROR', 'entities must be a mapping name → entity');
    }
  }

  // legs
  const legs: DraftLeg[] = [];
  if (top.has('legs')) {
    const v = top.get('legs');
    if (Array.isArray(v)) v.forEach((l, i) => {
      const leg = parseLeg(c, `legs[${i}]`, l);
      if (leg) legs.push(leg);
    });
    else if (!(typeof v === 'string' && v === '')) c.err('legs', 'PARSE_ERROR', 'legs must be a list');
  }

  // question
  let question: string | undefined;
  if (top.has('question')) question = c.str('question', top.get('question'));

  // outcome
  let outcome: DraftOutcome | undefined;
  if (!top.has('outcome')) c.err('outcome', 'BAD_OUTCOME', 'outcome is required');
  else outcome = c.dsl('outcome', top.get('outcome'), parseOutcome);

  // money and time
  let stake_each: number | undefined;
  if (top.has('stake_each')) stake_each = c.int('stake_each', top.get('stake_each'), 'BAD_STAKE');
  let stakes: number[] | undefined;
  if (top.has('stakes')) {
    const v = top.get('stakes');
    if (!Array.isArray(v)) c.err('stakes', 'PARSE_ERROR', 'stakes must be a list of integers');
    else {
      stakes = [];
      v.forEach((s, i) => {
        const n = c.int(`stakes[${i}]`, s, 'BAD_STAKE');
        if (n !== undefined) stakes!.push(n);
      });
    }
  }
  let time_limit_s: number | undefined;
  if (top.has('time_limit_s')) time_limit_s = c.int('time_limit_s', top.get('time_limit_s'), 'BAD_TIME_LIMIT');

  if (c.errors.length > 0 || outcome === undefined) return { draft: null, errors: c.errors };

  const draft: ProgramDraft = { version: 2, entities, legs, outcome };
  if (kind !== undefined) draft.kind = kind;
  if (participants !== undefined) draft.participants = participants;
  if (sides !== undefined) draft.sides = sides;
  if (question !== undefined) draft.question = question;
  if (stake_each !== undefined) draft.stake_each = stake_each;
  if (stakes !== undefined) draft.stakes = stakes;
  if (time_limit_s !== undefined) draft.time_limit_s = time_limit_s;
  return { draft, errors: [] };
}

function parseSides(c: Ctx, v: YVal | undefined): SidesInput | undefined {
  if (Array.isArray(v)) {
    const out: Side[] = [];
    for (let i = 0; i < v.length; i++) {
      const s = v[i];
      if (s === '0' || s === '1') out.push(s === '0' ? 0 : 1);
      else {
        c.err(`sides[${i}]`, 'BAD_SIDES', `side must be 0 or 1, got ${show(s)}`);
        return undefined;
      }
    }
    return out;
  }
  if (isMap(v)) {
    const out: { A: string[]; B: string[] } = { A: [], B: [] };
    for (const [k, list] of v) {
      if (k !== 'A' && k !== 'B') {
        c.err(`sides.${k}`, 'BAD_SIDES', 'sides map keys must be A and B');
        return undefined;
      }
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
        c.err(`sides.${k}`, 'BAD_SIDES', 'sides map values must be lists of person entity names or wallet keys');
        return undefined;
      }
      out[k] = list as string[];
    }
    return out;
  }
  c.err('sides', 'BAD_SIDES', 'sides must be a list of 0/1 or a map {A: [...], B: [...]}');
  return undefined;
}

function parseLeg(c: Ctx, path: string, v: YVal): DraftLeg | null {
  if (!isMap(v)) {
    c.err(path, 'PARSE_ERROR', 'a leg must be a mapping');
    return null;
  }
  const before = c.errors.length;
  for (const k of v.keys()) {
    if (!LEG_KEYS.has(k)) c.err(`${path}.${k}`, 'PARSE_ERROR', `unknown leg key ${JSON.stringify(k)}`);
  }
  let id: number | undefined;
  if (!v.has('id')) c.err(`${path}.id`, 'PARSE_ERROR', 'leg id is required');
  else id = c.int(`${path}.id`, v.get('id'), 'LIMIT');
  let actor_bound: boolean | undefined;
  if (!v.has('actor_bound')) c.err(`${path}.actor_bound`, 'PARSE_ERROR', 'actor_bound is required');
  else actor_bound = c.bool(`${path}.actor_bound`, v.get('actor_bound'));

  let valid_attempt: Expr | undefined;
  if (v.has('valid_attempt')) valid_attempt = c.dsl(`${path}.valid_attempt`, v.get('valid_attempt'), parseExpr);
  let success: Expr | undefined;
  if (v.has('success')) success = c.dsl(`${path}.success`, v.get('success'), parseExpr);
  let rule: Rule | undefined;
  if (v.has('rule')) rule = c.dsl(`${path}.rule`, v.get('rule'), parseRule);
  let attempt_window_frames: number | undefined;
  if (v.has('attempt_window_s')) {
    const w = v.get('attempt_window_s');
    if (typeof w !== 'string' || !DURATION_RE.test(w)) c.err(`${path}.attempt_window_s`, 'PARSE_ERROR', `expected a duration such as 5s, got ${show(w)}`);
    else attempt_window_frames = durationToFrames(w);
  }
  let market: DraftMarketRef | undefined;
  if (v.has('market')) market = parseMarket(c, `${path}.market`, v.get('market'));

  if (c.errors.length > before || id === undefined || actor_bound === undefined) return null;
  const leg: DraftLeg = { id, actor_bound };
  if (attempt_window_frames !== undefined) leg.attempt_window_frames = attempt_window_frames;
  if (valid_attempt !== undefined) leg.valid_attempt = valid_attempt;
  if (success !== undefined) leg.success = success;
  if (rule !== undefined) leg.rule = rule;
  if (market !== undefined) leg.market = market;
  return leg;
}

function parseMarket(c: Ctx, path: string, v: YVal | undefined): DraftMarketRef | undefined {
  if (!isMap(v)) {
    c.err(path, 'PARSE_ERROR', 'market must be a mapping {event_id, contract_id, side, prob_bps, venue?}');
    return undefined;
  }
  for (const k of v.keys()) {
    if (!MARKET_KEYS.has(k)) c.err(`${path}.${k}`, 'PARSE_ERROR', `unknown market key ${JSON.stringify(k)}`);
  }
  const event_id = c.str(`${path}.event_id`, v.get('event_id'));
  const contract_id = c.str(`${path}.contract_id`, v.get('contract_id'));
  if (event_id === '') c.err(`${path}.event_id`, 'PARSE_ERROR', 'event_id must not be empty');
  if (contract_id === '') c.err(`${path}.contract_id`, 'PARSE_ERROR', 'contract_id must not be empty');
  const side = v.get('side');
  if (side !== 'yes' && side !== 'no') c.err(`${path}.side`, 'PARSE_ERROR', `market side must be yes or no, got ${show(side)}`);
  const prob = c.int(`${path}.prob_bps`, v.get('prob_bps'), 'LIMIT');
  let venue: 'gemini' | undefined;
  if (v.has('venue')) {
    if (v.get('venue') === DEFAULT_MARKET_VENUE) venue = 'gemini';
    else c.err(`${path}.venue`, 'BAD_KIND', `venue must be "gemini", got ${show(v.get('venue'))}`);
  }
  if (event_id === undefined || contract_id === undefined || (side !== 'yes' && side !== 'no') || prob === undefined) return undefined;
  const m: DraftMarketRef = { event_id, contract_id, side, prob_bps: prob };
  if (venue !== undefined) m.venue = venue;
  return m;
}
