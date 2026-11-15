/**
 * testvectors/fuzz.jsonl (§0.6): seeded random valid programs, calibrations
 * and track buffers within all limits. Each line:
 *   {"case": i, "program_bin", "calibration_bin", "track_bin", "verified", "opts"?, "expected"}
 * For market programs the third part (`track_bin`) holds a market_bin.
 */
import bs58 from 'bs58';
import {
  AI_JUDGED_TRACK_FLAGS,
  FPS,
  MAX_EVAL_COST,
  TAIL_FRAMES,
  TRACK_FLAG_AUDIO_DISAGREE,
  TRACK_FLAG_CAMERA_MOTION,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_PHONE_DISAGREE,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
} from '../../src/constants.js';
import { decodeProgram, encodeCalibration, encodeMarketBin, encodeProgram, encodeTrackBin, isEngineError } from '../../src/encode/index.js';
import { evaluate } from '../../src/eval/index.js';
import { marketHash, sha256 } from '../../src/hash/index.js';
import { Prng } from '../../src/perception/simulate/prng.js';
import type {
  Calibration,
  Checkpoint,
  Cmp,
  Entity,
  EvalOptions,
  Expr,
  Leg,
  LegExpr,
  MarketBinEntry,
  Program,
  QFrame,
  Ref,
  Rule,
  TrackBufferData,
  TrackSegment,
} from '../../src/types.js';
import { expectedOf, hex, VECTOR_MODEL_HASH } from './common.js';

const CMPS: Cmp[] = ['>=', '>', '<=', '<', '==', '!='];
const DIRS = ['up', 'down', 'left', 'right'] as const;
const REL_STATE = ['overlaps', 'inside', 'above', 'below'] as const;
/** Unit vectors ×1000 at 45° steps (integer, platform-independent). */
const UNIT8: [number, number][] = [
  [1000, 0],
  [707, 707],
  [0, 1000],
  [-707, 707],
  [-1000, 0],
  [-707, -707],
  [0, -1000],
  [707, -707],
];
const KEYS = Array.from({ length: 8 }, (_, i) => bs58.encode(sha256(new TextEncoder().encode(`VERDICT/FUZZ/key/${i}`))));

class Gen {
  constructor(readonly r: Prng) {}
  int(lo: number, hi: number): number {
    return this.r.int(lo, hi);
  }
  chance(pct: number): boolean {
    return this.r.int(0, 99) < pct;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.r.int(0, xs.length - 1)]!;
  }
}

// ---------------------------------------------------------------------------
// Programs

interface Scene {
  entities: Entity[];
  actors: number[]; // a-operand candidates: person / person_any / object
  bodies: number[]; // person / person_any
  objects: number[];
  lines: number[];
  zones: number[];
}

function genEntities(g: Gen, P: number): Scene {
  const entities: Entity[] = [];
  const nObj = g.int(1, 4);
  for (let i = 0; i < nObj; i++) entities.push({ name: `obj${i}`, kind: 'object', phrase: `thing ${i}` });
  if (g.chance(50)) entities.push({ name: 'anyone', kind: 'person_any' });
  const nPersons = g.chance(45) ? g.int(1, Math.min(2, P)) : 0;
  const used = new Set<number>();
  for (let i = 0; i < nPersons; i++) {
    let pi = g.int(0, P - 1);
    while (used.has(pi)) pi = (pi + 1) % P;
    used.add(pi);
    entities.push({ name: `who${i}`, kind: 'person', participant: pi });
  }
  if (g.chance(50)) entities.push({ name: 'mark', kind: 'region', shape: 'line' });
  if (g.chance(60)) entities.push({ name: 'area', kind: 'region', shape: 'zone' });
  // shuffle declaration order (entity indices matter for the encodings)
  for (let i = entities.length - 1; i > 0; i--) {
    const j = g.int(0, i);
    [entities[i], entities[j]] = [entities[j]!, entities[i]!];
  }
  const idx = (pred: (e: Entity) => boolean) => entities.flatMap((e, i) => (pred(e) ? [i] : []));
  return {
    entities,
    actors: idx((e) => e.kind !== 'region'),
    bodies: idx((e) => e.kind === 'person' || e.kind === 'person_any'),
    objects: idx((e) => e.kind === 'object'),
    lines: idx((e) => e.kind === 'region' && e.shape === 'line'),
    zones: idx((e) => e.kind === 'region' && e.shape === 'zone'),
  };
}

