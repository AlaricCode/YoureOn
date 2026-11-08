/**
 * Shared helpers for the golden test-vector generator (§0.6).
 *
 * Every vector is computed by the engine itself (`encode*` + `evaluate`), then
 * checked against the case's stated intent, so a vector can never silently
 * encode a result the case author did not mean.
 */
import bs58 from 'bs58';
import {
  FPS,
  TRACK_FLAG_CROSS_CHECK_OK,
} from '../../src/constants.js';
import {
  calibrationHash,
  decodeProgram,
  encodeCalibration,
  encodeMarketBin,
  encodeProgram,
  encodeTrackBin,
  isEngineError,
  programHash,
} from '../../src/encode/index.js';
import { evaluate } from '../../src/eval/index.js';
import { bytesToHex, canonicalJson, jsonHash, sha256 } from '../../src/hash/index.js';
import { parseYaml, readback, toYaml, validateProgram } from '../../src/lang/index.js';
import type {
  Calibration,
  Checkpoint,
  CompileContext,
  EvalOptions,
  EvalResult,
  Expr,
  Leg,
  MarketBinEntry,
  Program,
  QFrame,
  ReadbackContext,
  TrackBufferData,
  TrackSegment,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Keys and contexts

function key(tag: string): string {
  return bs58.encode(sha256(new TextEncoder().encode(`VERDICT/TESTVECTOR/${tag}`)));
}

export const CREATOR = key('creator');
export const FRIEND = key('friend');
export const THIRD = key('third');
export const FOURTH = key('fourth');
export const NON_MEMBER = key('non-member');

export const NAMES: Record<string, string> = { [CREATOR]: 'Alex', [FRIEND]: 'Maya', [THIRD]: 'Sam', [FOURTH]: 'Jo' };

/** Compile context of the worked examples: creator + friend, both enrolled and confirmed. */
export const CTX2: CompileContext = {
  creator: CREATOR,
  huddle: [
    { wallet: CREATOR, display_name: 'Alex', enrolled: true },
    { wallet: FRIEND, display_name: 'Maya', enrolled: true },
  ],
};

/** Four enrolled members (multi-participant cases). */
export const CTX4: CompileContext = {
  creator: CREATOR,
  huddle: [
    { wallet: CREATOR, display_name: 'Alex', enrolled: true },
    { wallet: FRIEND, display_name: 'Maya', enrolled: true },
    { wallet: THIRD, display_name: 'Sam', enrolled: true },
    { wallet: FOURTH, display_name: 'Jo', enrolled: true },
  ],
};

/** Fixed model hash of hand-built buffers. */
export const VECTOR_MODEL_HASH = bytesToHex(sha256(new TextEncoder().encode('VERDICT/TESTVECTOR/model')));

// ---------------------------------------------------------------------------
// Records and buffers

/** A present record (conf 90 unless overridden). */
export function rec(x0: number, y0: number, x1: number, y1: number, extra: Partial<QFrame> = {}): QFrame {
  return { x0, y0, x1, y1, conf: 90, fill: 0, id_conf: 0, pose: 0, ...extra };
}

/** A square record centered at (cx, cy) with half-size h. */
export function box(cx: number, cy: number, h = 100, extra: Partial<QFrame> = {}): QFrame {
  return rec(cx - h, cy - h, cx + h, cy + h, extra);
}

export type Col = (QFrame | null)[];

/** `n` copies of a record (or of null). */
export function rep(r: QFrame | null, n: number): Col {
  return Array.from({ length: n }, () => (r ? { ...r } : null));
}

/** Column built frame by frame. */
export function col(n: number, fn: (i: number) => QFrame | null): Col {
  return Array.from({ length: n }, (_, i) => fn(i));
}

export interface BufferSpec {
  /** entity name → column over all buffer positions (segment-major) */
  cols: Record<string, Col>;
  /** `[frame_start, n_frames]` per segment; default one segment from 0 covering the longest column */
  segs?: [number, number][];
  flags?: number;
  /** entity name → ref_h (default: height at the first present frame, §6.2) */
  refH?: Record<string, number>;
  model_hash?: string;
}

/**
 * Build a TrackBufferData whose track table is exactly the program's tracked
 * entities (§5.4 [D-43]). Tracked entities without a column are all-absent.
 */
export function buffer(p: Program, spec: BufferSpec): TrackBufferData {
  const dp = decodeProgram(encodeProgram(p));
  for (const name of Object.keys(spec.cols)) {
    const ei = p.entities.findIndex((e) => e.name === name);
    if (ei < 0 || !dp.tracked_entities.includes(ei)) throw new Error(`buffer: ${name} is not a tracked entity`);
  }
  const n = Math.max(0, ...Object.values(spec.cols).map((c) => c.length));
  const segs = spec.segs ?? [[0, n]];
  const total = segs.reduce((s, [, len]) => s + len, 0);
  const tracks = dp.tracked_entities.map((ei) => {
    const e = p.entities[ei]!;
    const c = spec.cols[e.name] ?? [];
    const first = c.find((r) => r && r.conf >= 30);
    return {
      entity_idx: ei,
      participant_idx: e.kind === 'person' ? e.participant : null,
      ref_h: spec.refH?.[e.name] ?? (first ? first.y1 - first.y0 : 0),
    };
  });
  const segments: TrackSegment[] = [];
  let pos = 0;
  for (const [start, len] of segs) {
    const frames: (QFrame | null)[][] = [];
    for (let i = 0; i < len; i++, pos++) {
      frames.push(tracks.map((t) => spec.cols[p.entities[t.entity_idx]!.name]?.[pos] ?? null));
    }
    segments.push({ frame_start: start, frames });
  }
  if (pos !== total) throw new Error('buffer: segment arithmetic');
  return {
    flags: spec.flags ?? TRACK_FLAG_CROSS_CHECK_OK,
    model_hash: spec.model_hash ?? VECTOR_MODEL_HASH,
    tracks,
    segments,
  };
}

// ---------------------------------------------------------------------------
// Programs

export const ref = (e: string, sub?: 'opening' | 'interior') => (sub ? { e, sub } : { e });

export interface ProgSpec {
  entities: Program['entities'];
  legs: (Partial<Leg> & Pick<Leg, 'success' | 'rule'>)[];
  outcome?: Program['outcome'];
  time_limit_s?: number;
  participants?: string[];
  sides?: (0 | 1)[];
  stake_each?: number;
}

/** A canonical rules program with sensible defaults (leg ids 1.., actor_bound recomputed). */
export function prog(s: ProgSpec): Program {
  const persons = new Set(s.entities.filter((e) => e.kind === 'person').map((e) => e.name));
  const usesPerson = (x?: Expr): boolean => (x ? exprRefs(x).some((n) => persons.has(n)) : false);
  const legs: Leg[] = s.legs.map((l, i) => {
    const leg: Leg = {
      id: l.id ?? i + 1,
      actor_bound: usesPerson(l.valid_attempt) || usesPerson(l.success),
      attempt_window_frames: l.attempt_window_frames ?? 50,
    };
    if (l.valid_attempt) leg.valid_attempt = l.valid_attempt;
    leg.success = l.success;
    leg.rule = l.rule;
    return leg;
  });
  return {
    version: 2,
    kind: 'rules',
    participants: s.participants ?? [CREATOR, FRIEND],
    sides: s.sides ?? [0, 1],
    entities: s.entities,
    legs,
    outcome: s.outcome ?? { if_true: 0, condition: { op: 'leg', id: legs[0]!.id }, else: 1 },
    stake_each: s.stake_each ?? 1_000_000,
    time_limit_s: s.time_limit_s ?? 60,
  };
}

/** Entity names referenced by an expression. */
export function exprRefs(x: Expr): string[] {
  const out: string[] = [];
  const walk = (n: Expr): void => {
    const any = n as unknown as Record<string, unknown>;
    if (n.op === 'and' || n.op === 'or') return n.args.forEach(walk);
    if (n.op === 'not' || n.op === 'for_duration' || n.op === 'before') return walk(n.arg);
    if (n.op === 'then_within') return (walk(n.first), walk(n.then));
    for (const k of ['a', 'b']) {
      const r = any[k] as { e: string } | undefined;
      if (r) out.push(r.e);
    }
  };
  walk(x);
  return out;
}

/** Calibration with the given regions and no entity refs. */
export function calib(regions: Calibration['regions'] = [], entity_refs: Calibration['scene']['entity_refs'] = []): Calibration {
  return {
    version: 1,
    scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs },
    regions,
  };
}

