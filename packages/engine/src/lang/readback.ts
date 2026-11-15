/**
 * Read-back (§2.8): deterministic English lines for a canonical program.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { CMP_WORDS, FPS } from '../constants.js';
import type { Entity, Expr, LegExpr, Program, Pubkey, ReadbackContext, Ref, Side, YesCondition } from '../types.js';
import { framesToReadback } from './duration.js';

/** Money (§12.9): `$` + floor(units / 10_000) / 100, two decimals, thousands separators. */
export function formatUsd(units: number | bigint): string {
  const u = typeof units === 'bigint' ? units : BigInt(units);
  const neg = u < 0n;
  const cents = (neg ? -u : u) / 10_000n;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const c = (cents % 100n).toString().padStart(2, '0');
  return `${neg ? '−' : ''}$${dollars}.${c}`;
}

/** `market_hash = sha256(utf8("gemini:" + event_id + ":" + contract_id))` as hex (§4.2). */
export function marketHashHex(eventId: string, contractId: string): string {
  const d = sha256(new TextEncoder().encode(`gemini:${eventId}:${contractId}`));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** English list: "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const BINARY = new Set(['and', 'or', 'then_within']);

class Renderer {
  private readonly byName: Map<string, Entity>;
  constructor(
    private readonly p: Program,
    private readonly ctx: ReadbackContext,
  ) {
    this.byName = new Map(p.entities.map((e) => [e.name, e] as const));
  }

  participantName(idx: number): string {
    const w: Pubkey | undefined = this.p.participants[idx];
    if (w === undefined) return `participant ${idx}`;
    return this.ctx.names[w] ?? w;
  }

  entity(name: string): string {
    const e = this.byName.get(name);
    if (!e) return name;
    switch (e.kind) {
      case 'person':
        return this.participantName(e.participant);
      case 'person_any':
        return this.ctx.labels?.[name] ?? 'someone';
      case 'object': {
        const l = this.ctx.labels?.[name];
        return l !== undefined ? l.toLowerCase() : e.phrase;
      }
      case 'region':
        return e.shape === 'line' ? 'the line' : 'the zone';
    }
  }

  ref(r: Ref): string {
    const base = this.entity(r.e);
    if (r.sub === 'opening') return `the opening of ${base}`;
    if (r.sub === 'interior') return `the inside of ${base}`;
    return base;
  }

  private child(c: Expr, parentOp: string | null): string {
    const s = this.expr(c);
    return BINARY.has(c.op) && c.op !== parentOp ? `(${s})` : s;
  }

  expr(e: Expr): string {
    const d = (f: number): string => framesToReadback(f);
    switch (e.op) {
      case 'and':
      case 'or':
        return `${this.child(e.args[0], e.op)} ${e.op} ${this.child(e.args[1], e.op)}`;
      case 'then_within':
        return `${this.child(e.first, e.op)}, then within ${d(e.frames)}, ${this.child(e.then, e.op)}`;
      case 'not':
        return `not: ${this.child(e.arg, null)}`;
      case 'for_duration':
        return `${this.child(e.arg, null)} for ${d(e.frames)}`;
      case 'before':
        return `${this.child(e.arg, null)} before ${d(e.frames)}`;
      case 'overlaps':
        return `${this.ref(e.a)} overlaps ${this.ref(e.b)}`;
      case 'inside':
        return `${this.ref(e.a)} is inside ${this.ref(e.b)}`;
      case 'above':
        return `${this.ref(e.a)} is above ${this.ref(e.b)}`;
      case 'below':
        return `${this.ref(e.a)} is below ${this.ref(e.b)}`;
      case 'behind':
        return `${this.ref(e.a)} is behind ${this.ref(e.b)}`;
      case 'beyond':
        return `${this.ref(e.a)} is past ${this.ref(e.b)}`;
      case 'near':
        return `${this.ref(e.a)} is near ${this.ref(e.b)}`;
      case 'moving':
        return `${this.ref(e.a)} is moving`;
      case 'present':
        return `${this.ref(e.a)} is visible`;
      case 'intact':
        return `${this.ref(e.a)} stays standing`;
      case 'standing':
        return `${this.ref(e.a)} is standing`;
      case 'at_rest':
        return `${this.ref(e.a)} stays still for ${d(e.frames)}`;
      case 'speed':
        return `${this.ref(e.a)} moves ${CMP_WORDS[e.cmp]} ${e.value}`;
      case 'direction':
        return `${this.ref(e.a)} moves ${e.dir}`;
      case 'rep_count':
        return `${this.ref(e.a)} does ${CMP_WORDS[e.cmp]} ${e.value} reps`;
      case 'enters':
        return `${this.ref(e.a)} enters ${this.ref(e.b)}`;
      case 'leaves':
        return `${this.ref(e.a)} leaves ${this.ref(e.b)}`;
      case 'disappears_into':
        return `${this.ref(e.a)} goes into ${this.ref(e.b)}`;
      case 'touches':
        return `${this.ref(e.a)} touches ${this.ref(e.b)}`;
      case 'crosses':
        return `${this.ref(e.a)} crosses ${this.ref(e.b)}`;
      case 'released_by':
        return `${this.ref(e.b)} releases ${this.ref(e.a)}`;
    }
  }

  cond(c: LegExpr | YesCondition): string {
    switch (c.op) {
      case 'yes':
        return 'yes';
      case 'leg':
        return `leg ${c.id}`;
      case 'not':
        return c.arg.op === 'leg' || c.arg.op === 'not' ? `not ${this.cond(c.arg)}` : `not (${this.cond(c.arg)})`;
      default: {
        const wrap = (x: LegExpr): string => (x.op !== 'leg' && x.op !== 'not' && x.op !== c.op ? `(${this.cond(x)})` : this.cond(x));
        return `${wrap(c.args[0])} ${c.op} ${wrap(c.args[1])}`;
      }
    }
  }

  sideNames(side: Side): string {
    const names: string[] = [];
    this.p.sides.forEach((s, i) => {
      if (s === side) names.push(this.participantName(i));
    });
    return joinNames(names);
  }
}

export function readback(p: Program, ctx: ReadbackContext): string[] {
  const r = new Renderer(p, ctx);
  const lines: string[] = [];
  const d = framesToReadback;
  if (p.kind === 'ai_judged' && p.question !== undefined) lines.push(`Question: ${p.question}`);
  for (const leg of p.legs) {
    if (leg.market) {
      const m = leg.market;
      const label = ctx.markets?.[marketHashHex(m.event_id, m.contract_id)] ?? `${m.event_id}/${m.contract_id}`;
      lines.push(`${label} resolves ${m.side}`);
      continue;
    }
    if (!leg.rule || !leg.success) continue;
    const success = r.expr(leg.success);
    const rule = leg.rule;
    switch (rule.kind) {
      case 'exists':
        lines.push(success);
        break;
      case 'never':
        lines.push(`Never: ${success}`);
        break;
      case 'count':
        if (rule.attempts > 0) {
          if (leg.valid_attempt) lines.push(`Counts if: ${r.expr(leg.valid_attempt)}`);
          lines.push(`Wins an attempt if: ${success}`);
          lines.push(`Needs ${CMP_WORDS[rule.cmp]} ${rule.k} of ${rule.attempts} attempts`);
        } else {
          lines.push(`${success}, ${CMP_WORDS[rule.cmp]} ${rule.k} times`);
        }
        break;
      case 'holds':
        lines.push(`${success} for ${d(rule.frames)} straight`);
        break;
      case 'before':
        lines.push(`${success} within ${d(rule.frames)}`);
        break;
    }
  }
  const o = p.outcome;
  lines.push(`${r.sideNames(o.if_true)} win if ${r.cond(o.condition)}; otherwise ${r.sideNames(o.else)} win`);
  if (p.kind === 'market') {
    lines.push(`Stakes ${(p.stakes ?? []).map((s) => formatUsd(s)).join(' / ')}`);
  } else if (p.stake_each !== undefined) {
    lines.push(`${formatUsd(p.stake_each)} each`);
  }
  lines.push(`Time limit ${d(p.time_limit_s * FPS)}`);
  return lines;
}