function genLeaf(g: Gen, s: Scene): Expr {
  const name = (i: number) => s.entities[i]!.name;
  const a = g.pick(s.actors);
  const aRef: Ref = { e: name(a) };
  const others = (xs: number[]) => xs.filter((x) => x !== a);
  /** b: non-line entity or object sub-region */
  const anyB = (): Ref | null => {
    const opts = others([...s.actors, ...s.zones]);
    const subs = others(s.objects);
    if (subs.length && g.chance(25)) return { e: name(g.pick(subs)), sub: g.pick(['opening', 'interior'] as const) };
    return opts.length ? { e: name(g.pick(opts)) } : null;
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    switch (g.int(0, 15)) {
      case 0: {
        const b = anyB();
        if (b) return { op: g.pick(REL_STATE), a: aRef, b };
        break;
      }
      case 1: {
        const b = anyB();
        if (b) return { op: 'near', a: aRef, b, dist: g.chance(10) ? g.pick([0, 14143]) : g.int(0, 3000) };
        break;
      }
      case 2:
        if (s.lines.length) return { op: g.pick(['behind', 'beyond', 'crosses'] as const), a: aRef, b: { e: name(g.pick(s.lines)) } };
        break;
      case 3: {
        const bs: Ref[] = [...s.zones.map((z) => ({ e: name(z) })), ...others(s.objects).map((o) => ({ e: name(o) }))];
        for (const o of others(s.objects)) bs.push({ e: name(o), sub: g.pick(['opening', 'interior'] as const) });
        if (bs.length) return { op: g.pick(['enters', 'leaves'] as const), a: aRef, b: g.pick(bs) };
        break;
      }
      case 4: {
        const bs: Ref[] = [...s.zones.map((z) => ({ e: name(z) })), ...others(s.objects).map((o) => ({ e: name(o), sub: 'opening' as const }))];
        if (bs.length) return { op: 'disappears_into', a: aRef, b: g.pick(bs) };
        break;
      }
      case 5: {
        const b = anyB();
        if (b) return { op: 'touches', a: aRef, b };
        break;
      }
      case 6: {
        const bs = others(s.bodies);
        if (bs.length) return { op: 'released_by', a: aRef, b: { e: name(g.pick(bs)) } };
        break;
      }
      case 7:
        return { op: g.pick(['moving', 'present', 'intact'] as const), a: aRef };
      case 8:
        return { op: 'at_rest', a: aRef, frames: g.int(1, 15) };
      case 9:
        return { op: 'speed', a: aRef, cmp: g.pick(CMPS), value: g.chance(10) ? 100000 : g.int(0, 3000) };
      case 10:
        return { op: 'direction', a: aRef, dir: g.pick(DIRS) };
      case 11:
      case 12:
        if (s.bodies.length) {
          const b = { e: name(g.pick(s.bodies)) };
          return g.chance(50) ? { op: 'standing', a: b } : { op: 'rep_count', a: b, cmp: g.pick(CMPS), value: g.int(0, 4) };
        }
        break;
      default: {
        const b = anyB();
        if (b) return { op: 'overlaps', a: aRef, b };
      }
    }
  }
  return { op: 'present', a: aRef };
}

