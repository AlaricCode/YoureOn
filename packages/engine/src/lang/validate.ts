/**
 * Validation of canonical programs (§2.7).
 *
 * `validateProgram(p, ctx?)` never throws for well-typed input; it returns
 * blocking `errors` and non-blocking `warnings`. Without a compile context the
 * huddle-dependent checks (membership, enrollment, creator position, huddle
 * size) are skipped.
 */
import {
  ATTEMPTS_MAX,
  ATTEMPTS_MAX_ACTOR_BOUND,
  CMPS,
  DIRS,
  EVENT_OPS,
  FPS,
  MARKET_TIME_LIMIT_MAX_S,
  MAX_CHECKPOINTS,
  MAX_COND_NODES,
  MAX_DURATION_FRAMES,
  MAX_ENTITIES,
  MAX_EXPR_BYTES,
  MAX_EXPR_DEPTH,
  MAX_EXPR_NODES,
  MAX_HUDDLE,
  MAX_LEGS,
  MAX_PARTICIPANTS,
  MAX_STAKE_UNITS,
  MIN_DURATION_FRAMES,
  MIN_LEG_ID,
  MIN_PARTICIPANTS,
  MIN_STAKE_UNITS,
  MIN_TIME_LIMIT_S,
  NEAR_MAX,
  QUESTION_MAX_CHARS,
  QUESTION_MIN_CHARS,
  REPS_MAX,
  SPEED_MAX,
  TIME_LIMIT_MAX_S,
} from '../constants.js';
import type {
  CompileContext,
  CompileError,
  Entity,
  Expr,
  LeafExpr,
  Leg,
  Program,
  Rule,
  ValidationResult,
} from '../types.js';
import { compileError } from './errors.js';
import { entityNameProblem, isValidPhrase } from './entities.js';
import { condMetrics, exprMetrics, forEachLeaf, forEachNode, hasBRef, isLeaf, legIdsOf } from './walk.js';

const CMP_SET: ReadonlySet<string> = new Set<string>(CMPS);
const DIR_SET: ReadonlySet<string> = new Set<string>(DIRS);
const EVENT_SET: ReadonlySet<string> = new Set<string>(EVENT_OPS);
const BASE58_KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ValidateOptions {
  /**
   * Names of `person` entities referenced by `side(<entity>)` in the source outcome.
   * The canonical AST does not record this, so `UNUSED_PERSON` is only checked when
   * the caller (e.g. `parseYaml`) provides it.
   */
  sideEntities?: ReadonlySet<string>;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}
function inRange(n: unknown, lo: number, hi: number): boolean {
  return isInt(n) && n >= lo && n <= hi;
}

/** `k' = k` for `>=`, `k + 1` for `>` (§2.7, §3.8). Null for negative comparisons. */
export function kPrime(rule: Extract<Rule, { kind: 'count' }>): number | null {
  if (rule.cmp === '>=') return rule.k;
  if (rule.cmp === '>') return rule.k + 1;
  return null;
}

/** Person entities referenced by an expression (distinct, first-reference order). */
export function personsIn(e: Expr | undefined, byName: Map<string, Entity>): string[] {
  const out: string[] = [];
  if (!e) return out;
  forEachLeaf(e, (l) => {
    const refs = hasBRef(l) ? [l.a, l.b] : [l.a];
    for (const r of refs) {
      if (byName.get(r.e)?.kind === 'person' && !out.includes(r.e)) out.push(r.e);
    }
  });
  return out;
}

/** Whether a leg is actor-bound: references a `person` entity in valid_attempt or success. */
export function isActorBound(leg: Leg, byName: Map<string, Entity>): boolean {
  return personsIn(leg.valid_attempt, byName).length > 0 || personsIn(leg.success, byName).length > 0;
}

/** `persons(leg)` (§3.8). */
export function checkpointPersons(leg: Leg, byName: Map<string, Entity>): string[] {
  const va = personsIn(leg.valid_attempt, byName);
  return va.length > 0 ? va : personsIn(leg.success, byName);
}

