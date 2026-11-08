/**
 * Canonicalization (§2.7): `ProgramDraft | Program` → canonical `Program`.
 *
 * Idempotent: a canonical `Program` canonicalizes to a structurally equal copy,
 * and needs no compile context. The context is only required to resolve
 * `person(...)` forms and the `participants` default.
 */
import {
  ATTEMPT_WINDOW_DEFAULT,
  DEFAULT_TIME_LIMIT_S,
  LINE_ONLY_OPS,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
} from '../constants.js';
import type {
  CompileContext,
  CompileError,
  DraftEntity,
  DraftLeg,
  Entity,
  Expr,
  Leg,
  LegExpr,
  MarketRef,
  Program,
  ProgramDraft,
  Pubkey,
  Side,
  SideRefInput,
  YesCondition,
} from '../types.js';
import { compileError, LangError } from './errors.js';
import { normalizePhrase } from './entities.js';
import { cloneExpr, cloneLeaf, cloneLegExpr, forEachLeaf, hasBRef, mapLeaves } from './walk.js';

const LINE_ONLY: ReadonlySet<string> = new Set<string>(LINE_ONLY_OPS);
const BASE58_KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface CanonicalizeResult {
  program: Program | null;
  errors: CompileError[];
  /** Names of `person` entities named by a `side(<entity>)` outcome reference. */
  sideEntities: Set<string>;
}

/** Resolve a `person(...)` member reference to a huddle wallet. */
function resolveMember(
  member: string,
  ctx: CompileContext | undefined,
  path: string,
  errors: CompileError[],
): Pubkey | null {
  if (!ctx) {
    errors.push(compileError(path, 'UNKNOWN_PARTICIPANT', `cannot resolve person(${member}) without a compile context`));
    return null;
  }
  const pm = /^p([0-9])$/.exec(member);
  if (pm) {
    const m = ctx.huddle[Number(pm[1])];
    if (!m) {
      errors.push(compileError(path, 'UNKNOWN_PARTICIPANT', `person(${member}): the huddle has no member ${pm[1]}`));
      return null;
    }
    return m.wallet;
  }
  if (BASE58_KEY_RE.test(member)) {
    const m = ctx.huddle.find((h) => h.wallet === member);
    if (!m) {
      errors.push(compileError(path, 'UNKNOWN_PARTICIPANT', `person(${member}) is not a confirmed huddle member`));
      return null;
    }
    return m.wallet;
  }
  const lower = member.toLowerCase();
  const matches = ctx.huddle.filter((h) => h.display_name.toLowerCase() === lower);
  if (matches.length !== 1) {
    errors.push(
      compileError(
        path,
        'UNKNOWN_PARTICIPANT',
        matches.length === 0
          ? `person("${member}") matches no confirmed huddle member`
          : `person("${member}") matches ${matches.length} huddle members`,
      ),
    );
    return null;
  }
  return matches[0]!.wallet;
}

function defaultParticipants(
  personWallets: Pubkey[],
  ctx: CompileContext | undefined,
  errors: CompileError[],
): Pubkey[] | null {
  if (!ctx) {
    errors.push(compileError('participants', 'PARTICIPANTS_UNRESOLVED', 'participants omitted and no compile context given'));
    return null;
  }
  const bound = new Set(personWallets);
  const out: Pubkey[] = [ctx.creator];
  for (const h of ctx.huddle) {
    if (bound.has(h.wallet) && !out.includes(h.wallet)) out.push(h.wallet);
  }
  if (out.length < 2 && ctx.huddle.length === 2) {
    const members = ctx.huddle.map((h) => h.wallet);
    return [ctx.creator, ...members.filter((w) => w !== ctx.creator)].slice(0, 2);
  }
  if (out.length < 2) {
    errors.push(compileError('participants', 'PARTICIPANTS_UNRESOLVED', "can't tell who's in: name the other participants"));
    return null;
  }
  return out;
}

