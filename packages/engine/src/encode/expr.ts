/**
 * Expression and condition code (§5.1): prefix-order byte code for leg
 * expressions (`valid_attempt`, `success`) and the outcome condition.
 *
 * Encoders map the AST (§2.6) to bytes; decoders parse and fully validate the
 * bytes (operand kinds §2.7, parameter ranges §5.1, limits §0.5), throwing
 * `EngineError("MalformedProgram")`.
 */
import {
  CMP_CODE,
  DIR_CODE,
  LEAF_CODE,
  MAX_COND_NODES,
  MAX_DURATION_FRAMES,
  MAX_EXPR_DEPTH,
  MAX_EXPR_NODES,
  MIN_DURATION_FRAMES,
  NEAR_MAX,
  OP_AND,
  OP_BEFORE,
  OP_FOR_DURATION,
  OP_LEG,
  OP_NOT,
  OP_OR,
  OP_THEN_WITHIN,
  OP_YES,
  REF_ENTITY_MASK,
  REF_RESERVED_MASK,
  REF_SUB_MASK,
  REF_SUB_SHIFT,
  REPS_MAX,
  SPEED_MAX,
  SUBREGION_CODE,
} from '../constants.js';
import type {
  DecodedCond,
  DecodedEntity,
  DecodedExpr,
  DecodedRef,
  Expr,
  LeafCode,
  LegExpr,
  Ref,
  SubRegionCode,
  YesCondition,
} from '../types.js';
import { EngineError, check } from './errors.js';
import { ByteReader, ByteWriter } from './io.js';

const MP = 'MalformedProgram' as const;

// Entity kind codes (§5.1).
const K_PERSON = 0;
const K_PERSON_ANY = 1;
const K_OBJECT = 2;
const K_LINE = 3;
const K_ZONE = 4;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function fail(detail: string): never {
  throw new EngineError(MP, detail);
}

function refByte(r: Ref, entityIndex: ReadonlyMap<string, number>): number {
  const idx = entityIndex.get(r.e);
  if (idx === undefined) fail(`unknown entity ${JSON.stringify(r.e)}`);
  let sub: number = SUBREGION_CODE.none;
  if (r.sub !== undefined) {
    if (r.sub !== 'opening' && r.sub !== 'interior') fail(`unknown sub-region ${String(r.sub)}`);
    sub = SUBREGION_CODE[r.sub];
  }
  return idx | (sub << REF_SUB_SHIFT);
}

function cmpCode(c: string): number {
  const v = (CMP_CODE as Record<string, number>)[c];
  if (v === undefined) fail(`unknown comparison ${String(c)}`);
  return v;
}

function dirCode(d: string): number {
  const v = (DIR_CODE as Record<string, number>)[d];
  if (v === undefined) fail(`unknown direction ${String(d)}`);
  return v;
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(`${what} must be an integer`);
  return v;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) throw new EngineError(MP, e.message);
    throw e;
  }
}

function writeExpr(w: ByteWriter, e: Expr, ix: ReadonlyMap<string, number>): void {
  switch (e.op) {
    case 'and':
    case 'or':
      w.u8(e.op === 'and' ? OP_AND : OP_OR);
      writeExpr(w, e.args[0], ix);
      writeExpr(w, e.args[1], ix);
      return;
    case 'not':
      w.u8(OP_NOT);
      writeExpr(w, e.arg, ix);
      return;
    case 'then_within':
      w.u8(OP_THEN_WITHIN).u16(int(e.frames, 'then_within frames'));
      writeExpr(w, e.first, ix);
      writeExpr(w, e.then, ix);
      return;
    case 'for_duration':
      w.u8(OP_FOR_DURATION).u16(int(e.frames, 'for_duration frames'));
      writeExpr(w, e.arg, ix);
      return;
    case 'before':
      w.u8(OP_BEFORE).u32(int(e.frames, 'before frames'));
      writeExpr(w, e.arg, ix);
      return;
    default:
      break;
  }
  const code = (LEAF_CODE as Record<string, number>)[e.op];
  if (code === undefined) fail(`unknown expression op ${String((e as { op: unknown }).op)}`);
  const a = refByte(e.a, ix);
  let b = 0;
  let p = 0;
  switch (e.op) {
    case 'near':
      b = refByte(e.b, ix);
      p = int(e.dist, 'near dist');
      break;
    case 'at_rest':
      p = int(e.frames, 'at_rest frames');
      break;
    case 'speed':
    case 'rep_count':
      b = cmpCode(e.cmp);
      p = int(e.value, `${e.op} value`);
      break;
    case 'direction':
      b = dirCode(e.dir);
      break;
    case 'moving':
    case 'present':
    case 'intact':
    case 'standing':
      break;
    default:
      // Rel2
      b = refByte(e.b, ix);
      break;
  }
  w.u8(code).u8(a).u8(b).i32(p);
}

