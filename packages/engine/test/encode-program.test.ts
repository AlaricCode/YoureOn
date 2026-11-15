import { describe, expect, it } from 'vitest';
import {
  EngineError,
  decodeCond,
  decodeExpr,
  decodeProgram,
  decodeProgramDetail,
  encodeExpr,
  encodeProgram,
  isEngineError,
  programHash,
} from '../src/encode/index.js';
import { bytesToHex, jsonHash, marketHash, sha256Hex } from '../src/hash/index.js';
import type { Expr, LegExpr, Program } from '../src/types.js';
import { CREATOR, FRIEND, aiJudged, marketProgram, paperBall, pk } from './encode-fixtures.js';

const hex = (s: string): Uint8Array => Uint8Array.from(s.split(' ').map((b) => parseInt(b, 16)));

function expectMalformed(fn: () => unknown, code = 'MalformedProgram'): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an EngineError').toBeInstanceOf(EngineError);
  expect((err as EngineError).code).toBe(code);
}

/** Offsets in a program_bin. */
function layout(bin: Uint8Array) {
  const P = bin[7]!;
  const mask = 44 + 40 * P;
  const E = bin[mask + 1]!;
  const ents = mask + 2;
  const L = ents + 2 * E;
  return { P, mask, E, ents, L, leg0: L + 1 };
}

function u16le(n: number): number[] {
  return [n & 0xff, n >> 8];
}
function i32le(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return [...b];
}
function leaf(code: number, a: number, b = 0, p = 0): number[] {
  return [code, a, b, ...i32le(p)];
}

// Template entity indices
const SHOOTER = 0; // person p1
const CROWD = 1; // person_any
const BALL = 2; // object
const CAN = 3; // object
const LINE = 4; // line region
const ZONE = 5; // zone region

function template(): Program {
  return {
    version: 2,
    kind: 'rules',
    participants: [CREATOR, FRIEND],
    sides: [0, 1],
    entities: [
      { name: 'shooter', kind: 'person', participant: 1 },
      { name: 'crowd', kind: 'person_any' },
      { name: 'ball', kind: 'object', phrase: 'ball' },
      { name: 'can', kind: 'object', phrase: 'can' },
      { name: 'line', kind: 'region', shape: 'line' },
      { name: 'zone', kind: 'region', shape: 'zone' },
    ],
    legs: [
      { id: 1, actor_bound: false, attempt_window_frames: 50, success: { op: 'present', a: { e: 'ball' } }, rule: { kind: 'exists' } },
    ],
    outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
    stake_each: 10000,
    time_limit_s: 120,
  };
}

/** program_bin of the template with leg 1's success code replaced by `code`. */
function withSuccess(code: number[], actor = false): Uint8Array {
  const bin = encodeProgram(template());
  const { leg0 } = layout(bin);
  const head = [...bin.slice(0, leg0 + 14)];
  head[leg0 + 1] = actor ? 1 : 0;
  return Uint8Array.from([...head, ...u16le(code.length), ...code, ...bin.slice(leg0 + 16 + 7)]);
}

/** program_bin of the template with the condition replaced. */
function withCond(cond: number[]): Uint8Array {
  const bin = encodeProgram(template());
  const condLenOff = bin.length - 2 - 2;
  return Uint8Array.from([...bin.slice(0, condLenOff), ...u16le(cond.length), ...cond]);
}

function mutate(bin: Uint8Array, off: number, v: number): Uint8Array {
  const out = bin.slice();
  out[off] = v;
  return out;
}

function programWith(success: Expr, extra: Partial<Program['legs'][number]> = {}): Program {
  const p = template();
  p.legs[0] = { ...p.legs[0]!, success, ...extra };
  return p;
}