/** Entity names used as the `b` operand of behind/beyond/crosses anywhere in the program. */
function lineUses(legs: DraftLeg[]): Set<string> {
  const out = new Set<string>();
  const scan = (e: Expr | undefined): void => {
    if (!e) return;
    forEachLeaf(e, (l) => {
      if (LINE_ONLY.has(l.op) && hasBRef(l)) out.add(l.b.e);
    });
  };
  for (const l of legs) {
    scan(l.valid_attempt);
    scan(l.success);
  }
  return out;
}

/**
 * Canonicalize, collecting errors instead of throwing. Used by `parseYaml`.
 */
export function canonicalizeDraft(p: ProgramDraft | Program, ctx?: CompileContext): CanonicalizeResult {
  const errors: CompileError[] = [];
  const sideEntities = new Set<string>();
  const kind = p.kind ?? 'rules';
  const draftEntities = p.entities as DraftEntity[];
  const draftLegs = p.legs as DraftLeg[];

  // 1. persons → wallets
  const personWallet = new Map<string, Pubkey>();
  const unresolvedIdx: { name: string; idx: number }[] = [];
  draftEntities.forEach((e) => {
    if (e.kind !== 'person') return;
    if ('member' in e) {
      const w = resolveMember(e.member, ctx, `entities.${e.name}`, errors);
      if (w) personWallet.set(e.name, w);
    } else {
      unresolvedIdx.push({ name: e.name, idx: e.participant });
    }
  });

  // participants
  let participants: Pubkey[] | null;
  if (p.participants !== undefined) participants = [...p.participants];
  else if (errors.length > 0) return { program: null, errors, sideEntities }; // avoid a cascading default error
  else participants = defaultParticipants([...personWallet.values()], ctx, errors);
  if (!participants) return { program: null, errors, sideEntities };
  if (participants.length < MIN_PARTICIPANTS || participants.length > MAX_PARTICIPANTS) {
    errors.push(compileError('participants', 'LIMIT', `a bet needs ${MIN_PARTICIPANTS}..${MAX_PARTICIPANTS} participants, got ${participants.length}`));
    return { program: null, errors, sideEntities };
  }

  // persons already given as participant indices (canonical input)
  for (const { name, idx } of unresolvedIdx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= participants.length) {
      errors.push(compileError(`entities.${name}`, 'UNKNOWN_PARTICIPANT', `participant index ${idx} is out of range`));
    } else {
      personWallet.set(name, participants[idx]!);
    }
  }

  // 2. region(tap) resolution
  const usedAsLine = lineUses(draftLegs);

  // entities (3. phrase normalization)
  const entities: Entity[] = [];
  for (const e of draftEntities) {
    switch (e.kind) {
      case 'person': {
        const w = personWallet.get(e.name);
        if (w === undefined) continue; // error already recorded
        const idx = participants.indexOf(w);
        if (idx < 0) {
          errors.push(compileError(`entities.${e.name}`, 'UNKNOWN_PARTICIPANT', `person entity "${e.name}" is not one of the participants`));
          continue;
        }
        entities.push({ name: e.name, kind: 'person', participant: idx });
        break;
      }
      case 'person_any':
        entities.push({ name: e.name, kind: 'person_any' });
        break;
      case 'object':
        entities.push({ name: e.name, kind: 'object', phrase: normalizePhrase(e.phrase) });
        break;
      case 'region': {
        const shape = e.shape === 'tap' ? (usedAsLine.has(e.name) ? 'line' : 'zone') : e.shape;
        entities.push({ name: e.name, kind: 'region', shape });
        break;
      }
    }
  }
  const byName = new Map<string, Entity>();
  for (const e of entities) byName.set(e.name, e);

  // sides
  let sides: Side[] | null = null;
  if (p.sides === undefined) {
    if (participants.length === 2) sides = [0, 1];
    else errors.push(compileError('sides', 'BAD_SIDES', `sides must be stated explicitly with ${participants.length} participants`));
  } else if (Array.isArray(p.sides)) {
    sides = [...p.sides];
  } else {
    sides = resolveSideMap(p.sides, participants, byName, draftEntities, errors);
  }

  // legs (4./5.)
  const legs: Leg[] = draftLegs.map((l) => canonicalLeg(l, kind, byName));

  // outcome
  let ifTrue: Side | null = null;
  let elseSide: Side | null = null;
  if (sides) {
    const r = resolveOutcomeSides(p.outcome.if_true, p.outcome.else, sides, byName, draftEntities, errors, sideEntities);
    if (r) [ifTrue, elseSide] = r;
  }
  const condition: LegExpr | YesCondition =
    p.outcome.condition.op === 'yes' ? { op: 'yes' } : cloneLegExpr(p.outcome.condition);

  let time_limit_s = p.time_limit_s;
  if (time_limit_s === undefined) {
    if (kind === 'market') errors.push(compileError('time_limit_s', 'BAD_TIME_LIMIT', 'market programs must state time_limit_s'));
    else time_limit_s = DEFAULT_TIME_LIMIT_S;
  }

  if (errors.length > 0 || !sides || ifTrue === null || elseSide === null || time_limit_s === undefined) {
    return { program: null, errors, sideEntities };
  }

  const program: Program = {
    version: 2,
    kind,
    participants,
    sides,
    entities,
    legs,
    outcome: { if_true: ifTrue, condition, else: elseSide },
    time_limit_s,
  };
  if (p.question !== undefined) program.question = p.question;
  if (p.stake_each !== undefined) program.stake_each = p.stake_each;
  if (p.stakes !== undefined) program.stakes = [...p.stakes];
  // Re-order keys canonically (cosmetic; canonical JSON sorts keys anyway).
  return { program: orderProgramKeys(program), errors, sideEntities };
}

