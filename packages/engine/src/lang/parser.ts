/**
 * Recursive-descent parsers for expression (§2.5.2), rule (§2.5.3) and
 * outcome (§2.5.4) strings.
 *
 * The parsers produce canonical node shapes directly: `while` → `and`,
 * `before_deadline` → `before`, functional forms → the canonical node,
 * durations → frames, `leg N false` → `not`, `leg N true` → `leg`.
 * Semantic checks (entity existence, operand kinds, ranges) are left to
 * canonicalization and validation.
 */
import { NEAR_DEFAULT, REL2_OPS, UNARY_OPS, DIRS } from '../constants.js';
import type {
  Cmp,
  Dir,
  Expr,
  LegExpr,
  Ref,
  Rel2,
  Rule,
  SideRefInput,
  DraftOutcome,
  UnaryOp,
  YesCondition,
} from '../types.js';
import { ParseFailure } from './errors.js';
import { lex, type Token } from './lexer.js';

const REL2_SET: ReadonlySet<string> = new Set<string>(REL2_OPS);
const UNARY_SET: ReadonlySet<string> = new Set<string>(UNARY_OPS);
const DIR_SET: ReadonlySet<string> = new Set<string>(DIRS);

function describe(t: Token): string {
  return t.t === 'EOF' ? 'end of input' : JSON.stringify(t.text);
}

/**
 * Token cap per string. A valid leg expression has at most 64 nodes (each at most ~10 tokens
 * plus parentheses), so this only rejects inputs that would fail `LIMIT` anyway, and it bounds
 * parser recursion depth.
 */
export const MAX_TOKENS = 1024;

class Stream {
  private i = 0;
  constructor(private readonly toks: Token[]) {
    if (toks.length > MAX_TOKENS) {
      throw new ParseFailure(`input too long (${toks.length - 1} tokens, max ${MAX_TOKENS - 1})`, toks[MAX_TOKENS - 1]!.col, 'LIMIT');
    }
  }