function genExpr(g: Gen, s: Scene, depth: number, limitFrames: number): Expr {
  if (depth <= 1 || g.chance(40)) return genLeaf(g, s);
  const sub = () => genExpr(g, s, depth - 1, limitFrames);
  switch (g.int(0, 9)) {
    case 0:
    case 1:
    case 2:
      return { op: 'and', args: [sub(), sub()] };
    case 3:
    case 4:
      return { op: 'or', args: [sub(), sub()] };
    case 5:
      return { op: 'not', arg: sub() };
    case 6:
      return { op: 'then_within', frames: g.int(1, 20), first: sub(), then: sub() };
    case 7:
      return { op: 'for_duration', frames: g.int(1, 8), arg: sub() };
    case 8:
      return { op: 'before', frames: g.int(1, limitFrames + TAIL_FRAMES), arg: sub() };
    default:
      return genLeaf(g, s);
  }
}

function exprUsesPerson(x: Expr | undefined, s: Scene): boolean {
  if (!x) return false;
  const persons = new Set(s.entities.filter((e) => e.kind === 'person').map((e) => e.name));
  const walk = (n: Expr): boolean => {
    if (n.op === 'and' || n.op === 'or') return n.args.some(walk);
    if (n.op === 'not' || n.op === 'for_duration' || n.op === 'before') return walk(n.arg);
    if (n.op === 'then_within') return walk(n.first) || walk(n.then);
    const any = n as { a: Ref; b?: Ref };
    return persons.has(any.a.e) || (any.b !== undefined && persons.has(any.b.e));
  };
  return walk(x);
}

function genRule(g: Gen, limitFrames: number, actor: boolean, hasVa: boolean): Rule {
  if (hasVa) {
    const n = g.int(1, actor ? 8 : g.chance(10) ? 20 : 5);
    return actor ? { kind: 'count', cmp: g.pick(['>=', '>'] as const), k: g.int(1, 3), attempts: n } : { kind: 'count', cmp: g.pick(CMPS), k: g.int(0, 4), attempts: n };
  }
  switch (g.int(0, 4)) {
    case 0:
      return { kind: 'exists' };
    case 1:
      return actor ? { kind: 'exists' } : { kind: 'never' };
    case 2:
      return actor ? { kind: 'count', cmp: g.pick(['>=', '>'] as const), k: g.int(1, 4), attempts: 0 } : { kind: 'count', cmp: g.pick(CMPS), k: g.int(0, 4), attempts: 0 };
    case 3:
      return { kind: 'holds', frames: g.chance(30) ? limitFrames : g.int(1, Math.min(limitFrames, 60)) };
    default:
      return { kind: 'before', frames: g.int(1, limitFrames) };
  }
}

function genCond(g: Gen, ids: number[], depth: number): LegExpr {
  if (depth <= 1 || g.chance(45)) return { op: 'leg', id: g.pick(ids) };
  switch (g.int(0, 2)) {
    case 0:
      return { op: 'and', args: [genCond(g, ids, depth - 1), genCond(g, ids, depth - 1)] };
    case 1:
      return { op: 'or', args: [genCond(g, ids, depth - 1), genCond(g, ids, depth - 1)] };
    default:
      return { op: 'not', arg: genCond(g, ids, depth - 1) };
  }
}

function genParticipants(g: Gen): { participants: string[]; sides: (0 | 1)[] } {
  const P = g.chance(70) ? 2 : g.int(3, 8);
  const participants = KEYS.slice(0, P);
  const sides: (0 | 1)[] = [0];
  for (let i = 1; i < P; i++) sides.push(g.chance(50) ? 1 : 0);
  if (!sides.includes(1)) sides[P - 1] = 1;
  return { participants, sides };
}

