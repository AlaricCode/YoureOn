/**
 * AST (§2.6) → decoded expression tree (§5.1 shapes), for non-consensus uses
 * of the evaluator on a Program (leafSignals). Consensus evaluation always
 * goes through program_bin.
 */
import type { DecodedExpr, Entity, EntityKindCode, Expr, LeafCode, Ref } from '../types.js';
import { CMPS, DIRS, LEAF_CODE } from '../constants.js';
import { EvalInvariantError } from './math.js';

export function entityKindCode(e: Entity): EntityKindCode {
  switch (e.kind) {
    case 'person':
      return 0;
    case 'person_any':
      return 1;
    case 'object':
      return 2;
    case 'region':
      return e.shape === 'line' ? 3 : 4;
  }
}

export function entityIndexMap(entities: readonly Entity[]): Map<string, number> {
  return new Map(entities.map((e, i) => [e.name, i]));
}

function refIdx(ref: Ref, idx: ReadonlyMap<string, number>): number {
  const i = idx.get(ref.e);
  if (i === undefined) throw new EvalInvariantError(`unknown entity ${ref.e}`);
  return i;
}

function subCode(ref: Ref): 0 | 1 | 2 {
  return ref.sub === 'opening' ? 1 : ref.sub === 'interior' ? 2 : 0;
}

function refByte(ref: Ref, idx: ReadonlyMap<string, number>): number {
  return refIdx(ref, idx) | (subCode(ref) << 4);
}

function leaf(code: LeafCode, a: Ref, b: number, p: number, idx: ReadonlyMap<string, number>): DecodedExpr {
  return { code, a: { entity: refIdx(a, idx), sub: subCode(a) }, b, p };
}

/** Convert an AST expression to the decoded tree used by the evaluator. */
export function exprFromAst(e: Expr, idx: ReadonlyMap<string, number>): DecodedExpr {
  switch (e.op) {
    case 'and':
      return { code: 0x01, left: exprFromAst(e.args[0], idx), right: exprFromAst(e.args[1], idx) };
    case 'or':
      return { code: 0x02, left: exprFromAst(e.args[0], idx), right: exprFromAst(e.args[1], idx) };
    case 'not':
      return { code: 0x03, arg: exprFromAst(e.arg, idx) };
    case 'then_within':
      return { code: 0x04, frames: e.frames, first: exprFromAst(e.first, idx), then: exprFromAst(e.then, idx) };
    case 'for_duration':
      return { code: 0x05, frames: e.frames, arg: exprFromAst(e.arg, idx) };
    case 'before':
      return { code: 0x06, frames: e.frames, arg: exprFromAst(e.arg, idx) };
    case 'near':
      return leaf(LEAF_CODE.near, e.a, refByte(e.b, idx), e.dist, idx);
    case 'moving':
    case 'present':
    case 'intact':
    case 'standing':
      return leaf(LEAF_CODE[e.op], e.a, 0, 0, idx);
    case 'at_rest':
      return leaf(LEAF_CODE.at_rest, e.a, 0, e.frames, idx);
    case 'speed':
      return leaf(LEAF_CODE.speed, e.a, CMPS.indexOf(e.cmp), e.value, idx);
    case 'direction':
      return leaf(LEAF_CODE.direction, e.a, DIRS.indexOf(e.dir), 0, idx);
    case 'rep_count':
      return leaf(LEAF_CODE.rep_count, e.a, CMPS.indexOf(e.cmp), e.value, idx);
    default:
      return leaf(LEAF_CODE[e.op], e.a, refByte(e.b, idx), 0, idx);
  }
}