function orderProgramKeys(p: Program): Program {
  const out: Record<string, unknown> = {};
  out.version = p.version;
  out.kind = p.kind;
  out.participants = p.participants;
  out.sides = p.sides;
  out.entities = p.entities;
  out.legs = p.legs;
  if (p.question !== undefined) out.question = p.question;
  out.outcome = p.outcome;
  if (p.stake_each !== undefined) out.stake_each = p.stake_each;
  if (p.stakes !== undefined) out.stakes = p.stakes;
  out.time_limit_s = p.time_limit_s;
  return out as unknown as Program;
}

function canonicalLeg(l: DraftLeg, kind: Program['kind'], byName: Map<string, Entity>): Leg {
  const rewrite = (e: Expr): Expr =>
    mapLeaves(e, (leaf) => {
      const c = cloneLeaf(leaf);
      // 5. disappears_into(a, <object>) → disappears_into(a, <object>.opening)
      if (c.op === 'disappears_into' && c.b.sub === undefined && byName.get(c.b.e)?.kind === 'object') {
        return { op: 'disappears_into', a: c.a, b: { e: c.b.e, sub: 'opening' } };
      }
      return c;
    });
  const leg: Leg = {
    id: l.id,
    actor_bound: l.actor_bound,
    attempt_window_frames: l.attempt_window_frames ?? (kind === 'market' ? 0 : ATTEMPT_WINDOW_DEFAULT),
  };
  if (l.valid_attempt !== undefined) leg.valid_attempt = rewrite(cloneExpr(l.valid_attempt));
  if (l.success !== undefined) leg.success = rewrite(cloneExpr(l.success));
  if (l.rule !== undefined) {
    const r = l.rule;
    switch (r.kind) {
      case 'exists':
      case 'never':
        leg.rule = { kind: r.kind };
        break;
      case 'count':
        leg.rule = { kind: 'count', cmp: r.cmp, k: r.k, attempts: r.attempts };
        break;
      case 'holds':
      case 'before':
        leg.rule = { kind: r.kind, frames: r.frames };
        break;
    }
  }
  if (l.market !== undefined) {
    const m: MarketRef = {
      venue: l.market.venue ?? 'gemini',
      event_id: l.market.event_id,
      contract_id: l.market.contract_id,
      side: l.market.side,
      prob_bps: l.market.prob_bps,
    };
    leg.market = m;
  }
  return leg;
}