describe('program_bin: §15.1 worked example', () => {
  const p = paperBall();
  const bin = encodeProgram(p);
  const dp = decodeProgram(bin);

  it('header fields', () => {
    expect([...bin.slice(0, 8)]).toEqual([0x56, 0x52, 0x44, 0x50, 2, 0, 10, 2]);
    expect(bytesToHex(bin.slice(8, 40))).toBe(jsonHash(p));
    expect(dp.json_hash).toBe(jsonHash(p));
    expect(dp.time_limit_s).toBe(180);
    expect(dp.participants).toEqual([CREATOR, FRIEND]);
    expect(dp.stakes).toEqual([5000000, 5000000]);
    expect(dp.side_b_mask).toBe(0b10);
    expect(dp.entities).toEqual([
      { kind: 0, param: 1 },
      { kind: 2, param: 0 },
      { kind: 2, param: 0 },
      { kind: 3, param: 0 },
    ]);
    expect(dp.if_true).toBe(1);
    expect(dp.else_side).toBe(0);
    expect([...dp.cond]).toEqual([0x50, 1]);
  });

  it('valid_attempt encodes to the 15 bytes given in §15.1', () => {
    expect(dp.legs[0]!.va).toEqual(hex('01 35 01 00 00 00 00 00 15 00 03 00 00 00 00'));
  });

  it('success uses ref byte 0x12 for can.opening and at_rest p = 10', () => {
    expect(bytesToHex(dp.legs[0]!.succ)).toBe(
      ['02', '32 01 12 00 00 00 00', '01', '11 01 02 00 00 00 00', '21 01 00 0a 00 00 00'].join('').replace(/ /g, ''),
    );
  });

  it('leg fields and tracked entities', () => {
    const leg = dp.legs[0]!;
    expect(leg).toMatchObject({ id: 1, flags: 0b11, rule_kind: 1, rule_cmp: 0, rule_k: 1, rule_n: 3, attempt_window: 50 });
    expect(dp.tracked_entities).toEqual([0, 1, 2]);
  });

  it('is deterministic and program_hash = sha256(program_bin)', () => {
    expect(encodeProgram(paperBall())).toEqual(bin);
    expect(programHash(p)).toBe(sha256Hex(bin));
  });

  it('detail decode exposes parsed trees', () => {
    const d = decodeProgramDetail(bin);
    expect(d.exprs[0]!.va!.nodes).toBe(3);
    expect(d.exprs[0]!.succ!.depth).toBe(3);
    expect(d.exprs[0]!.succ!.expr).toMatchObject({ code: 2, left: { code: 0x32, a: { entity: 1, sub: 0 }, b: 0x12, p: 0 } });
    expect(d.cond.cond).toEqual({ code: 0x50, leg_id: 1 });
  });
});

describe('program_bin: other kinds', () => {
  it('ai_judged: no legs, cond = 0x51, tracked = []', () => {
    const p = aiJudged();
    const bin = encodeProgram(p);
    const dp = decodeProgram(bin);
    expect(dp.kind).toBe(1);
    expect(dp.legs).toEqual([]);
    expect([...dp.cond]).toEqual([0x51]);
    expect(dp.tracked_entities).toEqual([]);
    expect(bin.length).toBe(44 + 40 * 2 + 1 + 1 + 1 + 2 + 2 + 1);
  });

  it('market: rule_kind 5, rule_k = expected, succ = market_hash, per-participant stakes', () => {
    const p = marketProgram();
    const dp = decodeProgram(encodeProgram(p));
    expect(dp.kind).toBe(2);
    expect(dp.stakes).toEqual([600000, 400000]);
    expect(dp.time_limit_s).toBe(86400);
    expect(dp.legs.map((l) => [l.rule_kind, l.rule_k, l.rule_n, l.attempt_window, l.flags, l.va.length])).toEqual([
      [5, 1, 0, 0, 0, 0],
      [5, 0, 0, 0, 0, 0],
    ]);
    expect(bytesToHex(dp.legs[0]!.succ)).toBe(marketHash('EV1', 'C1'));
    expect(bytesToHex(dp.legs[1]!.succ)).toBe(marketHash('EV2', 'C9'));
  });

  it('market legs cannot carry actor_bound or a window', () => {
    const p = marketProgram();
    p.legs[0]!.attempt_window_frames = 50;
    expectMalformed(() => encodeProgram(p));
    const q = marketProgram();
    q.legs[0]!.actor_bound = true;
    expectMalformed(() => encodeProgram(q));
  });

  it('market time limit up to 30 days, rules up to 3600 s', () => {
    const p = marketProgram();
    p.time_limit_s = 2592000;
    expect(() => encodeProgram(p)).not.toThrow();
    p.time_limit_s = 2592001;
    expectMalformed(() => encodeProgram(p));
    const r = template();
    r.time_limit_s = 3600;
    expect(() => encodeProgram(r)).not.toThrow();
    r.time_limit_s = 3601;
    expectMalformed(() => encodeProgram(r));
    r.time_limit_s = 0;
    expectMalformed(() => encodeProgram(r));
  });
});

