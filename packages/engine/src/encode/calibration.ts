/**
 * `calibration_bin` (magic "VCAL", §5.3) and `calibration_hash` (§4.2).
 *
 * Only `rules` programs have a calibration; for `ai_judged` / `market` the
 * calibration_bin is empty and calibration_hash is 32 zero bytes.
 */
import {
  CALIBRATION_MAGIC,
  CALIBRATION_VERSION,
  COORD_MAX,
  ENTITY_KIND_CODE,
  KIND_CODE,
  LINE_POINTS,
  SHAPE_CODE,
  ZONE_MAX_POINTS,
  ZONE_MIN_POINTS,
} from '../constants.js';
import { ZERO_HASH_HEX, bytesToHex } from '../hash/bytes.js';
import { CanonicalJsonError } from '../hash/canonicalJson.js';
import { sceneHashBytes } from '../hash/hashes.js';
import { sha256 } from '../hash/sha256.js';
import type {
  Calibration,
  DecodedCalibration,
  DecodedEntity,
  DecodedProgram,
  DecodedRegion,
  Hex32,
  Point,
  Program,
  ShapeCode,
} from '../types.js';
import { EngineError, check } from './errors.js';
import { ByteReader, ByteWriter } from './io.js';

const MC = 'MalformedCalibration' as const;

function fail(detail: string): never {
  throw new EngineError(MC, detail);
}

/** The program fields calibration decoding depends on. */
export type CalibrationProgramView = Pick<DecodedProgram, 'kind' | 'entities'>;

function isCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= COORD_MAX;
}

/**
 * Encode a calibration (§5.2) for program `p` as calibration_bin (§5.3).
 * Returns an empty array for ai_judged / market programs (`c` may be null).
 * Throws `EngineError("MalformedCalibration")` if `c` does not match `p`.
 */
export function encodeCalibration(c: Calibration | null | undefined, p: Program): Uint8Array {
  if (p.kind !== 'rules') return new Uint8Array(0);
  if (c == null) fail('rules programs need a calibration');
  if (c.version !== 1) fail(`calibration version must be 1`);
  const regionIdx = new Map<string, { idx: number; shape: 'line' | 'zone' }>();
  p.entities.forEach((e, i) => {
    if (e.kind === 'region') regionIdx.set(e.name, { idx: i, shape: e.shape });
  });
  const seen = new Set<string>();
  const items: { idx: number; bytes: Uint8Array }[] = [];
  for (const reg of c.regions) {
    const ent = regionIdx.get(reg.entity);
    if (ent === undefined) fail(`region for non-region or unknown entity ${JSON.stringify(reg.entity)}`);
    if (seen.has(reg.entity)) fail(`duplicate region for ${reg.entity}`);
    seen.add(reg.entity);
    if (reg.shape !== ent.shape) fail(`region ${reg.entity}: shape ${String(reg.shape)} mismatches program (${ent.shape})`);
    const pts: readonly Point[] = reg.points;
    if (!Array.isArray(pts)) fail(`region ${reg.entity}: points must be an array`);
    const w = new ByteWriter(8 + 4 * pts.length);
    if (reg.shape === 'line') {
      if (pts.length !== LINE_POINTS) fail(`line ${reg.entity}: needs exactly 2 points`);
      if (reg.behind_sign !== 1 && reg.behind_sign !== -1) fail(`line ${reg.entity}: behind_sign must be ±1`);
      w.u8(ent.idx).u8(SHAPE_CODE.line).u8(2).i8(reg.behind_sign);
    } else {
      if (pts.length < ZONE_MIN_POINTS || pts.length > ZONE_MAX_POINTS) fail(`zone ${reg.entity}: needs 3..8 points`);
      w.u8(ent.idx).u8(SHAPE_CODE.zone).u8(pts.length).i8(0);
    }
    for (const pt of pts) {
      if (!Array.isArray(pt) || pt.length !== 2 || !isCoord(pt[0]) || !isCoord(pt[1])) {
        fail(`region ${reg.entity}: coordinates must be integers 0..${COORD_MAX}`);
      }
      w.u16(pt[0]).u16(pt[1]);
    }
    if (reg.shape === 'line' && pts[0]![0] === pts[1]![0] && pts[0]![1] === pts[1]![1]) fail(`line ${reg.entity} is degenerate`);
    items.push({ idx: ent.idx, bytes: w.finish() });
  }
  for (const name of regionIdx.keys()) if (!seen.has(name)) fail(`missing region for ${name}`);
  items.sort((a, b) => a.idx - b.idx);

  let sceneHash: Uint8Array;
  try {
    sceneHash = sceneHashBytes(c);
  } catch (e) {
    if (e instanceof CanonicalJsonError || e instanceof TypeError) fail(`scene: ${e.message}`);
    throw e;
  }
  const w = new ByteWriter(64);
  w.bytes(CALIBRATION_MAGIC).u8(CALIBRATION_VERSION).u8(items.length).u16(0).bytes(sceneHash);
  for (const it of items) w.bytes(it.bytes);
  return w.finish();
}