/** Compile context whose huddle is exactly the program's participants (all enrolled). */
export function ctxFor(p: Program): CompileContext {
  return {
    creator: p.participants[0]!,
    huddle: p.participants.map((w, i) => ({ wallet: w, display_name: NAMES[w] ?? `Member ${i}`, enrolled: true })),
  };
}

// ---------------------------------------------------------------------------
// Vectors

export interface Intent {
  status?: EvalResult['status'];
  reason?: EvalResult['reason'];
  leg_results?: EvalResult['leg_results'];
  leg_causes?: EvalResult['leg_causes'];
  winner_mask?: number;
  n_checkpoints?: number;
  checkpoints?: Checkpoint[];
  decisive_frames?: number[][];
}

export interface CaseSpec {
  name: string;
  description: string;
  /** §0.6 coverage tags this case satisfies */
  covers?: string[];
  program: Program;
  calibration: Calibration | null;
  /** rules / ai_judged */
  buffer?: TrackBufferData;
  /** market */
  market?: MarketBinEntry[];
  verified?: Checkpoint[];
  opts?: EvalOptions;
  intent?: Intent;
  /** the program is deliberately invalid at compile time (decodable, e.g. > 8 checkpoints) */
  compileInvalid?: boolean;
  readbackCtx?: ReadbackContext;
}

export type VectorJson = Record<string, unknown>;

