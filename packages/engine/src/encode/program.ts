/**
 * `program_bin` (magic "VRDP", §5.1): encoder, validating decoder, program_hash.
 *
 * The encoding is canonical: `encodeProgram` emits the unique valid form of a
 * canonical Program and self-checks it with `decodeProgram`, which rejects every
 * non-canonical or invalid byte string with `EngineError("MalformedProgram")`.
 */
import {
  ATTEMPTS_MAX,
  ATTEMPTS_MAX_ACTOR_BOUND,
  CMP_CODE,
  ENTITY_KIND_CODE,
  FPS,
  KIND_CODE,
  LEG_FLAG_ACTOR_BOUND,
  LEG_FLAG_HAS_VALID_ATTEMPT,
  LEG_FLAG_RESERVED_MASK,
  MARKET_EXPECTED,
  MARKET_HASH_BYTES,
  MARKET_TIME_LIMIT_MAX_S,
  MAX_DURATION_FRAMES,
  MAX_ENTITIES,
  MAX_EXPR_BYTES,
  MAX_LEGS,
  MAX_PARTICIPANTS,
  MAX_STAKE_UNITS,
  MIN_DURATION_FRAMES,
  MIN_LEG_ID,
  MIN_PARTICIPANTS,
  MIN_STAKE_UNITS,
  MIN_TIME_LIMIT_S,
  PROGRAM_FORMAT_VERSION,
  PROGRAM_MAGIC,
  REPS_MAX,
  RULE_KIND_CODE,
  TIME_LIMIT_MAX_S,
} from '../constants.js';
import { bytesToHex, bytesToPubkey, pubkeyToBytes } from '../hash/bytes.js';
import { CanonicalJsonError } from '../hash/canonicalJson.js';
import { jsonHashBytes, marketHashBytes } from '../hash/hashes.js';
import { sha256 } from '../hash/sha256.js';
import type {
  CmpCode,
  DecodedEntity,
  DecodedLeg,
  DecodedProgram,
  EntityKindCode,
  Hex32,
  KindCode,
  Leg,
  Program,
  RuleKindCode,
  Side,
} from '../types.js';
import { EngineError, check } from './errors.js';
import { type DecodedCondInfo, type DecodedExprInfo, decodeCond, decodeExpr, encodeCond, encodeExpr } from './expr.js';
import { ByteReader, ByteWriter } from './io.js';

const MP = 'MalformedProgram' as const;