function resolveSideMap(
  map: { A: string[]; B: string[] },
  participants: Pubkey[],
  byName: Map<string, Entity>,
  draftEntities: DraftEntity[],
  errors: CompileError[],
): Side[] | null {
  const sides: (Side | undefined)[] = participants.map(() => undefined);
  let ok = true;
  for (const [key, side] of [['A', 0], ['B', 1]] as const) {
    for (const item of map[key]) {
      let idx = -1;
      const ent = byName.get(item);
      if (ent) {
        if (ent.kind !== 'person') {
          errors.push(compileError(`sides.${key}`, 'BAD_SIDES', `"${item}" is not a person entity`));
          ok = false;
          continue;
        }
        idx = ent.participant;
      } else if (draftEntities.some((e) => e.name === item)) {
        ok = false; // person entity that failed to resolve; already reported
        continue;
      } else {
        idx = participants.indexOf(item);
        if (idx < 0) {
          errors.push(compileError(`sides.${key}`, 'UNKNOWN_PARTICIPANT', `"${item}" is neither a person entity nor a participant`));
          ok = false;
          continue;
        }
      }
      if (sides[idx] !== undefined) {
        errors.push(compileError(`sides.${key}`, 'BAD_SIDES', `participant ${idx} is listed more than once`));
        ok = false;
        continue;
      }
      sides[idx] = side;
    }
  }
  if (!ok) return null;
  const missing = sides.findIndex((s) => s === undefined);
  if (missing >= 0) {
    errors.push(compileError('sides', 'BAD_SIDES', `participant ${missing} is on neither side`));
    return null;
  }
  return sides as Side[];
}

function resolveOutcomeSides(
  a: SideRefInput,
  b: SideRefInput,
  sides: Side[],
  byName: Map<string, Entity>,
  draftEntities: DraftEntity[],
  errors: CompileError[],
  sideEntities: Set<string>,
): [Side, Side] | null {
  const isOther = (r: SideRefInput): boolean => typeof r === 'object' && 'side' in r && r.side === 'other';
  const one = (r: SideRefInput): Side | null | 'other' => {
    if (typeof r === 'number') return r;
    if ('side' in r) {
      switch (r.side) {
        case 'creator':
          return sides[0]!;
        case 'A':
          return 0;
        case 'B':
          return 1;
        default:
          return 'other';
      }
    }
    const ent = byName.get(r.entity);
    if (!ent) {
      if (!draftEntities.some((e) => e.name === r.entity)) {
        errors.push(compileError('outcome', 'UNKNOWN_ENTITY', `side(${r.entity}): no entity named "${r.entity}"`));
      }
      return null;
    }
    if (ent.kind !== 'person') {
      errors.push(compileError('outcome', 'BAD_OUTCOME', `side(${r.entity}): "${r.entity}" is not a person entity`));
      return null;
    }
    sideEntities.add(ent.name);
    const s = sides[ent.participant];
    return s === undefined ? null : s;
  };
  if (isOther(a) && isOther(b)) {
    errors.push(compileError('outcome', 'BAD_OUTCOME', 'at most one side reference may be side(other)'));
    return null;
  }
  const ra = one(a);
  const rb = one(b);
  if (ra === null || rb === null) return null;
  const sa: Side = ra === 'other' ? ((1 - (rb as Side)) as Side) : ra;
  const sb: Side = rb === 'other' ? ((1 - sa) as Side) : rb;
  // `if_true == else` is reported by validation (BAD_OUTCOME).
  return [sa, sb];
}

/**
 * `canonicalize(p, ctx)` (§2.7, §14). Throws `LangError` if the draft cannot be
 * resolved (unknown members, unresolved participants, bad sides, ...).
 * Validation is separate (`validateProgram`).
 */
export function canonicalize(p: ProgramDraft | Program, ctx?: CompileContext): Program {
  const r = canonicalizeDraft(p, ctx);
  if (!r.program) throw new LangError(r.errors);
  return r.program;
}