/** `n_anchor(leg)` (§2.7); 0 for rules that cannot produce checkpoints (negative rules). */
export function nAnchor(rule: Rule | undefined): number {
  if (!rule) return 0;
  switch (rule.kind) {
    case 'count': {
      const kp = kPrime(rule);
      if (kp === null || kp === 0) return 0;
      return rule.attempts > 0 ? Math.min(kp, rule.attempts) : kp;
    }
    case 'exists':
    case 'before':
    case 'holds':
      return 1;
    default:
      return 0;
  }
}

/** Static checkpoint bound `Σ n_anchor(leg) × |persons(leg)|` over actor-bound legs (§2.7). */
export function staticCheckpointBound(p: Program): number {
  const byName = new Map(p.entities.map((e) => [e.name, e] as const));
  let total = 0;
  for (const leg of p.legs) {
    if (!isActorBound(leg, byName)) continue;
    total += nAnchor(leg.rule) * checkpointPersons(leg, byName).length;
  }
  return total;
}

class V {
  errors: CompileError[] = [];
  warnings: CompileError[] = [];
  err(path: string, code: CompileError['code'], msg: string): void {
    this.errors.push(compileError(path, code, msg));
  }
  warn(path: string, code: CompileError['code'], msg: string): void {
    this.warnings.push(compileError(path, code, msg));
  }
}

export function validateProgram(p: Program, ctx?: CompileContext, opts: ValidateOptions = {}): ValidationResult {
  const v = new V();
  const kind = p.kind;

  if (p.version !== 2) v.err('version', 'PARSE_ERROR', 'version must be 2');
  if (kind !== 'rules' && kind !== 'ai_judged' && kind !== 'market') {
    v.err('kind', 'BAD_KIND', `unknown kind ${JSON.stringify(kind)}`);
    return { errors: v.errors, warnings: v.warnings };
  }

  validateParticipants(v, p, ctx);
  validateSides(v, p);
  const byName = validateEntities(v, p, ctx);
  validateKindFields(v, p);

  // legs
  let prevId = 0;
  p.legs.forEach((leg, i) => {
    const path = `legs[${i}]`;
    if (!inRange(leg.id, MIN_LEG_ID, MAX_LEGS)) v.err(`${path}.id`, 'LIMIT', `leg id must be ${MIN_LEG_ID}..${MAX_LEGS}`);
    else if (leg.id <= prevId) v.err(`${path}.id`, 'LIMIT', 'leg ids must be unique and listed in ascending order');
    if (isInt(leg.id)) prevId = Math.max(prevId, leg.id);
    if (kind === 'market') validateMarketLeg(v, leg, path);
    else if (kind === 'rules') validateRulesLeg(v, p, leg, path, byName);
    else v.err(path, 'BAD_KIND', 'ai_judged programs have no legs');
  });

  validateOutcome(v, p);
  validateUsage(v, p, opts);

  if (kind === 'rules' && !v.errors.some((e) => e.code === 'CHECKPOINT_LIMIT' || e.code === 'NEGATIVE_ACTOR_RULE')) {
    const bound = staticCheckpointBound(p);
    if (bound > MAX_CHECKPOINTS) {
      v.err('legs', 'CHECKPOINT_LIMIT', `static identity checkpoint bound ${bound} exceeds ${MAX_CHECKPOINTS}`);
    }
  }
  return { errors: v.errors, warnings: v.warnings };
}

