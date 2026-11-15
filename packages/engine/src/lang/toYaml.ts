/**
 * Canonical YAML (§2.9). `parseYaml(toYaml(p), ctx)` reproduces `p`.
 *
 * - Key order: version, kind, participants, sides, entities, legs, question,
 *   outcome, stake_each, stakes, time_limit_s; legs: id, actor_bound,
 *   valid_attempt, success, rule, attempt_window_s, market.
 * - Persons as base58, integers without separators, durations `{frames/10}s`.
 * - Every non-atom operand of a combinator is parenthesized, so the text never
 *   depends on operator precedence.
 */
import { parse as parseYamlText } from 'yaml';
import type { Entity, Expr, LegExpr, Program, Ref, Rule, Side, YesCondition } from '../types.js';
import { framesToYamlDuration } from './duration.js';
import { forEachLeaf, hasBRef, isLeaf } from './walk.js';

const dur = framesToYamlDuration;

function refText(r: Ref): string {
  return r.sub ? `${r.e}.${r.sub}` : r.e;
}

/** Expression → canonical source text (fully parenthesized). */
export function exprToText(e: Expr): string {
  const operand = (x: Expr): string => (isLeaf(x) ? exprToText(x) : `(${exprToText(x)})`);
  switch (e.op) {
    case 'and':
    case 'or':
      return `${operand(e.args[0])} ${e.op} ${operand(e.args[1])}`;
    case 'not':
      return `not ${operand(e.arg)}`;
    case 'then_within':
      return `${operand(e.first)} then_within ${dur(e.frames)} ${operand(e.then)}`;
    case 'for_duration':
      return `${operand(e.arg)} for_duration ${dur(e.frames)}`;
    case 'before':
      return `${operand(e.arg)} before ${dur(e.frames)}`;
    case 'near':
      return `${refText(e.a)} near ${refText(e.b)} ${e.dist}`;
    case 'moving':
    case 'present':
    case 'intact':
    case 'standing':
      return `${refText(e.a)} ${e.op}`;
    case 'at_rest':
      return `${refText(e.a)} at_rest ${dur(e.frames)}`;
    case 'speed':
      return `${refText(e.a)} speed ${e.cmp} ${e.value}`;
    case 'direction':
      return `${refText(e.a)} direction ${e.dir}`;
    case 'rep_count':
      return `rep_count(${refText(e.a)}) ${e.cmp} ${e.value}`;
    default:
      return `${refText(e.a)} ${e.op} ${refText(e.b)}`;
  }
}

export function ruleToText(r: Rule): string {
  switch (r.kind) {
    case 'exists':
      return 'success';
    case 'never':
      return 'never(success)';
    case 'count':
      return `count(success) ${r.cmp} ${r.k}${r.attempts > 0 ? ` within attempts ${r.attempts}` : ''}`;
    case 'holds':
      return `holds(success) for ${dur(r.frames)}`;
    case 'before':
      return `success before ${dur(r.frames)}`;
  }
}

export function condToText(c: LegExpr | YesCondition): string {
  const operand = (x: LegExpr): string => (x.op === 'leg' ? condToText(x) : `(${condToText(x)})`);
  switch (c.op) {
    case 'yes':
      return 'yes';
    case 'leg':
      return `leg ${c.id}`;
    case 'not':
      return `not ${operand(c.arg)}`;
    default:
      return `${operand(c.args[0])} ${c.op} ${operand(c.args[1])}`;
  }
}

/**
 * Side reference text. A person entity referenced by no leg can only have come from a
 * `side(<entity>)` reference; naming it again keeps `parseYaml(toYaml(p))` free of
 * `UNUSED_PERSON`.
 */
function sideRefText(p: Program, side: Side, taken: Set<string>): string {
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
  const sideOnly = p.entities.find(
    (e): e is Extract<Entity, { kind: 'person' }> =>
      e.kind === 'person' && !used.has(e.name) && !taken.has(e.name) && p.sides[e.participant] === side,
  );
  if (sideOnly) {
    taken.add(sideOnly.name);
    return `side(${sideOnly.name})`;
  }
  return side === 0 ? 'side(A)' : 'side(B)';
}

function entityText(p: Program, e: Entity): string {
  switch (e.kind) {
    case 'person':
      return `person(${p.participants[e.participant] ?? `p${e.participant}`})`;
    case 'person_any':
      return 'person(any)';
    case 'object':
      return `object("${e.phrase}")`;
    case 'region':
      return `region(${e.shape})`;
  }
}

/** A YAML scalar: plain if it round-trips as the same string, else double-quoted (JSON). */
function scalar(s: string): string {
  const plainSafe =
    s.length > 0 &&
    s === s.trim() &&
    !/[\n\r\t]/.test(s) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !s.includes(': ') &&
    !s.includes(' #') &&
    !s.endsWith(':');
  if (plainSafe) {
    try {
      if (parseYamlText(`k: ${s}`, { schema: 'failsafe' })?.k === s) return s;
    } catch {
      /* fall through to quoting */
    }
  }
  return JSON.stringify(s);
}

export function toYaml(p: Program): string {
  const out: string[] = [];
  out.push('version: 2');
  out.push(`kind: ${p.kind}`);
  out.push('participants:');
  for (const w of p.participants) out.push(`  - ${scalar(w)}`);
  out.push(`sides: [${p.sides.join(', ')}]`);
  if (p.entities.length > 0) {
    out.push('entities:');
    for (const e of p.entities) out.push(`  ${e.name}: ${scalar(entityText(p, e))}`);
  }
  if (p.legs.length > 0) {
    out.push('legs:');
    for (const leg of p.legs) {
      out.push(`  - id: ${leg.id}`);
      out.push(`    actor_bound: ${leg.actor_bound ? 'true' : 'false'}`);
      if (leg.valid_attempt) out.push(`    valid_attempt: ${scalar(exprToText(leg.valid_attempt))}`);
      if (leg.success) out.push(`    success: ${scalar(exprToText(leg.success))}`);
      if (leg.rule) out.push(`    rule: ${scalar(ruleToText(leg.rule))}`);
      if (p.kind !== 'market' || leg.attempt_window_frames !== 0) {
        out.push(`    attempt_window_s: ${dur(leg.attempt_window_frames)}`);
      }
      if (leg.market) {
        const m = leg.market;
        out.push('    market:');
        out.push(`      event_id: ${scalar(m.event_id)}`);
        out.push(`      contract_id: ${scalar(m.contract_id)}`);
        out.push(`      side: ${m.side}`);
        out.push(`      prob_bps: ${m.prob_bps}`);
        out.push(`      venue: ${m.venue}`);
      }
    }
  }
  if (p.question !== undefined) out.push(`question: ${scalar(p.question)}`);
  const taken = new Set<string>();
  const ifTrue = sideRefText(p, p.outcome.if_true, taken);
  const elseRef = sideRefText(p, p.outcome.else, taken);
  out.push(`outcome: ${scalar(`${ifTrue} wins iff ${condToText(p.outcome.condition)}; else ${elseRef}`)}`);
  if (p.stake_each !== undefined) out.push(`stake_each: ${p.stake_each}`);
  if (p.stakes !== undefined) out.push(`stakes: [${p.stakes.join(', ')}]`);
  out.push(`time_limit_s: ${p.time_limit_s}`);
  return out.join('\n') + '\n';
}