function genRulesProgram(g: Gen): { p: Program; scene: Scene } {
  const { participants, sides } = genParticipants(g);
  const scene = genEntities(g, participants.length);
  const time_limit_s = g.chance(10) ? g.int(1, 4) : g.int(5, 30);
  const limitFrames = time_limit_s * FPS;
  const legs: Leg[] = [];
  const nLegs = g.int(1, 3);
  for (let i = 0; i < nLegs; i++) {
    const success = genExpr(g, scene, g.int(1, 4), limitFrames);
    const valid_attempt = g.chance(30) ? genExpr(g, scene, g.int(1, 3), limitFrames) : undefined;
    const actor = exprUsesPerson(success, scene) || exprUsesPerson(valid_attempt, scene);
    const leg: Leg = { id: i + 1, actor_bound: actor, attempt_window_frames: g.chance(20) ? g.int(1, 10) : g.int(10, 60) };
    if (valid_attempt) leg.valid_attempt = valid_attempt;
    leg.success = success;
    leg.rule = genRule(g, limitFrames, actor, valid_attempt !== undefined);
    legs.push(leg);
  }
  const if_true = g.int(0, 1) as 0 | 1;
  const p: Program = {
    version: 2,
    kind: 'rules',
    participants,
    sides,
    entities: scene.entities,
    legs,
    outcome: { if_true, condition: genCond(g, legs.map((l) => l.id), 4), else: (1 - if_true) as 0 | 1 },
    stake_each: g.pick([10_000, 1_000_000, 5_000_000, 1_000_000_000_000]),
    time_limit_s,
  };
  return { p, scene };
}

// ---------------------------------------------------------------------------
// Calibration and buffers

function genCalibration(g: Gen, p: Program): Calibration {
  const regions: Calibration['regions'] = [];
  for (const e of p.entities) {
    if (e.kind !== 'region') continue;
    if (e.shape === 'line') {
      const a: [number, number] = [g.int(2000, 8000), g.int(0, 10000)];
      let b: [number, number] = [g.int(2000, 8000), g.int(0, 10000)];
      if (b[0] === a[0] && b[1] === a[1]) b = [a[0], (a[1] + 1) % 10001];
      regions.push({ entity: e.name, shape: 'line', points: [a, b], behind_sign: g.chance(50) ? 1 : -1 });
    } else {
      const n = g.int(3, 8);
      const cx = g.int(2500, 7500);
      const cy = g.int(2500, 7500);
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        // roughly star-shaped around (cx, cy), occasionally on the frame border
        const r = g.chance(10) ? 10000 : g.int(800, 3500);
        const [ux, uy] = UNIT8[Math.floor((i * 8) / n)]!;
        const x = Math.max(0, Math.min(10000, cx + Math.trunc((r * ux) / 1000)));
        const y = Math.max(0, Math.min(10000, cy + Math.trunc((r * uy) / 1000)));
        pts.push([x, y]);
      }
      regions.push({ entity: e.name, shape: 'zone', points: pts });
    }
  }
  return { version: 1, scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs: [] }, regions };
}

/** Random walk of one entity over `n` positions. */
function genTrack(g: Gen, n: number, kind: Entity['kind']): (QFrame | null)[] {
  const out: (QFrame | null)[] = [];
  let cx = g.int(1000, 9000);
  let cy = g.int(1000, 9000);
  let vx = g.int(-300, 300);
  let vy = g.int(-300, 300);
  const w = kind === 'object' ? g.int(100, 1500) : g.int(800, 2500);
  const h = kind === 'object' ? g.int(100, 1500) : g.int(2000, 6000);
  const presence = g.int(60, 100);
  let phase = 0;
  for (let f = 0; f < n; f++) {
    if (g.chance(10)) {
      vx = g.int(-600, 600);
      vy = g.int(-600, 600);
    }
    if (g.chance(5)) {
      cx = g.int(1000, 9000);
      cy = g.int(1000, 9000);
    }
    cx = Math.max(0, Math.min(10000, cx + (g.chance(30) ? 0 : vx)));
    cy = Math.max(0, Math.min(10000, cy + (g.chance(30) ? 0 : vy)));
    if (!g.chance(presence)) {
      out.push(null);
      continue;
    }
    const x0 = Math.max(0, cx - (w >> 1));
    const y0 = Math.max(0, cy - (h >> 1));
    const x1 = Math.min(10000, cx + (w >> 1));
    const y1 = Math.min(10000, cy + (h >> 1));
    const conf = g.chance(8) ? g.int(1, 49) : g.int(50, 100);
    let pose = 0;
    let id_conf = 0;
    if (kind === 'person' || kind === 'person_any') {
      if (g.chance(60)) pose |= 1;
      phase = g.chance(70) ? phase : 1 - phase;
      if (g.chance(60)) pose |= phase ? 0b100 : 0b010;
    }
    if (kind === 'person') id_conf = g.chance(85) ? g.int(60, 100) : g.int(0, 59);
    out.push({ x0, y0, x1, y1, conf, fill: g.int(0, 100), id_conf, pose });
  }
  return out;
}