function fail(detail: string): never {
  throw new EngineError(MP, detail);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function entityCode(e: Program['entities'][number]): [number, number] {
  switch (e.kind) {
    case 'person':
      return [ENTITY_KIND_CODE.person, e.participant];
    case 'person_any':
      return [ENTITY_KIND_CODE.person_any, 0];
    case 'object':
      return [ENTITY_KIND_CODE.object, 0];
    case 'region':
      if (e.shape === 'line') return [ENTITY_KIND_CODE.line, 0];
      if (e.shape === 'zone') return [ENTITY_KIND_CODE.zone, 0];
      return fail(`entity ${e.name}: unresolved region shape ${String(e.shape)}`);
    default:
      return fail(`unknown entity kind ${String((e as { kind: unknown }).kind)}`);
  }
}

function writeRulesLeg(w: ByteWriter, leg: Leg, ix: ReadonlyMap<string, number>): void {
  if (leg.market !== undefined) fail(`leg ${leg.id}: market ref on a rules leg`);
  if (leg.rule === undefined || leg.success === undefined) fail(`leg ${leg.id}: rules legs need rule and success`);
  const va = leg.valid_attempt === undefined ? new Uint8Array(0) : encodeExpr(leg.valid_attempt, ix);
  const succ = encodeExpr(leg.success, ix);
  let flags = 0;
  if (leg.actor_bound) flags |= LEG_FLAG_ACTOR_BOUND;
  if (leg.valid_attempt !== undefined) flags |= LEG_FLAG_HAS_VALID_ATTEMPT;
  let kind = 0;
  let cmp = 0;
  let k = 0;
  let n = 0;
  const rule = leg.rule;
  switch (rule.kind) {
    case 'exists':
      kind = RULE_KIND_CODE.exists;
      break;
    case 'never':
      kind = RULE_KIND_CODE.never;
      break;
    case 'count': {
      kind = RULE_KIND_CODE.count;
      const c = (CMP_CODE as Record<string, number>)[rule.cmp];
      if (c === undefined) fail(`leg ${leg.id}: unknown comparison ${String(rule.cmp)}`);
      cmp = c;
      k = rule.k;
      n = rule.attempts;
      break;
    }
    case 'holds':
      kind = RULE_KIND_CODE.holds;
      n = rule.frames;
      break;
    case 'before':
      kind = RULE_KIND_CODE.before;
      n = rule.frames;
      break;
    default:
      fail(`leg ${leg.id}: unknown rule kind ${String((rule as { kind: unknown }).kind)}`);
  }
  w.u8(leg.id).u8(flags).u8(kind).u8(cmp).u16(k).u32(n).u16(leg.attempt_window_frames);
  w.u16(va.length).bytes(va);
  w.u16(succ.length).bytes(succ);
}

function writeMarketLeg(w: ByteWriter, leg: Leg): void {
  const m = leg.market;
  if (m === undefined) fail(`leg ${leg.id}: market programs need a market ref on every leg`);
  if (leg.rule !== undefined || leg.success !== undefined || leg.valid_attempt !== undefined) {
    fail(`leg ${leg.id}: market legs carry no rule/success/valid_attempt`);
  }
  if (m.side !== 'yes' && m.side !== 'no') fail(`leg ${leg.id}: market side must be yes|no`);
  const flags = leg.actor_bound ? LEG_FLAG_ACTOR_BOUND : 0;
  w.u8(leg.id).u8(flags).u8(RULE_KIND_CODE.market).u8(0).u16(MARKET_EXPECTED[m.side]).u32(0);
  w.u16(leg.attempt_window_frames);
  w.u16(0);
  w.u16(MARKET_HASH_BYTES).bytes(marketHashBytes(m.event_id, m.contract_id));
}

/**
 * Encode a canonical Program (§2.6) as `program_bin` (§5.1). Throws
 * `EngineError("MalformedProgram")` if the program cannot be encoded or the
 * result would not decode (limits, operand kinds, ranges, …).
 */
export function encodeProgram(p: Program): Uint8Array {
  let bin: Uint8Array;
  try {
    bin = encodeUnchecked(p);
  } catch (e) {
    if (e instanceof EngineError) throw e;
    if (e instanceof RangeError || e instanceof TypeError || e instanceof CanonicalJsonError) {
      throw new EngineError(MP, e.message);
    }
    throw e;
  }
  decodeProgram(bin);
  return bin;
}

function encodeUnchecked(p: Program): Uint8Array {
  const kind = (KIND_CODE as Record<string, number>)[p.kind];
  if (kind === undefined) fail(`unknown program kind ${String(p.kind)}`);
  const P = p.participants.length;
  if (p.sides.length !== P) fail('sides must align with participants');
  const w = new ByteWriter(512);
  w.bytes(PROGRAM_MAGIC).u8(PROGRAM_FORMAT_VERSION).u8(kind).u8(FPS).u8(P);
  w.bytes(jsonHashBytes(p));
  w.u32(p.time_limit_s);
  for (const pk of p.participants) w.bytes(pubkeyToBytes(pk));
  if (p.kind === 'market') {
    if (p.stakes === undefined || p.stakes.length !== P) fail('market programs need stakes aligned with participants');
    for (const s of p.stakes) w.u64(s);
  } else {
    if (p.stake_each === undefined) fail(`${p.kind} programs need stake_each`);
    for (let i = 0; i < P; i++) w.u64(p.stake_each);
  }
  let mask = 0;
  p.sides.forEach((s, i) => {
    if (s !== 0 && s !== 1) fail(`sides[${i}] must be 0 or 1`);
    if (s === 1) mask |= 1 << i;
  });
  w.u8(mask & 0xff);
  w.u8(p.entities.length);
  const ix = new Map<string, number>();
  p.entities.forEach((e, i) => {
    if (ix.has(e.name)) fail(`duplicate entity name ${e.name}`);
    ix.set(e.name, i);
    const [k, param] = entityCode(e);
    w.u8(k).u8(param);
  });
  w.u8(p.legs.length);
  for (const leg of p.legs) {
    if (p.kind === 'market') writeMarketLeg(w, leg);
    else writeRulesLeg(w, leg, ix);
  }
  const o = p.outcome;
  w.u8(o.if_true).u8(o.else);
  const cond = encodeCond(o.condition);
  w.u16(cond.length).bytes(cond);
  return w.finish();
}

/** `program_hash = sha256(program_bin)` (§4.2), lowercase hex. */
export function programHash(p: Program): Hex32 {
  return bytesToHex(sha256(encodeProgram(p)));
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Parsed leg expressions, alongside a DecodedLeg. */
export interface DecodedLegExprs {
  va: DecodedExprInfo | null;
  succ: DecodedExprInfo | null;
}

/** `decodeProgram` output plus the parsed expression trees. */
export interface DecodedProgramDetail {
  program: DecodedProgram;
  /** aligned with program.legs; both null for market legs */
  exprs: DecodedLegExprs[];
  cond: DecodedCondInfo;
}

function readStake(r: ByteReader, i: number): number {
  const s = r.u64(`stakes[${i}]`);
  check(s >= BigInt(MIN_STAKE_UNITS) && s <= BigInt(MAX_STAKE_UNITS), MP, `stakes[${i}]=${s} out of range`);
  return Number(s);
}

function readLeg(
  r: ByteReader,
  kind: KindCode,
  entities: readonly DecodedEntity[],
  limitFrames: number,
): { leg: DecodedLeg; exprs: DecodedLegExprs } {
  const id = r.u8('leg id');
  const flags = r.u8('leg flags');
  const rule_kind = r.u8('rule_kind');
  const rule_cmp = r.u8('rule_cmp');
  const rule_k = r.u16('rule_k');
  const rule_n = r.u32('rule_n');
  const attempt_window = r.u16('attempt_window');
  const vaLen = r.u16('va_len');
  check(vaLen <= MAX_EXPR_BYTES, MP, `leg ${id}: va_len ${vaLen} exceeds ${MAX_EXPR_BYTES}`);
  const va = r.bytes(vaLen, 'valid_attempt code');
  const succLen = r.u16('succ_len');
  check(succLen <= MAX_EXPR_BYTES, MP, `leg ${id}: succ_len ${succLen} exceeds ${MAX_EXPR_BYTES}`);
  const succ = r.bytes(succLen, 'success code');

  check(id >= MIN_LEG_ID && id <= MAX_LEGS, MP, `leg id ${id} out of 1..=${MAX_LEGS}`);
  check((flags & LEG_FLAG_RESERVED_MASK) === 0, MP, `leg ${id}: reserved flag bits set`);
  const leg: DecodedLeg = {
    id,
    flags,
    rule_kind: rule_kind as RuleKindCode,
    rule_cmp: rule_cmp as CmpCode,
    rule_k,
    rule_n,
    attempt_window,
    va,
    succ,
  };

  if (kind === KIND_CODE.market) {
    check(rule_kind === RULE_KIND_CODE.market, MP, `leg ${id}: market programs allow only market legs`);
    check(flags === 0, MP, `leg ${id}: market legs have flags 0`);
    check(rule_cmp === 0 && rule_n === 0, MP, `leg ${id}: market leg unused fields must be 0`);
    check(rule_k === 0 || rule_k === 1, MP, `leg ${id}: market expected result must be 0|1`);
    check(attempt_window === 0, MP, `leg ${id}: market attempt_window must be 0`);
    check(vaLen === 0, MP, `leg ${id}: market legs have no valid_attempt`);
    check(succLen === MARKET_HASH_BYTES, MP, `leg ${id}: market success must be the 32-byte market_hash`);
    return { leg, exprs: { va: null, succ: null } };
  }

  // rules legs
  check(rule_kind <= RULE_KIND_CODE.before, MP, `leg ${id}: unknown or out-of-context rule_kind ${rule_kind}`);
  check(
    attempt_window >= MIN_DURATION_FRAMES && attempt_window <= MAX_DURATION_FRAMES,
    MP,
    `leg ${id}: attempt_window ${attempt_window} out of 1..=${MAX_DURATION_FRAMES}`,
  );
  const hasVa = (flags & LEG_FLAG_HAS_VALID_ATTEMPT) !== 0;
  check(hasVa === vaLen > 0, MP, `leg ${id}: has_valid_attempt flag does not match va_len`);
  check(succLen > 0, MP, `leg ${id}: success code required`);
  const vaInfo = hasVa ? decodeExpr(va, entities) : null;
  const succInfo = decodeExpr(succ, entities);

  const refsPerson = [...(vaInfo?.refs ?? []), ...succInfo.refs].some((e) => entities[e]!.kind === ENTITY_KIND_CODE.person);
  const actorBound = (flags & LEG_FLAG_ACTOR_BOUND) !== 0;
  check(actorBound === refsPerson, MP, `leg ${id}: actor_bound flag does not match person references`);

  switch (rule_kind) {
    case RULE_KIND_CODE.exists:
    case RULE_KIND_CODE.never:
      check(rule_cmp === 0 && rule_k === 0 && rule_n === 0, MP, `leg ${id}: unused rule fields must be 0`);
      // NEGATIVE_ACTOR_RULE (§2.7): an actor-bound `never` has no anchors (§3.8).
      check(!(rule_kind === RULE_KIND_CODE.never && actorBound), MP, `leg ${id}: actor-bound never`);
      break;
    case RULE_KIND_CODE.count: {
      check(rule_cmp <= 5, MP, `leg ${id}: unknown CMP code ${rule_cmp}`);
      check(rule_k <= REPS_MAX, MP, `leg ${id}: count k ${rule_k} out of 0..=${REPS_MAX}`);
      const maxN = actorBound ? ATTEMPTS_MAX_ACTOR_BOUND : ATTEMPTS_MAX;
      check(rule_n <= maxN, MP, `leg ${id}: attempts ${rule_n} out of 0..=${maxN}`);
      check(hasVa === rule_n > 0, MP, `leg ${id}: valid_attempt iff count … within attempts`);
      // NEGATIVE_ACTOR_RULE (§2.7): actor-bound counts are `>= k` (k ≥ 1) or `> k`.
      check(
        !actorBound || rule_cmp === 1 || (rule_cmp === 0 && rule_k >= 1),
        MP,
        `leg ${id}: actor-bound count must be >= k (k >= 1) or > k`,
      );
      break;
    }
    case RULE_KIND_CODE.holds:
    case RULE_KIND_CODE.before:
      check(rule_cmp === 0 && rule_k === 0, MP, `leg ${id}: unused rule fields must be 0`);
      check(rule_n >= 1 && rule_n <= limitFrames, MP, `leg ${id}: rule frames ${rule_n} out of 1..=${limitFrames}`);
      break;
    default:
      break;
  }
  if (rule_kind !== RULE_KIND_CODE.count) check(!hasVa, MP, `leg ${id}: valid_attempt requires count … within attempts`);
  return { leg, exprs: { va: vaInfo, succ: succInfo } };
}

/**
 * Parse a program_bin starting at `start`; returns the decoded program and the
 * offset just past it (does not require the buffer to end there).
 */
export function readProgram(bin: Uint8Array, start = 0): DecodedProgramDetail & { end: number } {
  const r = new ByteReader(bin, MP, start);
  const magic = r.bytes(4, 'magic');
  check(magic.every((b, i) => b === PROGRAM_MAGIC[i]), MP, 'bad magic');
  check(r.u8('format_version') === PROGRAM_FORMAT_VERSION, MP, 'bad format_version');
  const kind = r.u8('kind');
  check(kind <= 2, MP, `unknown kind ${kind}`);
  check(r.u8('fps') === FPS, MP, 'bad fps');
  const P = r.u8('P');
  check(P >= MIN_PARTICIPANTS && P <= MAX_PARTICIPANTS, MP, `P=${P} out of ${MIN_PARTICIPANTS}..=${MAX_PARTICIPANTS}`);
  const json_hash = bytesToHex(r.bytes(32, 'json_hash'));
  const time_limit_s = r.u32('time_limit_s');
  const maxLimit = kind === KIND_CODE.market ? MARKET_TIME_LIMIT_MAX_S : TIME_LIMIT_MAX_S;
  check(time_limit_s >= MIN_TIME_LIMIT_S && time_limit_s <= maxLimit, MP, `time_limit_s ${time_limit_s} out of range`);

  const participants: string[] = [];
  for (let i = 0; i < P; i++) {
    const pk = bytesToPubkey(r.bytes(32, `participants[${i}]`));
    // Participant distinctness is a compile-time rule (§2.4, validateProgram) and an
    // onchain create_bet check; decoders do not enforce it (matches crates/verdict-rules).
    participants.push(pk);
  }
  const stakes: number[] = [];
  for (let i = 0; i < P; i++) stakes.push(readStake(r, i));
  if (kind !== KIND_CODE.market) check(stakes.every((s) => s === stakes[0]), MP, 'rules/ai_judged stakes must all equal stake_each');

  const side_b_mask = r.u8('side_b_mask');
  check((side_b_mask & 1) === 0, MP, 'side_b_mask bit 0 (creator) set');
  check(side_b_mask !== 0, MP, 'side_b_mask is zero');
  check(side_b_mask >> P === 0, MP, 'side_b_mask has bits >= P');

  const E = r.u8('E');
  check(E <= MAX_ENTITIES, MP, `E=${E} exceeds ${MAX_ENTITIES}`);
  const entities: DecodedEntity[] = [];
  const persons = new Set<number>();
  for (let i = 0; i < E; i++) {
    const k = r.u8(`entities[${i}].kind`);
    const param = r.u8(`entities[${i}].param`);
    check(k <= 4, MP, `entities[${i}]: unknown kind ${k}`);
    if (k === ENTITY_KIND_CODE.person) {
      check(param < P, MP, `entities[${i}]: participant ${param} >= P`);
      check(!persons.has(param), MP, `two person entities for participant ${param}`);
      persons.add(param);
    } else {
      check(param === 0, MP, `entities[${i}]: param must be 0 for non-person`);
    }
    entities.push({ kind: k as EntityKindCode, param });
  }

  const L = r.u8('L');
  check(L <= MAX_LEGS, MP, `L=${L} exceeds ${MAX_LEGS}`);
  if (kind === KIND_CODE.ai_judged) check(L === 0, MP, 'ai_judged programs have no legs');
  else check(L >= 1, MP, 'rules/market programs need at least one leg');
  const limitFrames = time_limit_s * FPS;
  const legs: DecodedLeg[] = [];
  const exprs: DecodedLegExprs[] = [];
  for (let i = 0; i < L; i++) {
    const { leg, exprs: ex } = readLeg(r, kind as KindCode, entities, limitFrames);
    if (i > 0) check(leg.id > legs[i - 1]!.id, MP, `leg ids must be unique and ascending (${leg.id})`);
    legs.push(leg);
    exprs.push(ex);
  }

  const if_true = r.u8('if_true');
  const else_side = r.u8('else');
  check(if_true <= 1 && else_side <= 1, MP, 'outcome sides must be 0|1');
  check(if_true !== else_side, MP, 'outcome if_true == else');
  const condLen = r.u16('cond_len');
  const condBytes = r.bytes(condLen, 'condition code');
  const cond = decodeCond(
    condBytes,
    legs.map((l) => l.id),
    kind === KIND_CODE.ai_judged,
  );

  const tracked = new Set<number>();
  for (const ex of exprs) {
    for (const e of [...(ex.va?.refs ?? []), ...(ex.succ?.refs ?? [])]) {
      const ek = entities[e]!.kind;
      if (ek !== ENTITY_KIND_CODE.line && ek !== ENTITY_KIND_CODE.zone) tracked.add(e);
    }
  }

  const program: DecodedProgram = {
    kind: kind as KindCode,
    P,
    json_hash,
    time_limit_s,
    participants,
    stakes,
    side_b_mask,
    entities,
    legs,
    if_true: if_true as Side,
    else_side: else_side as Side,
    cond: condBytes,
    tracked_entities: [...tracked].sort((a, b) => a - b),
  };
  return { program, exprs, cond, end: r.pos };
}

/** Decode and validate `program_bin` (§5.1); returns the program with its parsed expressions. */
export function decodeProgramDetail(bin: Uint8Array): DecodedProgramDetail {
  const { end, ...rest } = readProgram(bin);
  check(end === bin.length, MP, `${bin.length - end} trailing byte(s)`);
  return rest;
}

/** Decode and validate `program_bin` (§5.1). Throws `EngineError("MalformedProgram")`. */
export function decodeProgram(bin: Uint8Array): DecodedProgram {
  return decodeProgramDetail(bin).program;
}