function validateParticipants(v: V, p: Program, ctx: CompileContext | undefined): void {
  const ps = p.participants;
  if (!Array.isArray(ps) || ps.length < MIN_PARTICIPANTS || ps.length > MAX_PARTICIPANTS) {
    v.err('participants', 'LIMIT', `a bet needs ${MIN_PARTICIPANTS}..${MAX_PARTICIPANTS} participants`);
    if (!Array.isArray(ps)) return;
  }
  const seen = new Set<string>();
  ps.forEach((w, i) => {
    if (typeof w !== 'string' || !BASE58_KEY_RE.test(w)) v.err(`participants[${i}]`, 'UNKNOWN_PARTICIPANT', 'participant must be a base58 wallet key');
    else if (seen.has(w)) v.err(`participants[${i}]`, 'UNKNOWN_PARTICIPANT', 'participants must be distinct');
    seen.add(w);
  });
  if (!ctx) return;
  if (ctx.huddle.length > MAX_HUDDLE) v.err('participants', 'LIMIT', `a huddle has at most ${MAX_HUDDLE} members`);
  if (ps.length > 0 && ps[0] !== ctx.creator) v.err('participants[0]', 'UNKNOWN_PARTICIPANT', 'participant 0 must be the creator');
  ps.forEach((w, i) => {
    if (!ctx.huddle.some((h) => h.wallet === w)) {
      v.err(`participants[${i}]`, 'UNKNOWN_PARTICIPANT', `${w} is not a confirmed huddle member`);
    }
  });
}

function validateSides(v: V, p: Program): void {
  const s = p.sides;
  if (!Array.isArray(s) || s.length !== p.participants.length) {
    v.err('sides', 'BAD_SIDES', 'sides must be aligned with participants');
    return;
  }
  if (s.some((x) => x !== 0 && x !== 1)) v.err('sides', 'BAD_SIDES', 'each side must be 0 or 1');
  else if (s[0] !== 0) v.err('sides', 'BAD_SIDES', 'the creator must be on side 0');
  else if (!s.includes(1)) v.err('sides', 'BAD_SIDES', 'both sides must be non-empty');
}

function validateEntities(v: V, p: Program, ctx: CompileContext | undefined): Map<string, Entity> {
  const byName = new Map<string, Entity>();
  if (p.entities.length > MAX_ENTITIES) v.err('entities', 'LIMIT', `at most ${MAX_ENTITIES} entities`);
  const personByParticipant = new Map<number, string>();
  for (const e of p.entities) {
    const path = `entities.${e.name}`;
    const problem = entityNameProblem(e.name);
    if (problem) v.err(path, 'PARSE_ERROR', problem);
    if (byName.has(e.name)) v.err(path, 'PARSE_ERROR', `duplicate entity name "${e.name}"`);
    byName.set(e.name, e);
    switch (e.kind) {
      case 'person': {
        if (!inRange(e.participant, 0, p.participants.length - 1)) {
          v.err(path, 'UNKNOWN_PARTICIPANT', `participant index ${e.participant} is out of range`);
          break;
        }
        const other = personByParticipant.get(e.participant);
        if (other !== undefined) v.err(path, 'DUPLICATE_PERSON', `"${e.name}" and "${other}" are bound to the same participant`);
        else personByParticipant.set(e.participant, e.name);
        if (ctx) {
          const m = ctx.huddle.find((h) => h.wallet === p.participants[e.participant]);
          if (m && !m.enrolled) v.err(path, 'NOT_ENROLLED', `${m.display_name} has not enrolled their face or voice`);
        }
        break;
      }
      case 'person_any':
        break;
      case 'object':
        if (typeof e.phrase !== 'string' || !isValidPhrase(e.phrase)) v.err(path, 'PARSE_ERROR', `invalid object phrase ${JSON.stringify(e.phrase)}`);
        break;
      case 'region':
        if (e.shape !== 'line' && e.shape !== 'zone') v.err(path, 'PARSE_ERROR', 'region shape must be line or zone in a canonical program');
        break;
      default:
        v.err(path, 'PARSE_ERROR', 'unknown entity kind');
    }
  }
  return byName;
}

function validateStake(v: V, path: string, n: unknown): void {
  if (!inRange(n, MIN_STAKE_UNITS, MAX_STAKE_UNITS)) {
    v.err(path, 'BAD_STAKE', `stake must be ${MIN_STAKE_UNITS}..${MAX_STAKE_UNITS} units`);
  }
}