function genSegments(g: Gen, frameEnd: number): [number, number][] {
  const nSeg = g.chance(60) ? 1 : g.int(2, 4);
  const segs: [number, number][] = [];
  let cursor = g.chance(50) ? 0 : g.int(0, Math.max(0, Math.min(frameEnd - 1, 30)));
  for (let i = 0; i < nSeg && cursor < frameEnd; i++) {
    const len = Math.min(frameEnd - cursor, g.int(1, 40));
    segs.push([cursor, len]);
    cursor += len + g.int(1, 30);
  }
  return segs;
}

function genBuffer(g: Gen, p: Program): TrackBufferData {
  const dp = decodeProgram(encodeProgram(p));
  const frameEnd = p.time_limit_s * FPS + TAIL_FRAMES;
  let flags = TRACK_FLAG_CROSS_CHECK_OK;
  if (g.chance(5)) flags |= TRACK_FLAG_CAMERA_MOTION;
  if (g.chance(3)) flags &= ~TRACK_FLAG_CROSS_CHECK_OK;
  if (g.chance(10)) flags |= TRACK_FLAG_AUDIO_DISAGREE;
  if (g.chance(10)) flags |= TRACK_FLAG_PHONE_DISAGREE;
  const tracks = dp.tracked_entities.map((ei) => {
    const e = p.entities[ei]!;
    return { entity_idx: ei, participant_idx: e.kind === 'person' ? e.participant : null, ref_h: g.chance(30) ? 0 : g.int(500, 6000) };
  });
  if (g.chance(3)) return { flags: flags | TRACK_FLAG_WINDOW_UNAVAILABLE, model_hash: VECTOR_MODEL_HASH, tracks, segments: [] };
  const segs = genSegments(g, frameEnd);
  const total = segs.reduce((s, [, n]) => s + n, 0);
  const cols = tracks.map((t) => genTrack(g, total, p.entities[t.entity_idx]!.kind));
  const segments: TrackSegment[] = [];
  let pos = 0;
  for (const [frame_start, n] of segs) {
    const frames: (QFrame | null)[][] = [];
    for (let i = 0; i < n; i++, pos++) frames.push(cols.map((c) => c[pos] ?? null));
    segments.push({ frame_start, frames });
  }
  return { flags, model_hash: VECTOR_MODEL_HASH, tracks, segments };
}

// ---------------------------------------------------------------------------
// Other kinds

function genAiJudged(g: Gen): { p: Program; c: null; third: Uint8Array } {
  const { participants, sides } = genParticipants(g);
  const if_true = g.int(0, 1) as 0 | 1;
  const p: Program = {
    version: 2,
    kind: 'ai_judged',
    participants,
    sides,
    entities: [],
    legs: [],
    question: `Fuzz question ${g.int(0, 1_000_000)}?`,
    outcome: { if_true, condition: { op: 'yes' }, else: (1 - if_true) as 0 | 1 },
    stake_each: 1_000_000,
    time_limit_s: g.int(1, 3600),
  };
  const flags = g.chance(70) ? AI_JUDGED_TRACK_FLAGS : g.int(0, 31) & ~TRACK_FLAG_WINDOW_UNAVAILABLE;
  return { p, c: null, third: encodeTrackBin({ flags, model_hash: '00'.repeat(32), tracks: [], segments: [] }) };
}