describe('program_bin: every leaf encodes and round-trips', () => {
  const leaves: [Expr, boolean][] = [
    [{ op: 'overlaps', a: { e: 'ball' }, b: { e: 'can', sub: 'interior' } }, false],
    [{ op: 'inside', a: { e: 'ball' }, b: { e: 'zone' } }, false],
    [{ op: 'above', a: { e: 'ball' }, b: { e: 'crowd' } }, false],
    [{ op: 'below', a: { e: 'ball' }, b: { e: 'shooter' } }, true],
    [{ op: 'near', a: { e: 'shooter' }, b: { e: 'can' }, dist: 14143 }, true],
    [{ op: 'near', a: { e: 'ball' }, b: { e: 'can' }, dist: 0 }, false],
    [{ op: 'behind', a: { e: 'crowd' }, b: { e: 'line' } }, false],
    [{ op: 'beyond', a: { e: 'ball' }, b: { e: 'line' } }, false],
    [{ op: 'moving', a: { e: 'ball' } }, false],
    [{ op: 'at_rest', a: { e: 'ball' }, frames: 1 }, false],
    [{ op: 'at_rest', a: { e: 'ball' }, frames: 36000 }, false],
    [{ op: 'speed', a: { e: 'ball' }, cmp: '!=', value: 100000 }, false],
    [{ op: 'speed', a: { e: 'ball' }, cmp: '>=', value: 0 }, false],
    [{ op: 'direction', a: { e: 'ball' }, dir: 'right' }, false],
    [{ op: 'present', a: { e: 'crowd' } }, false],
    [{ op: 'intact', a: { e: 'can' } }, false],
    [{ op: 'enters', a: { e: 'ball' }, b: { e: 'zone' } }, false],
    [{ op: 'enters', a: { e: 'ball' }, b: { e: 'can' } }, false],
    [{ op: 'leaves', a: { e: 'ball' }, b: { e: 'can', sub: 'interior' } }, false],
    [{ op: 'disappears_into', a: { e: 'ball' }, b: { e: 'can', sub: 'opening' } }, false],
    [{ op: 'disappears_into', a: { e: 'ball' }, b: { e: 'zone' } }, false],
    [{ op: 'touches', a: { e: 'ball' }, b: { e: 'can' } }, false],
    [{ op: 'crosses', a: { e: 'ball' }, b: { e: 'line' } }, false],
    [{ op: 'released_by', a: { e: 'ball' }, b: { e: 'crowd' } }, false],
    [{ op: 'standing', a: { e: 'shooter' } }, true],
    [{ op: 'rep_count', a: { e: 'crowd' }, cmp: '<', value: 1000 }, false],
  ];
  for (const [e, actor] of leaves) {
    it(`${e.op} ${JSON.stringify(e).slice(0, 60)}`, () => {
      const p = programWith(e, { actor_bound: actor });
      const dp = decodeProgram(encodeProgram(p));
      expect(dp.legs[0]!.succ.length).toBe(7);
      expect(dp.legs[0]!.flags & 1).toBe(actor ? 1 : 0);
      // region entities never get tracks
      expect(dp.tracked_entities.every((i) => i !== LINE && i !== ZONE)).toBe(true);
    });
  }

  it('combinators at their frame bounds', () => {
    const x: Expr = { op: 'present', a: { e: 'ball' } };
    const e: Expr = {
      op: 'then_within',
      frames: 36000,
      first: { op: 'for_duration', frames: 1, arg: x },
      then: { op: 'before', frames: 36000, arg: { op: 'not', arg: x } },
    };
    const succ = decodeProgram(encodeProgram(programWith(e))).legs[0]!.succ;
    expect([...succ.slice(0, 3)]).toEqual([0x04, 0xa0, 0x8c]);
    expect([...succ.slice(3, 6)]).toEqual([0x05, 1, 0]);
    expect(succ[13]).toBe(0x06);
    expect([...succ.slice(14, 18)]).toEqual([0xa0, 0x8c, 0, 0]); // u32 frames
    expect(succ.length).toBe(3 + 3 + 7 + 5 + 1 + 7);
  });

  it('tracked_entities includes the owning object of a sub-region and b persons', () => {
    const p = programWith({
      op: 'and',
      args: [
        { op: 'overlaps', a: { e: 'ball' }, b: { e: 'can', sub: 'opening' } },
        { op: 'released_by', a: { e: 'ball' }, b: { e: 'shooter' } },
      ],
    }, { actor_bound: true });
    expect(decodeProgram(encodeProgram(p)).tracked_entities).toEqual([SHOOTER, BALL, CAN]);
  });
});