function validateKindFields(v: V, p: Program): void {
  const kind = p.kind;
  const maxT = kind === 'market' ? MARKET_TIME_LIMIT_MAX_S : TIME_LIMIT_MAX_S;
  if (!inRange(p.time_limit_s, MIN_TIME_LIMIT_S, maxT)) {
    v.err('time_limit_s', 'BAD_TIME_LIMIT', `time_limit_s must be ${MIN_TIME_LIMIT_S}..${maxT}`);
  }
  if (kind !== 'ai_judged' && p.question !== undefined) v.err('question', 'BAD_KIND', `question is only allowed on ai_judged programs`);
  if (kind === 'ai_judged') {
    if (p.question === undefined) v.err('question', 'BAD_KIND', 'ai_judged programs need a question');
    else if (typeof p.question !== 'string' || [...p.question].length < QUESTION_MIN_CHARS || [...p.question].length > QUESTION_MAX_CHARS) {
      v.err('question', 'LIMIT', `question must be ${QUESTION_MIN_CHARS}..${QUESTION_MAX_CHARS} characters`);
    }
  }
  if (kind === 'rules' && p.entities.length === 0) v.err('entities', 'BAD_KIND', 'rules programs need at least one entity');
  if (kind === 'ai_judged') {
    if (p.legs.length > 0) v.err('legs', 'BAD_KIND', 'ai_judged programs have no legs');
  } else {
    if (p.legs.length === 0) v.err('legs', 'BAD_KIND', `${kind} programs need at least one leg`);
    else if (p.legs.length > MAX_LEGS) v.err('legs', 'LIMIT', `at most ${MAX_LEGS} legs`);
  }
  if (kind === 'market') {
    if (p.stake_each !== undefined) v.err('stake_each', 'BAD_KIND', 'market programs use stakes, not stake_each');
    if (p.stakes === undefined) v.err('stakes', 'BAD_STAKE', 'market programs need stakes');
    else if (!Array.isArray(p.stakes) || p.stakes.length !== p.participants.length) {
      v.err('stakes', 'BAD_STAKE', 'stakes must be aligned with participants');
    } else p.stakes.forEach((s, i) => validateStake(v, `stakes[${i}]`, s));
  } else {
    if (p.stakes !== undefined) v.err('stakes', 'BAD_KIND', 'stakes is only allowed on market programs');
    if (p.stake_each === undefined) v.err('stake_each', 'BAD_STAKE', 'stake_each is required (Stake each?)');
    else validateStake(v, 'stake_each', p.stake_each);
  }
}

function validateMarketLeg(v: V, leg: Leg, path: string): void {
  if (leg.valid_attempt !== undefined) v.err(`${path}.valid_attempt`, 'BAD_KIND', 'market legs have no valid_attempt');
  if (leg.success !== undefined) v.err(`${path}.success`, 'BAD_KIND', 'market legs have no success');
  if (leg.rule !== undefined) v.err(`${path}.rule`, 'BAD_KIND', 'market legs have no rule');
  if (leg.attempt_window_frames !== 0) v.err(`${path}.attempt_window_s`, 'BAD_KIND', 'market legs have no attempt window');
  if (leg.actor_bound !== false) v.err(`${path}.actor_bound`, 'ACTOR_BOUND_MISMATCH', 'market legs are never actor-bound');
  const m = leg.market;
  if (!m) {
    v.err(`${path}.market`, 'BAD_KIND', 'market legs need a market reference');
    return;
  }
  if (m.venue !== 'gemini') v.err(`${path}.market.venue`, 'BAD_KIND', 'venue must be gemini');
  if (typeof m.event_id !== 'string' || m.event_id === '') v.err(`${path}.market.event_id`, 'PARSE_ERROR', 'event_id must be a non-empty string');
  if (typeof m.contract_id !== 'string' || m.contract_id === '') v.err(`${path}.market.contract_id`, 'PARSE_ERROR', 'contract_id must be a non-empty string');
  if (m.side !== 'yes' && m.side !== 'no') v.err(`${path}.market.side`, 'PARSE_ERROR', 'side must be yes or no');
  if (!inRange(m.prob_bps, 0, 10000)) v.err(`${path}.market.prob_bps`, 'LIMIT', 'prob_bps must be 0..10000');
}