  peek(offset = 0): Token {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)]!;
  }
  next(): Token {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  fail(msg: string, t: Token = this.peek()): never {
    throw new ParseFailure(`${msg}, found ${describe(t)}`, t.col);
  }
  isKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.t === 'REF' && t.keyword && t.name === word;
  }
  isPunct(p: string): boolean {
    const t = this.peek();
    return t.t === 'PUNCT' && t.text === p;
  }
  expectKeyword(word: string): Token {
    if (!this.isKeyword(word)) this.fail(`expected "${word}"`);
    return this.next();
  }
  expectPunct(p: '(' | ')' | ',' | ';'): Token {
    if (!this.isPunct(p)) this.fail(`expected "${p}"`);
    return this.next();
  }
  expectDur(): number {
    const t = this.peek();
    if (t.t !== 'DUR') this.fail('expected a duration such as 2s or 500ms');
    this.next();
    return t.frames;
  }
  expectInt(): number {
    const t = this.peek();
    if (t.t !== 'INT') this.fail('expected an integer');
    this.next();
    return t.value;
  }
  expectCmp(): Cmp {
    const t = this.peek();
    if (t.t !== 'CMP') this.fail('expected a comparison (>=, >, <=, <, ==, !=)');
    this.next();
    return t.text;
  }
  expectEnd(): void {
    if (this.peek().t !== 'EOF') this.fail('unexpected trailing input');
  }
  /** An entity reference (non-keyword REF, optional sub-region suffix). */
  expectRef(): Ref {
    const t = this.peek();
    if (t.t !== 'REF' || t.keyword) this.fail('expected an entity name');
    this.next();
    const r: Ref = { e: t.name };
    if (t.sub !== undefined) r.sub = t.sub;
    return r;
  }
  expectDir(): Dir {
    const t = this.peek();
    if (t.t !== 'REF' || !t.keyword || !DIR_SET.has(t.name)) this.fail('expected a direction (up, down, left, right)');
    this.next();
    return t.name as Dir;
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function parseOr(s: Stream): Expr {
  let left = parseAnd(s);
  while (s.isKeyword('or')) {
    s.next();
    left = { op: 'or', args: [left, parseAnd(s)] };
  }
  return left;
}

function parseAnd(s: Stream): Expr {
  let left = parseWhile(s);
  while (s.isKeyword('and')) {
    s.next();
    left = { op: 'and', args: [left, parseWhile(s)] };
  }
  return left;
}

function parseWhile(s: Stream): Expr {
  let left = parseThen(s);
  while (s.isKeyword('while')) {
    s.next();
    left = { op: 'and', args: [left, parseThen(s)] };
  }
  return left;
}

function parseThen(s: Stream): Expr {
  let left = parseUnary(s);
  while (s.isKeyword('then_within')) {
    s.next();
    const frames = s.expectDur();
    const then = parseUnary(s);
    left = { op: 'then_within', frames, first: left, then };
  }
  return left;
}

function parseUnary(s: Stream): Expr {
  if (s.isKeyword('not')) {
    s.next();
    return { op: 'not', arg: parseUnary(s) };
  }
  return parsePostfix(s);
}

function parsePostfix(s: Stream): Expr {
  let x = parsePrimary(s);
  for (;;) {
    if (s.isKeyword('for_duration')) {
      s.next();
      x = { op: 'for_duration', frames: s.expectDur(), arg: x };
    } else if (s.isKeyword('before') || s.isKeyword('before_deadline')) {
      s.next();
      x = { op: 'before', frames: s.expectDur(), arg: x };
    } else {
      return x;
    }
  }
}

function parsePrimary(s: Stream): Expr {
  if (s.isPunct('(')) {
    s.next();
    const e = parseOr(s);
    s.expectPunct(')');
    return e;
  }
  return parseAtom(s);
}

function parseAtom(s: Stream): Expr {
  const t = s.peek();
  if (t.t !== 'REF') s.fail('expected an entity name, a primitive or "("');
  if (!t.keyword) return parseInfixAtom(s);
  return parseFunctionalAtom(s);
}

/** `REF <primitive> ...` */
function parseInfixAtom(s: Stream): Expr {
  const a = s.expectRef();
  const t = s.peek();
  if (t.t !== 'REF' || !t.keyword) s.fail(`expected a primitive after "${refText(a)}"`);
  const w = t.name;
  if (REL2_SET.has(w)) {
    s.next();
    return { op: w as Rel2, a, b: s.expectRef() };
  }
  if (w === 'near') {
    s.next();
    const b = s.expectRef();
    let dist = NEAR_DEFAULT;
    if (s.peek().t === 'INT') dist = s.expectInt();
    return { op: 'near', a, b, dist };
  }
  if (UNARY_SET.has(w)) {
    s.next();
    return { op: w as UnaryOp, a };
  }
  if (w === 'at_rest') {
    s.next();
    return { op: 'at_rest', a, frames: s.expectDur() };
  }
  if (w === 'speed') {
    s.next();
    const cmp = s.expectCmp();
    return { op: 'speed', a, cmp, value: s.expectInt() };
  }
  if (w === 'direction') {
    s.next();
    return { op: 'direction', a, dir: s.expectDir() };
  }
  return s.fail(`expected a primitive after "${refText(a)}"`);
}

/** `FUNC(...)` forms, including `rep_count(x) CMP INT`. */
function parseFunctionalAtom(s: Stream): Expr {
  const t = s.next();
  if (t.t !== 'REF') return s.fail('expected a primitive', t);
  const w = t.name;
  if (w === 'rep_count' || w === 'speed') {
    s.expectPunct('(');
    const a = s.expectRef();
    s.expectPunct(')');
    const cmp = s.expectCmp();
    const value = s.expectInt();
    return w === 'rep_count' ? { op: 'rep_count', a, cmp, value } : { op: 'speed', a, cmp, value };
  }
  if (REL2_SET.has(w) || w === 'near') {
    s.expectPunct('(');
    const a = s.expectRef();
    s.expectPunct(',');
    const b = s.expectRef();
    let dist: number | undefined;
    if (s.isPunct(',')) {
      const comma = s.next();
      if (w !== 'near') s.fail(`"${w}" takes two arguments`, comma);
      dist = s.expectInt();
    }
    s.expectPunct(')');
    if (w === 'near') return { op: 'near', a, b, dist: dist ?? NEAR_DEFAULT };
    return { op: w as Rel2, a, b };
  }
  if (UNARY_SET.has(w)) {
    s.expectPunct('(');
    const a = s.expectRef();
    s.expectPunct(')');
    return { op: w as UnaryOp, a };
  }
  if (w === 'at_rest') {
    s.expectPunct('(');
    const a = s.expectRef();
    s.expectPunct(',');
    const frames = s.expectDur();
    s.expectPunct(')');
    return { op: 'at_rest', a, frames };
  }
  if (w === 'direction') {
    s.expectPunct('(');
    const a = s.expectRef();
    s.expectPunct(',');
    const dir = s.expectDir();
    s.expectPunct(')');
    return { op: 'direction', a, dir };
  }
  return s.fail('expected an entity name, a primitive or "("', t);
}

function refText(r: Ref): string {
  return r.sub ? `${r.e}.${r.sub}` : r.e;
}

/** Parse an expression string (§2.5.2). Throws `ParseFailure`. */
export function parseExpr(src: string): Expr {
  const s = new Stream(lex(src));
  const e = parseOr(s);
  s.expectEnd();
  return e;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Parse a `rule:` string (§2.5.3). Throws `ParseFailure`. */
export function parseRule(src: string): Rule {
  const s = new Stream(lex(src));
  let rule: Rule;
  if (s.isKeyword('success')) {
    s.next();
    if (s.isKeyword('before') || s.isKeyword('before_deadline')) {
      s.next();
      rule = { kind: 'before', frames: s.expectDur() };
    } else {
      rule = { kind: 'exists' };
    }
  } else if (s.isKeyword('never')) {
    s.next();
    successArg(s);
    rule = { kind: 'never' };
  } else if (s.isKeyword('count')) {
    s.next();
    successArg(s);
    const cmp = s.expectCmp();
    const k = s.expectInt();
    let attempts = 0;
    if (s.isKeyword('within')) {
      s.next();
      s.expectKeyword('attempts');
      attempts = s.expectInt();
    }
    rule = { kind: 'count', cmp, k, attempts };
  } else if (s.isKeyword('holds')) {
    s.next();
    successArg(s);
    s.expectKeyword('for');
    rule = { kind: 'holds', frames: s.expectDur() };
  } else {
    return s.fail('expected a rule (success, never(success), count(success) ..., holds(success) for ..., success before ...)');
  }
  s.expectEnd();
  return rule;
}

function successArg(s: Stream): void {
  s.expectPunct('(');
  s.expectKeyword('success');
  s.expectPunct(')');
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function parseSideRef(s: Stream): SideRefInput {
  s.expectKeyword('side');
  s.expectPunct('(');
  const t = s.peek();
  let r: SideRefInput;
  if (t.t === 'SIDEL') {
    s.next();
    r = { side: t.text };
  } else if (t.t === 'REF' && t.keyword && (t.name === 'creator' || t.name === 'other')) {
    s.next();
    r = { side: t.name };
  } else if (t.t === 'REF' && !t.keyword && t.sub === undefined) {
    s.next();
    r = { entity: t.name };
  } else {
    return s.fail('expected creator, other, A, B or a person entity name');
  }
  s.expectPunct(')');
  return r;
}

function parseLegOr(s: Stream): LegExpr {
  let left = parseLegAnd(s);
  while (s.isKeyword('or')) {
    s.next();
    left = { op: 'or', args: [left, parseLegAnd(s)] };
  }
  return left;
}

function parseLegAnd(s: Stream): LegExpr {
  let left = parseLegNot(s);
  while (s.isKeyword('and')) {
    s.next();
    left = { op: 'and', args: [left, parseLegNot(s)] };
  }
  return left;
}

function parseLegNot(s: Stream): LegExpr {
  if (s.isKeyword('not')) {
    s.next();
    return { op: 'not', arg: parseLegNot(s) };
  }
  if (s.isPunct('(')) {
    s.next();
    const c = parseLegOr(s);
    s.expectPunct(')');
    return c;
  }
  if (s.isKeyword('leg')) {
    s.next();
    const id = s.expectInt();
    if (s.isKeyword('true')) {
      s.next();
      return { op: 'leg', id };
    }
    if (s.isKeyword('false')) {
      s.next();
      return { op: 'not', arg: { op: 'leg', id } };
    }
    return { op: 'leg', id };
  }
  return s.fail('expected "leg N", "not" or "("');
}

/** Parse an `outcome:` string (§2.5.4) into an unresolved outcome. Throws `ParseFailure`. */
export function parseOutcome(src: string): DraftOutcome {
  const s = new Stream(lex(src));
  const ifTrue = parseSideRef(s);
  s.expectKeyword('wins');
  s.expectKeyword('iff');
  let condition: LegExpr | YesCondition;
  if (s.isKeyword('yes')) {
    s.next();
    condition = { op: 'yes' };
  } else {
    condition = parseLegOr(s);
  }
  s.expectPunct(';');
  s.expectKeyword('else');
  const elseRef = parseSideRef(s);
  s.expectEnd();
  return { if_true: ifTrue, condition, else: elseRef };
}