/** Encode a leg expression (§5.1) with entity names resolved through `entityIndex`. */
export function encodeExpr(e: Expr, entityIndex: ReadonlyMap<string, number>): Uint8Array {
  return wrap(() => {
    const w = new ByteWriter(64);
    writeExpr(w, e, entityIndex);
    return w.finish();
  });
}

function writeCond(w: ByteWriter, c: LegExpr | YesCondition): void {
  switch (c.op) {
    case 'yes':
      w.u8(OP_YES);
      return;
    case 'leg':
      w.u8(OP_LEG).u8(int(c.id, 'leg id'));
      return;
    case 'and':
    case 'or':
      w.u8(c.op === 'and' ? OP_AND : OP_OR);
      writeCond(w, c.args[0]);
      writeCond(w, c.args[1]);
      return;
    case 'not':
      w.u8(OP_NOT);
      writeCond(w, c.arg);
      return;
    default:
      fail(`unknown condition op ${String((c as { op: unknown }).op)}`);
  }
}

/** Encode an outcome condition (§5.1: 0x01–0x03, 0x50 leg id, 0x51 yes). */
export function encodeCond(c: LegExpr | YesCondition): Uint8Array {
  return wrap(() => {
    const w = new ByteWriter(16);
    writeCond(w, c);
    return w.finish();
  });
}

// ---------------------------------------------------------------------------
// Decoding + validation
// ---------------------------------------------------------------------------

/** Result of parsing one leg expression. */
export interface DecodedExprInfo {
  expr: DecodedExpr;
  /** number of op bytes */
  nodes: number;
  /** leaf depth = 1 */
  depth: number;
  /** entity indices referenced (a and b refs; the owning object of a sub-region ref), ascending */
  refs: number[];
}

const LEAF_CODES: ReadonlySet<number> = new Set(Object.values(LEAF_CODE));

/** Decode and validate a Ref byte (§5.1). */
export function decodeRefByte(byte: number, entities: readonly DecodedEntity[]): DecodedRef {
  check((byte & REF_RESERVED_MASK) === 0, MP, `ref byte 0x${byte.toString(16)} has bits 6-7 set`);
  const entity = byte & REF_ENTITY_MASK;
  const sub = (byte & REF_SUB_MASK) >> REF_SUB_SHIFT;
  check(entity < entities.length, MP, `ref to entity ${entity} >= E=${entities.length}`);
  check(sub <= 2, MP, `unknown sub-region code ${sub}`);
  check(sub === 0 || entities[entity]!.kind === K_OBJECT, MP, `sub-region on non-object entity ${entity}`);
  return { entity, sub: sub as SubRegionCode };
}

function checkFrames(v: number, what: string): void {
  check(v >= MIN_DURATION_FRAMES && v <= MAX_DURATION_FRAMES, MP, `${what} frames ${v} out of 1..=${MAX_DURATION_FRAMES}`);
}

class ExprParser {
  nodes = 0;
  depth = 0;
  readonly refs = new Set<number>();
  constructor(
    private readonly r: ByteReader,
    private readonly entities: readonly DecodedEntity[],
  ) {}

  private kind(ref: DecodedRef): number {
    return this.entities[ref.entity]!.kind;
  }

  private ref(byte: number): DecodedRef {
    const ref = decodeRefByte(byte, this.entities);
    this.refs.add(ref.entity);
    return ref;
  }