function validateRulesLeg(v: V, p: Program, leg: Leg, path: string, byName: Map<string, Entity>): void {
  if (leg.market !== undefined) v.err(`${path}.market`, 'BAD_KIND', 'market references are only allowed on market programs');
  if (!inRange(leg.attempt_window_frames, MIN_DURATION_FRAMES, MAX_DURATION_FRAMES)) {
    v.err(`${path}.attempt_window_s`, 'LIMIT', `attempt window must be ${MIN_DURATION_FRAMES}..${MAX_DURATION_FRAMES} frames`);
  }
  if (leg.success === undefined) v.err(`${path}.success`, 'BAD_KIND', 'rules legs need success');
  if (leg.rule === undefined) v.err(`${path}.rule`, 'BAD_KIND', 'rules legs need a rule');
  if (leg.valid_attempt !== undefined) validateExpr(v, leg.valid_attempt, `${path}.valid_attempt`, byName);
  if (leg.success !== undefined) validateExpr(v, leg.success, `${path}.success`, byName);

  const actorBound = isActorBound(leg, byName);
  if (leg.actor_bound !== actorBound) {
    v.err(
      `${path}.actor_bound`,
      'ACTOR_BOUND_MISMATCH',
      actorBound ? 'this leg references a person entity, so actor_bound must be true' : 'this leg references no person entity, so actor_bound must be false',
    );
  }
  const rule = leg.rule;
  if (!rule) return;
  const rpath = `${path}.rule`;
  switch (rule.kind) {
    case 'exists':
    case 'never':
      break;
    case 'count': {
      if (!CMP_SET.has(rule.cmp)) v.err(rpath, 'PARSE_ERROR', `unknown comparison ${JSON.stringify(rule.cmp)}`);
      if (!inRange(rule.k, 0, REPS_MAX)) v.err(rpath, 'BAD_RULE', `count k must be 0..${REPS_MAX}`);
      if (!inRange(rule.attempts, 0, ATTEMPTS_MAX)) v.err(rpath, 'BAD_RULE', `within attempts N must be 1..${ATTEMPTS_MAX}`);
      if (rule.attempts > 0 && leg.valid_attempt === undefined) {
        v.err(rpath, 'BAD_RULE', '"within attempts" needs a valid_attempt condition');
      }
      break;
    }
    case 'holds':
    case 'before': {
      const max = p.time_limit_s * FPS;
      if (!inRange(rule.frames, 1, max)) v.err(rpath, 'BAD_RULE', `${rule.kind} duration must be within the time limit (1..${max} frames)`);
      break;
    }
    default:
      v.err(rpath, 'PARSE_ERROR', 'unknown rule kind');
      return;
  }
  if (leg.valid_attempt !== undefined && !(rule.kind === 'count' && rule.attempts > 0)) {
    v.err(rpath, 'BAD_RULE', 'a leg with valid_attempt must use count(success) ... within attempts N');
  }

  if (actorBound) {
    const neg =
      rule.kind === 'never' ||
      (rule.kind === 'count' && (rule.cmp === '<' || rule.cmp === '<=' || rule.cmp === '==' || rule.cmp === '!=')) ||
      (rule.kind === 'count' && rule.cmp === '>=' && rule.k === 0);
    if (neg) {
      v.err(rpath, 'NEGATIVE_ACTOR_RULE', 'actor-bound legs must be stated positively: emit the positive leg and swap the outcome sides');
    } else if (rule.kind === 'count') {
      if (rule.attempts > ATTEMPTS_MAX_ACTOR_BOUND) {
        v.err(rpath, 'CHECKPOINT_LIMIT', `actor-bound legs allow at most ${ATTEMPTS_MAX_ACTOR_BOUND} attempts`);
      }
      const kp = kPrime(rule);
      if (kp !== null && kp > MAX_CHECKPOINTS) {
        v.err(rpath, 'CHECKPOINT_LIMIT', `actor-bound counts need at most ${MAX_CHECKPOINTS} successes`);
      }
    }
  }
  if (rule.kind === 'count' && rule.attempts > 0) {
    const kp = kPrime(rule);
    if (kp !== null && kp > rule.attempts) v.warn(rpath, 'UNWINNABLE', `needs ${kp} successes in ${rule.attempts} attempts`);
  }
}