describe('program_bin: limits at their boundaries', () => {
  const x: Expr = { op: 'present', a: { e: 'ball' } };
  const chainNot = (n: number): Expr => (n === 0 ? x : { op: 'not', arg: chainNot(n - 1) });
  const balanced = (leaves: number): Expr => {
    let e: Expr = x;
    for (let i = 1; i < leaves; i++) e = { op: 'or', args: [x, e] };
    return e;
  };
  it('depth 12 ok, 13 rejected', () => {
    expect(() => encodeProgram(programWith(chainNot(11)))).not.toThrow();
    expectMalformed(() => encodeProgram(programWith(chainNot(12))));
  });
  it('64 nodes ok, 65 rejected (also checks depth)', () => {
    // and-of-ors tree: build a wide tree with ≤ 12 depth
    const wide = (n: number): Expr => {
      // n leaves in a balanced binary tree → 2n-1 nodes
      if (n === 1) return x;
      const l = Math.floor(n / 2);
      return { op: 'and', args: [wide(l), wide(n - l)] };
    };
    const p64 = programWith({ op: 'not', arg: wide(32) } as Expr); // 63 + 1 = 64 nodes
    expect(decodeProgramDetail(encodeProgram(p64)).exprs[0]!.succ!.nodes).toBe(64);
    expectMalformed(() => encodeProgram(programWith({ op: 'not', arg: { op: 'not', arg: wide(32) } } as Expr)));
    expect(balanced(1)).toBe(x);
  });
  it('512 bytes ok, 513 rejected', () => {
    // 73 leaves (7 B) + 72 and-nodes (1 B) = 583 bytes > 512 — check via raw code instead.
    const code: number[] = [];
    // not × n + leaf: n + 7 bytes; depth too high, so use raw decodeExpr limits directly.
    for (let i = 0; i < 505; i++) code.push(0x03);
    code.push(...leaf(0x24, BALL));
    expect(code.length).toBe(512);
    expect(() => decodeExpr(Uint8Array.from(code), template().entities.map(() => ({ kind: 2 as const, param: 0 })))).toThrow(
      /depth|nodes/,
    );
    expectMalformed(() => decodeExpr(new Uint8Array(513), []));
  });
  it('condition: 32 nodes ok, 33 rejected', () => {
    const legs: LegExpr = { op: 'leg', id: 1 };
    let c: LegExpr = legs;
    // not-chain limited by depth 12; build a balanced-ish or tree of leg refs
    const tree = (n: number): LegExpr => (n === 1 ? legs : { op: 'or', args: [tree(Math.floor(n / 2)), tree(n - Math.floor(n / 2))] });
    c = { op: 'not', arg: tree(16) } as LegExpr; // 31 + 1 = 32
    const p = template();
    p.outcome.condition = c;
    expect(() => encodeProgram(p)).not.toThrow();
    p.outcome.condition = { op: 'not', arg: c } as LegExpr;
    expectMalformed(() => encodeProgram(p));
  });
  it('P = 8 and E = 16 and L = 8 accepted', () => {
    const p = template();
    p.participants = Array.from({ length: 8 }, (_, i) => pk(`p${i}`));
    p.sides = [0, 1, 1, 1, 1, 1, 1, 1];
    for (let i = p.entities.length; i < 16; i++) p.entities.push({ name: `o${i}`, kind: 'object', phrase: 'thing' });
    p.legs = Array.from({ length: 8 }, (_, i) => ({ ...template().legs[0]!, id: i + 1 }));
    const dp = decodeProgram(encodeProgram(p));
    expect([dp.P, dp.entities.length, dp.legs.length, dp.side_b_mask]).toEqual([8, 16, 8, 0xfe]);
  });
  it('P = 9, P = 1, E = 17, L = 9 rejected', () => {
    const p = template();
    p.participants = Array.from({ length: 9 }, (_, i) => pk(`p${i}`));
    p.sides = [0, 1, 1, 1, 1, 1, 1, 1, 1];
    expectMalformed(() => encodeProgram(p));
    const q = template();
    q.participants = [CREATOR];
    q.sides = [0];
    expectMalformed(() => encodeProgram(q));
    const r = template();
    for (let i = r.entities.length; i < 17; i++) r.entities.push({ name: `o${i}`, kind: 'object', phrase: 'thing' });
    expectMalformed(() => encodeProgram(r));
    const s = template();
    s.legs = Array.from({ length: 9 }, (_, i) => ({ ...template().legs[0]!, id: i + 1 }));
    expectMalformed(() => encodeProgram(s));
  });
});