  parse(level: number): DecodedExpr {
    check(level <= MAX_EXPR_DEPTH, MP, `expression depth exceeds ${MAX_EXPR_DEPTH}`);
    if (level > this.depth) this.depth = level;
    const op = this.r.u8('expression op');
    this.nodes++;
    check(this.nodes <= MAX_EXPR_NODES, MP, `expression exceeds ${MAX_EXPR_NODES} nodes`);
    switch (op) {
      case OP_AND:
      case OP_OR: {
        const left = this.parse(level + 1);
        const right = this.parse(level + 1);
        return { code: op, left, right };
      }
      case OP_NOT:
        return { code: OP_NOT, arg: this.parse(level + 1) };
      case OP_THEN_WITHIN: {
        const frames = this.r.u16('then_within frames');
        checkFrames(frames, 'then_within');
        const first = this.parse(level + 1);
        const then = this.parse(level + 1);
        return { code: OP_THEN_WITHIN, frames, first, then };
      }
      case OP_FOR_DURATION: {
        const frames = this.r.u16('for_duration frames');
        checkFrames(frames, 'for_duration');
        return { code: OP_FOR_DURATION, frames, arg: this.parse(level + 1) };
      }
      case OP_BEFORE: {
        const frames = this.r.u32('before frames');
        checkFrames(frames, 'before');
        return { code: OP_BEFORE, frames, arg: this.parse(level + 1) };
      }
      default:
        break;
    }
    check(LEAF_CODES.has(op), MP, `unknown or out-of-context op 0x${op.toString(16)} in leg expression`);
    const aByte = this.r.u8('leaf a');
    const bByte = this.r.u8('leaf b');
    const p = this.r.i32('leaf p');
    const a = this.ref(aByte);
    check(a.sub === 0, MP, 'sub-region on an a operand');
    const ak = this.kind(a);
    check(ak === K_PERSON || ak === K_PERSON_ANY || ak === K_OBJECT, MP, `a operand must be person/person_any/object (entity ${a.entity})`);
    const code = op as LeafCode;
    const zeroP = (what: string): void => check(p === 0, MP, `${what}: unused p must be 0`);
    const zeroB = (what: string): void => check(bByte === 0, MP, `${what}: unused b must be 0`);
    switch (code) {
      case LEAF_CODE.behind:
      case LEAF_CODE.beyond:
      case LEAF_CODE.crosses: {
        const b = this.ref(bByte);
        check(b.sub === 0 && this.kind(b) === K_LINE, MP, 'behind/beyond/crosses require b = line region');
        zeroP('line relation');
        break;
      }
      case LEAF_CODE.enters:
      case LEAF_CODE.leaves: {
        const b = this.ref(bByte);
        const bk = this.kind(b);
        check(bk === K_ZONE || bk === K_OBJECT, MP, 'enters/leaves require b = zone, sub-region or object');
        zeroP('enters/leaves');
        break;
      }
      case LEAF_CODE.disappears_into: {
        const b = this.ref(bByte);
        const bk = this.kind(b);
        check(
          (bk === K_ZONE && b.sub === 0) || (bk === K_OBJECT && b.sub === SUBREGION_CODE.opening),
          MP,
          'disappears_into requires b = .opening sub-region or zone',
        );
        zeroP('disappears_into');
        break;
      }
      case LEAF_CODE.released_by: {
        const b = this.ref(bByte);
        const bk = this.kind(b);
        check(b.sub === 0 && (bk === K_PERSON || bk === K_PERSON_ANY), MP, 'released_by requires b = person/person_any');
        zeroP('released_by');
        break;
      }
      case LEAF_CODE.near: {
        const b = this.ref(bByte);
        check(this.kind(b) !== K_LINE, MP, 'near cannot take a line region');
        check(p >= 0 && p <= NEAR_MAX, MP, `near dist ${p} out of 0..=${NEAR_MAX}`);
        break;
      }
      case LEAF_CODE.overlaps:
      case LEAF_CODE.inside:
      case LEAF_CODE.above:
      case LEAF_CODE.below:
      case LEAF_CODE.touches: {
        const b = this.ref(bByte);
        check(this.kind(b) !== K_LINE, MP, 'only behind/beyond/crosses may take a line region');
        zeroP('relation');
        break;
      }
      case LEAF_CODE.moving:
      case LEAF_CODE.present:
      case LEAF_CODE.intact:
        zeroB('unary');
        zeroP('unary');
        break;
      case LEAF_CODE.standing:
        check(ak === K_PERSON || ak === K_PERSON_ANY, MP, 'standing requires a = person/person_any');
        zeroB('standing');
        zeroP('standing');
        break;
      case LEAF_CODE.at_rest:
        zeroB('at_rest');
        checkFrames(p, 'at_rest');
        break;
      case LEAF_CODE.speed:
        check(bByte <= 5, MP, `unknown CMP code ${bByte}`);
        check(p >= 0 && p <= SPEED_MAX, MP, `speed value ${p} out of 0..=${SPEED_MAX}`);
        break;
      case LEAF_CODE.direction:
        check(bByte <= 3, MP, `unknown DIR code ${bByte}`);
        zeroP('direction');
        break;
      case LEAF_CODE.rep_count:
        check(ak === K_PERSON || ak === K_PERSON_ANY, MP, 'rep_count requires a = person/person_any');
        check(bByte <= 5, MP, `unknown CMP code ${bByte}`);
        check(p >= 0 && p <= REPS_MAX, MP, `rep_count value ${p} out of 0..=${REPS_MAX}`);
        break;
      default:
        throw new EngineError(MP, `unknown leaf code 0x${op.toString(16)}`);
    }
    return { code, a, b: bByte, p };
  }
}