function validateExpr(v: V, e: Expr, path: string, byName: Map<string, Entity>): void {
  const m = exprMetrics(e);
  if (m.bytes > MAX_EXPR_BYTES) v.err(path, 'LIMIT', `expression encodes to ${m.bytes} bytes (max ${MAX_EXPR_BYTES})`);
  if (m.nodes > MAX_EXPR_NODES) v.err(path, 'LIMIT', `expression has ${m.nodes} nodes (max ${MAX_EXPR_NODES})`);
  if (m.depth > MAX_EXPR_DEPTH) v.err(path, 'LIMIT', `expression depth ${m.depth} exceeds ${MAX_EXPR_DEPTH}`);
  forEachNode(e, (node) => {
    if (isLeaf(node)) {
      validateLeaf(v, node, path, byName);
      return;
    }
    if (node.op === 'then_within' || node.op === 'for_duration' || node.op === 'before') {
      if (!inRange(node.frames, MIN_DURATION_FRAMES, MAX_DURATION_FRAMES)) {
        v.err(path, 'LIMIT', `${node.op} duration must be ${MIN_DURATION_FRAMES}..${MAX_DURATION_FRAMES} frames`);
      }
    }
    if (node.op === 'for_duration' && isLeaf(node.arg) && EVENT_SET.has(node.arg.op)) {
      v.warn(path, 'PULSE_DURATION', `for_duration over the event "${node.arg.op}" is true for at most one frame`);
    }
  });
}

function validateLeaf(v: V, l: LeafExpr, path: string, byName: Map<string, Entity>): void {
  const a = byName.get(l.a.e);
  if (!a) v.err(path, 'UNKNOWN_ENTITY', `no entity named "${l.a.e}"`);
  if (l.a.sub !== undefined) v.err(path, 'BAD_SUBREGION', `"${l.a.e}.${l.a.sub}": sub-regions are only allowed as the second operand`);
  if (a) {
    if (a.kind === 'region') v.err(path, 'BAD_OPERAND', `${l.op}: the first operand must be a person or object, not region "${a.name}"`);
    else if ((l.op === 'standing' || l.op === 'rep_count') && a.kind === 'object') {
      v.err(path, 'BAD_OPERAND', `${l.op} needs a person, not object "${a.name}"`);
    }
  }
  if (hasBRef(l)) {
    const b = byName.get(l.b.e);
    if (!b) v.err(path, 'UNKNOWN_ENTITY', `no entity named "${l.b.e}"`);
    else {
      const sub = l.b.sub;
      if (sub !== undefined && b.kind !== 'object') {
        v.err(path, 'BAD_SUBREGION', `"${l.b.e}.${sub}": sub-regions are only defined on objects`);
      } else {
        const isLine = b.kind === 'region' && b.shape === 'line' && sub === undefined;
        const isZone = b.kind === 'region' && b.shape === 'zone';
        let ok: boolean;
        let need: string;
        switch (l.op) {
          case 'behind':
          case 'beyond':
          case 'crosses':
            ok = isLine;
            need = 'a line region';
            break;
          case 'enters':
          case 'leaves':
            ok = isZone || b.kind === 'object';
            need = 'a zone, an object or an object sub-region';
            break;
          case 'disappears_into':
            ok = isZone || (b.kind === 'object' && sub === 'opening');
            need = 'an .opening sub-region or a zone';
            break;
          case 'released_by':
            ok = (b.kind === 'person' || b.kind === 'person_any') && sub === undefined;
            need = 'a person';
            break;
          default:
            ok = !isLine;
            need = 'a non-line entity or sub-region';
        }
        if (!ok) v.err(path, 'BAD_OPERAND', `${l.op}: the second operand must be ${need}, not "${l.b.e}${sub ? '.' + sub : ''}"`);
      }
    }
  }
  switch (l.op) {
    case 'near':
      if (!inRange(l.dist, 0, NEAR_MAX)) v.err(path, 'LIMIT', `near distance must be 0..${NEAR_MAX}`);
      break;
    case 'at_rest':
      if (!inRange(l.frames, MIN_DURATION_FRAMES, MAX_DURATION_FRAMES)) v.err(path, 'LIMIT', `at_rest duration must be ${MIN_DURATION_FRAMES}..${MAX_DURATION_FRAMES} frames`);
      break;
    case 'speed':
      if (!CMP_SET.has(l.cmp)) v.err(path, 'PARSE_ERROR', `unknown comparison ${JSON.stringify(l.cmp)}`);
      if (!inRange(l.value, 0, SPEED_MAX)) v.err(path, 'LIMIT', `speed must be 0..${SPEED_MAX}`);
      break;
    case 'rep_count':
      if (!CMP_SET.has(l.cmp)) v.err(path, 'PARSE_ERROR', `unknown comparison ${JSON.stringify(l.cmp)}`);
      if (!inRange(l.value, 0, REPS_MAX)) v.err(path, 'LIMIT', `rep_count must be 0..${REPS_MAX}`);
      break;
    case 'direction':
      if (!DIR_SET.has(l.dir)) v.err(path, 'PARSE_ERROR', `unknown direction ${JSON.stringify(l.dir)}`);
      break;
    default:
      break;
  }
}