describe('program_bin decoder rejections (§5.1) → MalformedProgram', () => {
  const good = encodeProgram(template());
  const { mask, ents, L, leg0 } = layout(good);

  it('the template itself decodes', () => {
    expect(() => decodeProgram(good)).not.toThrow();
    expect(() => decodeProgram(withSuccess(leaf(0x24, BALL)))).not.toThrow();
    expect(() => decodeProgram(withCond([0x50, 1]))).not.toThrow();
  });

  it('bad magic, version, kind, fps', () => {
    expectMalformed(() => decodeProgram(mutate(good, 0, 0x57)));
    expectMalformed(() => decodeProgram(mutate(good, 4, 1)));
    expectMalformed(() => decodeProgram(mutate(good, 4, 3)));
    expectMalformed(() => decodeProgram(mutate(good, 5, 3)));
    expectMalformed(() => decodeProgram(mutate(good, 6, 30)));
  });

  it('kind mismatch: rules legs in an ai_judged / market program', () => {
    expectMalformed(() => decodeProgram(mutate(good, 5, 1)));
    expectMalformed(() => decodeProgram(mutate(good, 5, 2)));
  });

  it('unknown codes', () => {
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x17, BALL))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x26, BALL))));
    expectMalformed(() => decodeProgram(withSuccess([0x07, ...leaf(0x24, BALL)])));
    expectMalformed(() => decodeProgram(withSuccess([0x00])));
    expectMalformed(() => decodeProgram(mutate(good, ents, 5))); // entity kind 5
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 2, 6))); // rule_kind 6
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 2, 5))); // market rule in rules program
  });

  it('codes in the wrong context', () => {
    expectMalformed(() => decodeProgram(withSuccess([0x50, 1])));
    expectMalformed(() => decodeProgram(withSuccess([0x51])));
    expectMalformed(() => decodeProgram(withCond([0x51])));
    expectMalformed(() => decodeProgram(withCond(leaf(0x24, BALL))));
    expectMalformed(() => decodeProgram(withCond([0x04, 1, 0, 0x50, 1, 0x50, 1])));
    expectMalformed(() => decodeProgram(withCond([0x01, 0x50, 1, 0x51])));
    const ai = encodeProgram(aiJudged());
    expectMalformed(() => decodeProgram(Uint8Array.from([...ai.slice(0, ai.length - 3), 2, 0, 0x50, 1])));
    expectMalformed(() => decodeProgram(Uint8Array.from([...ai.slice(0, ai.length - 3), 2, 0, 0x03, 0x51])));
  });

  it('refs ≥ E, reserved ref bits, unknown sub-region code', () => {
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x24, 6))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x24, 15))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x10, BALL, 0x40 | CAN))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x10, BALL, 0x30 | CAN))));
  });

  it('sub-region on a non-object or on a', () => {
    expect(() => decodeProgram(withSuccess(leaf(0x10, BALL, 0x10 | CAN)))).not.toThrow();
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x10, BALL, 0x10 | ZONE))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x10, BALL, 0x20 | CROWD))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x24, 0x10 | BALL))));
  });

  it('operand kinds (§2.7)', () => {
    // a must be person/person_any/object
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x24, ZONE))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x10, LINE, BALL))));
    // behind/beyond/crosses need a line
    for (const op of [0x15, 0x16, 0x34]) {
      expect(() => decodeProgram(withSuccess(leaf(op, BALL, LINE)))).not.toThrow();
      expectMalformed(() => decodeProgram(withSuccess(leaf(op, BALL, ZONE))));
      expectMalformed(() => decodeProgram(withSuccess(leaf(op, BALL, CAN))));
    }
    // no other primitive takes a line
    for (const op of [0x10, 0x11, 0x12, 0x13, 0x14, 0x30, 0x31, 0x32, 0x33, 0x35]) {
      expectMalformed(() => decodeProgram(withSuccess(leaf(op, BALL, LINE))));
    }
    // enters/leaves: zone, sub-region or object, not persons
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x30, BALL, CROWD))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x31, BALL, SHOOTER), true)));
    // disappears_into: .opening or zone only
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x32, BALL, CAN))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x32, BALL, 0x20 | CAN))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x32, BALL, CROWD))));
    // released_by: person / person_any
    expect(() => decodeProgram(withSuccess(leaf(0x35, BALL, SHOOTER), true))).not.toThrow();
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x35, BALL, CAN))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x35, BALL, ZONE))));
    // standing / rep_count: a person
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x40, BALL))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x41, CAN, 0, 5))));
    expect(() => decodeProgram(withSuccess(leaf(0x40, CROWD)))).not.toThrow();
  });

  it('parameter ranges', () => {
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x14, BALL, CAN, 14144))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x14, BALL, CAN, -1))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x21, BALL, 0, 0))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x21, BALL, 0, 36001))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x22, BALL, 6, 10))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x22, BALL, 0, 100001))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x22, BALL, 0, -5))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x23, BALL, 4))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x41, CROWD, 0, 1001))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x41, CROWD, 6, 1))));
    const x = leaf(0x24, BALL);
    expectMalformed(() => decodeProgram(withSuccess([0x04, 0, 0, ...x, ...x])));
    expectMalformed(() => decodeProgram(withSuccess([0x04, ...u16le(36001), ...x, ...x])));
    expectMalformed(() => decodeProgram(withSuccess([0x05, 0, 0, ...x])));
    expectMalformed(() => decodeProgram(withSuccess([0x06, ...i32le(36001), ...x])));
    expectMalformed(() => decodeProgram(withSuccess([0x06, ...i32le(0), ...x])));
    expect(() => decodeProgram(withSuccess([0x06, ...i32le(36000), ...x]))).not.toThrow();
    expect(() => decodeProgram(withSuccess([0x05, ...u16le(36000), ...x]))).not.toThrow();
  });

  it('non-zero unused fields', () => {
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x24, BALL, 0, 1))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x20, BALL, 1, 0))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x23, BALL, 1, 1))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x10, BALL, CAN, 1))));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x40, CROWD, 1, 0))));
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 1, 0x04))); // leg flags bit 2
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 1, 0x80)));
    expectMalformed(() => decodeProgram(mutate(good, ents + 2 * BALL + 1, 1))); // object param
    expectMalformed(() => decodeProgram(mutate(good, ents + 2 * CROWD + 1, 1))); // person_any param
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 3, 1))); // rule_cmp on exists
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 4, 1))); // rule_k on exists
    expectMalformed(() => decodeProgram(mutate(good, leg0 + 6, 1))); // rule_n on exists
  });

  it('leg ids: unknown in condition, duplicate, unordered, out of range', () => {
    expectMalformed(() => decodeProgram(withCond([0x50, 2])));
    expectMalformed(() => decodeProgram(withCond([0x50, 0])));
    const two = template();
    two.legs.push({ ...two.legs[0]!, id: 2 });
    const bin = encodeProgram(two);
    const legLen = 12 + 2 + 2 + 7;
    expectMalformed(() => decodeProgram(mutate(bin, leg0 + legLen, 1))); // duplicate id
    const swapped = mutate(mutate(bin, leg0, 2), leg0 + legLen, 1);
    expectMalformed(() => decodeProgram(swapped)); // unordered
    expectMalformed(() => decodeProgram(mutate(good, leg0, 0)));
    expectMalformed(() => decodeProgram(mutate(good, leg0, 9)));
    const p = template();
    p.legs[0]!.id = 8;
    p.outcome.condition = { op: 'leg', id: 8 };
    expect(decodeProgram(encodeProgram(p)).legs[0]!.id).toBe(8);
  });

  it('two person entities with the same participant; participant ≥ P', () => {
    const p = template();
    p.entities.push({ name: 'other', kind: 'person', participant: 1 });
    expectMalformed(() => encodeProgram(p));
    expectMalformed(() => decodeProgram(mutate(good, ents + 1, 2)));
    const q = template();
    q.entities.push({ name: 'boss', kind: 'person', participant: 0 });
    expect(() => encodeProgram(q)).not.toThrow();
  });

  it('side_b_mask: bit 0, zero, bits ≥ P', () => {
    expectMalformed(() => decodeProgram(mutate(good, mask, 0b11)));
    expectMalformed(() => decodeProgram(mutate(good, mask, 0)));
    expectMalformed(() => decodeProgram(mutate(good, mask, 0b110)));
    expectMalformed(() => decodeProgram(mutate(good, mask, 0x80)));
  });

  it('length mismatches, truncation and trailing bytes', () => {
    expectMalformed(() => decodeProgram(Uint8Array.from([...good, 0])));
    for (const cut of [0, 3, 8, 43, 44, mask, L, leg0 + 5, good.length - 1]) {
      expectMalformed(() => decodeProgram(good.slice(0, cut)));
    }
    // succ_len one too long / too short
    const s = good.slice();
    s[leg0 + 14] = 8;
    expectMalformed(() => decodeProgram(s));
    s[leg0 + 14] = 6;
    expectMalformed(() => decodeProgram(s));
    // trailing bytes inside an expression
    expectMalformed(() => decodeProgram(withSuccess([...leaf(0x24, BALL), 0])));
    // cond_len too long
    expectMalformed(() => decodeProgram(withCond([0x50, 1, 0])));
    expectMalformed(() => decodeProgram(withCond([])));
    expectMalformed(() => decodeProgram(withSuccess([])));
  });

  it('actor_bound flag must match person references', () => {
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x40, SHOOTER), false)));
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x24, BALL), true)));
    // person_any does not make a leg actor-bound
    expectMalformed(() => decodeProgram(withSuccess(leaf(0x40, CROWD), true)));
    const p = paperBall();
    p.legs[0]!.actor_bound = false;
    expectMalformed(() => encodeProgram(p));
  });

  it('rule consistency: valid_attempt ⇔ count within attempts; ranges', () => {
    const x: Expr = { op: 'present', a: { e: 'ball' } };
    const base = template();
    const ok = (over: Partial<Program['legs'][number]>): Program => ({ ...base, legs: [{ ...base.legs[0]!, ...over }] });
    expect(() => encodeProgram(ok({ valid_attempt: x, rule: { kind: 'count', cmp: '>=', k: 1, attempts: 20 } }))).not.toThrow();
    expectMalformed(() => encodeProgram(ok({ valid_attempt: x, rule: { kind: 'count', cmp: '>=', k: 1, attempts: 21 } })));
    expectMalformed(() => encodeProgram(ok({ valid_attempt: x, rule: { kind: 'count', cmp: '>=', k: 1, attempts: 0 } })));
    expectMalformed(() => encodeProgram(ok({ rule: { kind: 'count', cmp: '>=', k: 1, attempts: 3 } })));
    expectMalformed(() => encodeProgram(ok({ valid_attempt: x, rule: { kind: 'exists' } })));
    expect(() => encodeProgram(ok({ rule: { kind: 'count', cmp: '==', k: 1000, attempts: 0 } }))).not.toThrow();
    expectMalformed(() => encodeProgram(ok({ rule: { kind: 'count', cmp: '==', k: 1001, attempts: 0 } })));
    expect(() => encodeProgram(ok({ rule: { kind: 'holds', frames: 1200 } }))).not.toThrow();
    expectMalformed(() => encodeProgram(ok({ rule: { kind: 'holds', frames: 1201 } })));
    expectMalformed(() => encodeProgram(ok({ rule: { kind: 'before', frames: 0 } })));
    expect(() => encodeProgram(ok({ rule: { kind: 'never' } }))).not.toThrow();
    expectMalformed(() => encodeProgram(ok({ attempt_window_frames: 0 })));
    expectMalformed(() => encodeProgram(ok({ attempt_window_frames: 36001 })));
    // actor-bound legs: attempts ≤ 8
    const pb = paperBall();
    pb.legs[0]!.rule = { kind: 'count', cmp: '>=', k: 1, attempts: 8 };
    expect(() => encodeProgram(pb)).not.toThrow();
    pb.legs[0]!.rule = { kind: 'count', cmp: '>=', k: 1, attempts: 9 };
    expectMalformed(() => encodeProgram(pb));
    // bad cmp code byte
    const cbin = encodeProgram(ok({ rule: { kind: 'count', cmp: '>=', k: 1, attempts: 0 } }));
    expectMalformed(() => decodeProgram(mutate(cbin, leg0 + 3, 6)));
  });

  it('stakes: equal for rules, in range', () => {
    const p = template();
    p.stake_each = 9999;
    expectMalformed(() => encodeProgram(p));
    p.stake_each = 1_000_000_000_000;
    expect(decodeProgram(encodeProgram(p)).stakes).toEqual([1e12, 1e12]);
    p.stake_each = 1_000_000_000_001;
    expectMalformed(() => encodeProgram(p));
    const stakeOff = 44 + 32 * 2;
    expectMalformed(() => decodeProgram(mutate(good, stakeOff, good[stakeOff]! + 1)));
    const m = marketProgram();
    m.stakes = [10000, 9999];
    expectMalformed(() => encodeProgram(m));
  });

  it('outcome sides', () => {
    expectMalformed(() => decodeProgram(mutate(good, good.length - 6, 0))); // if_true == else
    expectMalformed(() => decodeProgram(mutate(good, good.length - 6, 2)));
  });

  it('duplicate participants are a compile-time error only (decoder accepts, as crates/verdict-rules)', () => {
    const p = template();
    p.participants = [CREATOR, CREATOR];
    const bin = encodeProgram(p);
    expect(decodeProgram(bin).participants).toEqual([CREATOR, CREATOR]);
  });

  it('ai_judged with legs, rules with no legs', () => {
    const p = aiJudged();
    p.legs = template().legs;
    expectMalformed(() => encodeProgram(p));
    const q = template();
    q.legs = [];
    expectMalformed(() => encodeProgram(q));
  });

  it('market leg field rules', () => {
    const bin = encodeProgram(marketProgram());
    const { leg0: m0 } = layout(bin);
    expectMalformed(() => decodeProgram(mutate(bin, m0 + 2, 0))); // rules rule_kind in market program
    expectMalformed(() => decodeProgram(mutate(bin, m0 + 4, 2))); // expected result 2
    expectMalformed(() => decodeProgram(mutate(bin, m0 + 3, 1))); // cmp
    expectMalformed(() => decodeProgram(mutate(bin, m0 + 6, 1))); // rule_n
    expectMalformed(() => decodeProgram(mutate(bin, m0 + 14, 31))); // succ_len != 32
  });
});

describe('expression helpers', () => {
  it('encodeExpr rejects unknown entities with MalformedProgram', () => {
    expectMalformed(() => encodeExpr({ op: 'present', a: { e: 'nope' } }, new Map()));
  });
  it('decodeCond for ai_judged requires exactly 0x51', () => {
    expect(decodeCond(Uint8Array.of(0x51), [], true).cond).toEqual({ code: 0x51 });
    expectMalformed(() => decodeCond(Uint8Array.of(0x51, 0), [], true));
  });
  it('EngineError helpers', () => {
    const e = new EngineError('MalformedProgram', 'x');
    expect(isEngineError(e)).toBe(true);
    expect(isEngineError(e, 'MalformedTracks')).toBe(false);
    expect(e.message).toBe('MalformedProgram: x');
  });
});