function genMarket(g: Gen): { p: Program; c: null; third: Uint8Array } {
  const n = g.int(1, 4);
  const legs: Leg[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const event_id = `EV-${g.int(0, 99)}`;
    const contract_id = `C${i}`;
    hashes.push(marketHash(event_id, contract_id));
    legs.push({
      id: i + 1,
      actor_bound: false,
      attempt_window_frames: 0,
      market: { venue: 'gemini', event_id, contract_id, side: g.chance(50) ? 'yes' : 'no', prob_bps: g.int(0, 10000) },
    });
  }
  let cond: LegExpr = { op: 'leg', id: 1 };
  for (let i = 2; i <= n; i++) cond = { op: 'and', args: [cond, { op: 'leg', id: i }] };
  if (g.chance(30)) cond = genCond(g, legs.map((l) => l.id), 3);
  const p: Program = {
    version: 2,
    kind: 'market',
    participants: KEYS.slice(0, 2),
    sides: [0, 1],
    entities: [],
    legs,
    outcome: { if_true: 0, condition: cond, else: 1 },
    stakes: [g.int(10_000, 50_000_000), g.int(10_000, 50_000_000)],
    time_limit_s: g.int(1, 2_592_000),
  };
  const entries: MarketBinEntry[] = [];
  for (const h of hashes) if (!g.chance(10)) entries.push({ market_hash: h, result: g.pick([0, 1, 1, 0, 2] as const) });
  if (g.chance(20)) entries.push({ market_hash: marketHash('EXTRA', `${g.int(0, 9)}`), result: g.int(0, 2) as 0 | 1 | 2 });
  return { p, c: null, third: encodeMarketBin(entries) };
}

// ---------------------------------------------------------------------------

function sampleVerified(g: Gen, cps: Checkpoint[]): Checkpoint[] {
  const out = cps.filter(() => g.chance(85));
  if (g.chance(10)) out.push({ participant: g.int(0, 7), frame: g.int(0, 500) });
  return out;
}

export function fuzzCase(g: Gen, i: number): Record<string, unknown> {
  const roll = g.int(0, 99);
  let programBin: Uint8Array;
  let calibrationBin: Uint8Array;
  let third: Uint8Array;
  if (roll < 4) {
    const a = genAiJudged(g);
    programBin = encodeProgram(a.p);
    calibrationBin = encodeCalibration(null, a.p);
    third = a.third;
  } else if (roll < 10) {
    const m = genMarket(g);
    programBin = encodeProgram(m.p);
    calibrationBin = encodeCalibration(null, m.p);
    third = m.third;
  } else {
    // retry until the random program is within every decoder limit
    for (;;) {
      const { p } = genRulesProgram(g);
      try {
        programBin = encodeProgram(p);
      } catch (e) {
        if (isEngineError(e)) continue;
        throw e;
      }
      calibrationBin = encodeCalibration(genCalibration(g, p), p);
      third = encodeTrackBin(genBuffer(g, p));
      break;
    }
  }
  let opts: EvalOptions | undefined;
  if (g.chance(8)) opts = { maxCost: g.chance(50) ? Infinity : g.int(0, MAX_EVAL_COST) };
  const first = evaluate(programBin, calibrationBin, third, [], opts);
  const verified = first.checkpoints.length ? sampleVerified(g, first.checkpoints) : g.chance(5) ? [{ participant: 0, frame: 0 }] : [];
  const r = evaluate(programBin, calibrationBin, third, verified, opts);
  const line: Record<string, unknown> = {
    case: i,
    program_bin: hex(programBin),
    calibration_bin: hex(calibrationBin),
    track_bin: hex(third),
    verified,
  };
  if (opts) line.opts = { maxCost: opts.maxCost === Infinity ? null : opts.maxCost };
  line.expected = expectedOf(r);
  return line;
}

export function buildFuzzLines(seed: number, cases: number): string {
  const g = new Gen(new Prng(seed));
  const lines: string[] = [];
  for (let i = 0; i < cases; i++) lines.push(JSON.stringify(fuzzCase(g, i)));
  return `${lines.join('\n')}\n`;
}