function validateOutcome(v: V, p: Program): void {
  const o = p.outcome;
  if ((o.if_true !== 0 && o.if_true !== 1) || (o.else !== 0 && o.else !== 1)) {
    v.err('outcome', 'BAD_OUTCOME', 'outcome sides must be 0 or 1');
  } else if (o.if_true === o.else) {
    v.err('outcome', 'BAD_OUTCOME', 'both outcome clauses name the same side');
  }
  if (o.condition.op === 'yes') {
    if (p.kind !== 'ai_judged') v.err('outcome', 'BAD_OUTCOME', '"wins iff yes" is only for ai_judged programs');
    return;
  }
  if (p.kind === 'ai_judged') {
    v.err('outcome', 'BAD_OUTCOME', 'ai_judged programs use "wins iff yes"');
    return;
  }
  const m = condMetrics(o.condition);
  if (m.nodes > MAX_COND_NODES) v.err('outcome', 'LIMIT', `condition has ${m.nodes} nodes (max ${MAX_COND_NODES})`);
  if (m.depth > MAX_EXPR_DEPTH) v.err('outcome', 'LIMIT', `condition depth ${m.depth} exceeds ${MAX_EXPR_DEPTH}`);
  const ids = new Set(p.legs.map((l) => l.id));
  for (const id of legIdsOf(o.condition)) {
    if (!ids.has(id)) v.err('outcome', 'BAD_OUTCOME', `outcome references missing leg ${id}`);
  }
}

function validateUsage(v: V, p: Program, opts: ValidateOptions): void {
  const used = new Set<string>();
  for (const leg of p.legs) {
    for (const e of [leg.valid_attempt, leg.success]) {
      if (!e) continue;
      forEachLeaf(e, (l) => {
        used.add(l.a.e);
        if (hasBRef(l)) used.add(l.b.e);
      });
    }
  }
  for (const e of p.entities) {
    if (used.has(e.name)) continue;
    if (e.kind === 'person') {
      if (opts.sideEntities && !opts.sideEntities.has(e.name)) {
        v.err(`entities.${e.name}`, 'UNUSED_PERSON', `person "${e.name}" is not used by any leg or side`);
      }
    } else if (e.kind === 'object' || e.kind === 'person_any') {
      v.warn(`entities.${e.name}`, 'UNUSED_ENTITY', `"${e.name}" is not used by any condition (it gets no track)`);
    }
  }
}