/**
 * Parse and validate a complete leg expression code (§5.1). The code must be
 * exactly one expression (no trailing bytes) of at most MAX_EXPR_BYTES bytes.
 */
export function decodeExpr(code: Uint8Array, entities: readonly DecodedEntity[]): DecodedExprInfo {
  check(code.length >= 1, MP, 'empty expression');
  check(code.length <= 512, MP, `expression exceeds 512 bytes`);
  const r = new ByteReader(code, MP);
  const p = new ExprParser(r, entities);
  const expr = p.parse(1);
  r.expectEnd('expression');
  return { expr, nodes: p.nodes, depth: p.depth, refs: [...p.refs].sort((x, y) => x - y) };
}

/** Result of parsing the outcome condition. */
export interface DecodedCondInfo {
  cond: DecodedCond;
  nodes: number;
  depth: number;
}

/**
 * Parse and validate an outcome condition (§5.1). For `ai_judged` the whole
 * condition MUST be exactly `0x51`; otherwise only 0x01–0x03 and 0x50 with an
 * existing leg id are allowed, ≤ MAX_COND_NODES nodes and depth ≤ MAX_EXPR_DEPTH.
 */
export function decodeCond(code: Uint8Array, legIds: readonly number[], aiJudged: boolean): DecodedCondInfo {
  if (aiJudged) {
    check(code.length === 1 && code[0] === OP_YES, MP, 'ai_judged condition must be exactly 0x51');
    return { cond: { code: OP_YES }, nodes: 1, depth: 1 };
  }
  check(code.length >= 1, MP, 'empty condition');
  const ids = new Set(legIds);
  const r = new ByteReader(code, MP);
  let nodes = 0;
  let depth = 0;
  const parse = (level: number): DecodedCond => {
    check(level <= MAX_EXPR_DEPTH, MP, `condition depth exceeds ${MAX_EXPR_DEPTH}`);
    if (level > depth) depth = level;
    const op = r.u8('condition op');
    nodes++;
    check(nodes <= MAX_COND_NODES, MP, `condition exceeds ${MAX_COND_NODES} nodes`);
    switch (op) {
      case OP_AND:
      case OP_OR: {
        const left = parse(level + 1);
        const right = parse(level + 1);
        return { code: op, left, right };
      }
      case OP_NOT:
        return { code: OP_NOT, arg: parse(level + 1) };
      case OP_LEG: {
        const leg_id = r.u8('leg id');
        check(ids.has(leg_id), MP, `condition names missing leg id ${leg_id}`);
        return { code: OP_LEG, leg_id };
      }
      default:
        throw new EngineError(MP, `unknown or out-of-context op 0x${op.toString(16)} in condition`);
    }
  };
  const cond = parse(1);
  r.expectEnd('condition');
  return { cond, nodes, depth };
}