/** `calibration_hash = sha256(calibration_bin)`; 32 zero bytes (hex) for ai_judged / market (§4.2). */
export function calibrationHash(c: Calibration | null | undefined, p: Program): Hex32 {
  if (p.kind !== 'rules') return ZERO_HASH_HEX;
  return bytesToHex(sha256(encodeCalibration(c, p)));
}

/**
 * Parse a calibration_bin starting at `start` (does not require the buffer to
 * end there). For non-rules programs the calibration is empty (0 bytes).
 */
export function readCalibration(
  bin: Uint8Array,
  program: CalibrationProgramView,
  start = 0,
): { calibration: DecodedCalibration; end: number } {
  if (program.kind !== KIND_CODE.rules) {
    return { calibration: { scene_hash: ZERO_HASH_HEX, regions: [] }, end: start };
  }
  const entities: readonly DecodedEntity[] = program.entities;
  const r = new ByteReader(bin, MC, start);
  const magic = r.bytes(4, 'magic');
  check(magic.every((b, i) => b === CALIBRATION_MAGIC[i]), MC, 'bad magic');
  check(r.u8('version') === CALIBRATION_VERSION, MC, 'bad version');
  const R = r.u8('R');
  check(r.u16('reserved') === 0, MC, 'reserved field must be 0');
  const scene_hash = bytesToHex(r.bytes(32, 'scene_hash'));
  const nRegionEntities = entities.filter((e) => e.kind === ENTITY_KIND_CODE.line || e.kind === ENTITY_KIND_CODE.zone).length;
  check(R <= nRegionEntities, MC, `R=${R} exceeds the ${nRegionEntities} region entities`);
  const regions: DecodedRegion[] = [];
  let prev = -1;
  for (let i = 0; i < R; i++) {
    const entity_idx = r.u8('entity_idx');
    const shape = r.u8('shape');
    const n = r.u8('n_points');
    const sign = r.i8('behind_sign');
    check(entity_idx < entities.length, MC, `region entity ${entity_idx} >= E`);
    const ek = entities[entity_idx]!.kind;
    check(ek === ENTITY_KIND_CODE.line || ek === ENTITY_KIND_CODE.zone, MC, `region for non-region entity ${entity_idx}`);
    check(entity_idx !== prev, MC, `duplicate region for entity ${entity_idx}`);
    check(entity_idx > prev, MC, 'regions not sorted by entity index');
    prev = entity_idx;
    const expectShape = ek === ENTITY_KIND_CODE.line ? SHAPE_CODE.line : SHAPE_CODE.zone;
    check(shape === expectShape, MC, `region ${entity_idx}: shape ${shape} mismatches the program`);
    if (shape === SHAPE_CODE.line) {
      check(n === LINE_POINTS, MC, `line ${entity_idx}: n_points must be 2`);
      check(sign === 1 || sign === -1, MC, `line ${entity_idx}: behind_sign must be ±1`);
    } else {
      check(n >= ZONE_MIN_POINTS && n <= ZONE_MAX_POINTS, MC, `zone ${entity_idx}: n_points must be 3..8`);
      check(sign === 0, MC, `zone ${entity_idx}: behind_sign must be 0`);
    }
    const points: Point[] = [];
    for (let j = 0; j < n; j++) {
      const x = r.u16('x');
      const y = r.u16('y');
      check(x <= COORD_MAX && y <= COORD_MAX, MC, `region ${entity_idx}: coordinate > ${COORD_MAX}`);
      points.push([x, y]);
    }
    if (shape === SHAPE_CODE.line) {
      check(!(points[0]![0] === points[1]![0] && points[0]![1] === points[1]![1]), MC, `line ${entity_idx} is degenerate`);
    }
    regions.push({ entity_idx, shape: shape as ShapeCode, points, behind_sign: sign as -1 | 0 | 1 });
  }
  check(R === nRegionEntities, MC, `missing region(s): ${R} of ${nRegionEntities}`);
  return { calibration: { scene_hash, regions }, end: r.pos };
}

/** Decode and validate calibration_bin against a decoded program (§5.3). */
export function decodeCalibration(bin: Uint8Array, program: CalibrationProgramView): DecodedCalibration {
  const { calibration, end } = readCalibration(bin, program);
  check(end === bin.length, MC, `${bin.length - end} trailing byte(s)`);
  return calibration;
}