export function hex(b: Uint8Array): string {
  return bytesToHex(b);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Expected-result object of §0.6 (plus `attempts` and `cost` for TS consumers). */
export function expectedOf(r: EvalResult): VectorJson {
  return {
    status: r.status,
    reason: r.reason,
    leg_results: r.leg_results,
    leg_causes: r.leg_causes,
    preruling: r.preruling,
    winner_mask: r.winner_mask,
    n_checkpoints: r.n_checkpoints,
    checkpoints: r.checkpoints,
    decisive_frames: r.decisive_frames,
    attempts: r.attempts,
    cost: r.cost,
  };
}

export function checkIntent(name: string, r: EvalResult, intent: Intent | undefined): void {
  if (!intent) return;
  for (const [k, want] of Object.entries(intent)) {
    const got = (r as unknown as Record<string, unknown>)[k];
    if (!sameJson(got, want)) {
      throw new Error(`vector ${name}: ${k} = ${JSON.stringify(got)}, intended ${JSON.stringify(want)}\nfull result: ${JSON.stringify(r)}`);
    }
  }
}

function defaultReadbackCtx(p: Program, c: Calibration | null): ReadbackContext {
  const labels: Record<string, string> = {};
  for (const r of c?.scene.entity_refs ?? []) labels[r.entity] = r.label;
  return { names: NAMES, labels };
}

/** Build a full §0.6 vector from a case spec. */
export function makeVector(s: CaseSpec): VectorJson {
  const p = s.program;
  const v = validateProgram(p, ctxFor(p));
  const errorCodes = [...new Set(v.errors.map((e) => e.code))].sort();
  if (!s.compileInvalid && errorCodes.length) throw new Error(`vector ${s.name}: program does not validate: ${JSON.stringify(v.errors)}`);
  if (s.compileInvalid && !errorCodes.length) throw new Error(`vector ${s.name}: marked compileInvalid but validates`);
  const yaml = toYaml(p);
  if (!s.compileInvalid) {
    const back = parseYaml(yaml, ctxFor(p));
    if (!back.ok || !sameJson(canonicalJson(back.program), canonicalJson(p))) {
      throw new Error(`vector ${s.name}: parseYaml(toYaml(p)) does not round-trip: ${JSON.stringify(back)}`);
    }
  }
  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(s.calibration, p);
  const isMarket = p.kind === 'market';
  const third = isMarket ? encodeMarketBin(s.market ?? []) : encodeTrackBin(s.buffer ?? emptyBuffer());
  const verified = s.verified ?? [];
  const r = evaluate(programBin, calibrationBin, third, verified, s.opts);
  checkIntent(s.name, r, s.intent);
  const out: VectorJson = {
    name: s.name,
    description: s.description,
  };
  if (s.covers?.length) out.covers = s.covers;
  Object.assign(out, {
    program: p,
    yaml,
    readback: readback(p, s.readbackCtx ?? defaultReadbackCtx(p, s.calibration)),
    program_canonical_json: canonicalJson(p),
    json_hash: jsonHash(p),
    program_bin: hex(programBin),
    program_hash: programHash(p),
    calibration: s.calibration,
    calibration_bin: hex(calibrationBin),
    calibration_hash: calibrationHash(s.calibration, p),
  });
  if (errorCodes.length) out.compile_errors = errorCodes;
  if (isMarket) out.market_bin = hex(third);
  else out.track_bin = hex(third);
  out.verified_checkpoints = verified;
  if (s.opts) out.opts = { maxCost: s.opts.maxCost === Infinity ? null : (s.opts.maxCost ?? null) };
  out.expected = expectedOf(r);
  return out;
}

function emptyBuffer(): TrackBufferData {
  return { flags: TRACK_FLAG_CROSS_CHECK_OK, model_hash: VECTOR_MODEL_HASH, tracks: [], segments: [] };
}

/** A decoder-rejection vector: raw parts plus the expected §9.6 error. */
export function errorVector(
  name: string,
  description: string,
  parts: { program_bin: Uint8Array; calibration_bin: Uint8Array; track_bin?: Uint8Array; market_bin?: Uint8Array },
  error: string,
  covers?: string[],
): VectorJson {
  let got = 'ok';
  try {
    evaluate(parts.program_bin, parts.calibration_bin, parts.track_bin ?? parts.market_bin ?? new Uint8Array(0), []);
  } catch (e) {
    if (!isEngineError(e)) throw e;
    got = e.code;
  }
  if (got !== error) throw new Error(`error vector ${name}: evaluate gave ${got}, intended ${error}`);
  const out: VectorJson = { name, description };
  if (covers?.length) out.covers = covers;
  out.program_bin = hex(parts.program_bin);
  out.calibration_bin = hex(parts.calibration_bin);
  if (parts.market_bin) out.market_bin = hex(parts.market_bin);
  else out.track_bin = hex(parts.track_bin ?? new Uint8Array(0));
  out.verified_checkpoints = [];
  out.expected = { error };
  return out;
}

/** `frames → "{n}s"` helper for descriptions. */
export const secs = (frames: number): string => `${frames / FPS}s`;
