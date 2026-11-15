/**
 * Scene check (§5.2, §12.3, §12.10, D-28): detector provider per frame,
 * calibration validation + calibration_hash, and live condition rows from
 * `engine.leafSignals` (persons bind to the largest person detection, D-45).
 */
import {
  calibrationHash,
  conditionRows,
  encodeCalibration,
  EVENT_OPS,
  leafSignals,
  PULSE_LATCH_FRAMES,
  type Calibration,
  type ConditionField,
  type Expr,
  type Program,
  type QFrame,
  type SessionTracks,
} from '@verdict/engine';
import { ApiError } from '../errors.js';
import type { Detection } from '../providers/types.js';
import { badRequest } from '../routes/util.js';

/** Rolling buffer length for WS scene frames (§12.4). */
export const SCENE_BUFFER_FRAMES = 50;

export interface SceneEntityView {
  entity: string;
  label: string;
  bbox: [number, number, number, number];
  conf: number;
}

export interface ConditionState {
  leg: number;
  field: ConditionField;
  path: string;
  label: string;
  state: boolean;
  placed: boolean;
}

/** Non-region entities the detector should find, with their prompt phrase. */
export function detectorPrompts(p: Program): { entity: string; phrase: string }[] {
  return p.entities
    .filter((e) => e.kind !== 'region')
    .map((e) => ({ entity: e.name, phrase: e.kind === 'object' ? e.phrase : 'person' }));
}

/** Display label of an entity: draft label, calibration label, object phrase, name. */
export function entityLabel(p: Program, labels: Record<string, string>, c: Calibration | null, entity: string): string {
  const fromCal = c?.scene.entity_refs.find((r) => r.entity === entity)?.label;
  if (fromCal && fromCal.trim()) return fromCal.trim();
  if (labels[entity]) return labels[entity]!;
  const e = p.entities.find((x) => x.name === entity);
  return e?.kind === 'object' ? e.phrase : entity;
}

const area = (b: readonly number[]): number => Math.max(0, b[2]! - b[0]!) * Math.max(0, b[3]! - b[1]!);

function qframe(d: Detection): QFrame {
  const [x0, y0, x1, y1] = d.bbox.map((v) => Math.max(0, Math.min(10000, Math.trunc(v)))) as [number, number, number, number];
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
    conf: Math.max(0, Math.min(100, Math.trunc(d.conf))),
    fill: 0,
    id_conf: 0,
    pose: 0,
  };
}

/**
 * SessionTracks from per-frame detector output (scene check / practice):
 * objects by entity name; `person`/`person_any` entities use their own
 * detection, else the largest unlabelled "person" detection (D-45).
 */
export function sessionFromDetections(p: Program, frames: Detection[][]): SessionTracks {
  const tracks = p.entities.flatMap((e, entity_idx) => {
    if (e.kind === 'region') return [];
    const rows = frames.map((dets) => {
      let d = dets.find((x) => x.entity === e.name) ?? null;
      if (!d && (e.kind === 'person' || e.kind === 'person_any')) {
        const persons = dets.filter((x) => x.entity === 'person');
        d = persons.sort((a, b) => area(b.bbox) - area(a.bbox))[0] ?? null;
      }
      return d && d.conf > 0 ? qframe(d) : null;
    });
    const first = rows.find((r) => r !== null) ?? null;
    return [
      {
        entity: e.name,
        entity_idx,
        participant_idx: e.kind === 'person' ? e.participant : null,
        ref_h: first ? first.y1 - first.y0 : 0,
        frames: rows,
      },
    ];
  });
  return { fps: 10, n_frames: frames.length, model_hash: '00'.repeat(32), flags: 0, tracks };
}

/** Node of a leg expression at a leafSignals path ("" = root, "0.1" = child indices). */
export function exprAt(e: Expr, path: string): Expr | null {
  let cur: Expr = e;
  if (path === '') return cur;
  for (const part of path.split('.')) {
    const i = Number(part);
    const n = cur as unknown as Record<string, unknown>;
    let next: unknown;
    if (Array.isArray(n['args'])) next = (n['args'] as Expr[])[i];
    else if (cur.op === 'then_within') next = i === 0 ? (n['first'] as Expr) : (n['then'] as Expr);
    else if (i === 0) next = n['arg'];
    if (!next || typeof next !== 'object') return null;
    cur = next as Expr;
  }
  return cur;
}

/** True when every region entity referenced by the leaf is placed in the calibration. */
function leafPlaced(p: Program, c: Calibration | null, leaf: Expr | null): boolean {
  if (!leaf) return true;
  const n = leaf as unknown as Record<string, { e?: string } | undefined>;
  for (const k of ['a', 'b'] as const) {
    const name = n[k]?.e;
    if (!name) continue;
    const ent = p.entities.find((x) => x.name === name);
    if (ent?.kind === 'region' && !c?.regions.some((r) => r.entity === name)) return false;
  }
  return true;
}

/**
 * Condition rows with live states (§12.10): level rows show the last frame,
 * event rows latch true for PULSE_LATCH_FRAMES. Row labels come from
 * `conditionRows` with the bet labels; signals from `leafSignals`.
 */
export function conditionStates(
  p: Program,
  labels: Record<string, string>,
  c: Calibration | null,
  session: SessionTracks,
): ConditionState[] {
  const signals = session.n_frames > 0 ? leafSignals(p, c, session) : [];
  const key = (r: { leg: number; field: string; path: string }) => `${r.leg}|${r.field}|${r.path}`;
  const byKey = new Map(signals.map((s) => [key(s), s.signal]));
  return conditionRows(p, labels).map((row) => {
    const leg = p.legs.find((l) => l.id === row.leg);
    const root = leg ? leg[row.field] : undefined;
    const leaf = root ? exprAt(root, row.path) : null;
    const sig = byKey.get(key(row)) ?? [];
    const isEvent = !!leaf && (EVENT_OPS as readonly string[]).includes(leaf.op);
    const n = sig.length;
    const state = isEvent ? sig.slice(Math.max(0, n - PULSE_LATCH_FRAMES)).some(Boolean) : n > 0 && sig[n - 1] === true;
    return { ...row, state, placed: leafPlaced(p, c, leaf) };
  });
}

export function sceneEntityViews(
  p: Program,
  labels: Record<string, string>,
  c: Calibration | null,
  dets: Detection[],
): SceneEntityView[] {
  return dets.map((d) => ({
    entity: d.entity,
    label: entityLabel(p, labels, c, d.entity),
    bbox: [...d.bbox] as [number, number, number, number],
    conf: Math.max(0, Math.min(100, Math.trunc(d.conf))),
  }));
}

// ---- calibration ------------------------------------------------------------------

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isPt = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && isInt(v[0], 0, 10000) && isInt(v[1], 0, 10000);
const isBox = (v: unknown): boolean => Array.isArray(v) && v.length === 4 && v.every((x) => isInt(x, 0, 10000));

/**
 * Validates a §5.2 calibration against the program and returns the stored
 * form plus its hash. Region placement must be complete (CALIBRATION_INCOMPLETE);
 * any other defect is a 400.
 */
export function validateCalibration(p: Program, body: unknown): { calibration: Calibration; calibration_hash: string } {
  if (p.kind !== 'rules') throw new ApiError('WRONG_STATE', `${p.kind} bets have no calibration`);
  const c = body as Calibration;
  if (!c || typeof c !== 'object' || c.version !== 1 || !c.scene || typeof c.scene !== 'object' || !Array.isArray(c.regions)) {
    throw badRequest('calibration must be a §5.2 object');
  }
  const cam = c.scene.camera;
  if (!cam || !isInt(cam.width_px, 1, 100_000) || !isInt(cam.height_px, 1, 100_000) || !['landscape', 'portrait'].includes(cam.orientation)) {
    throw badRequest('calibration.scene.camera is invalid');
  }
  if (cam.pose !== undefined && (!isInt(cam.pose.pitch_cdeg, -36000, 36000) || !isInt(cam.pose.roll_cdeg, -36000, 36000))) {
    throw badRequest('calibration.scene.camera.pose is invalid');
  }
  if (!Array.isArray(c.scene.entity_refs)) throw badRequest('calibration.scene.entity_refs must be an array');
  const seenRefs = new Set<string>();
  for (const r of c.scene.entity_refs) {
    const ent = p.entities.find((e) => e.name === r?.entity);
    if (!ent || ent.kind === 'region' || seenRefs.has(r.entity)) throw badRequest(`entity_refs: bad entity ${String(r?.entity)}`);
    seenRefs.add(r.entity);
    const words = typeof r.label === 'string' ? r.label.trim().split(/\s+/).filter(Boolean) : [];
    if (words.length < 1 || words.length > 3) throw badRequest(`entity_refs: label of ${r.entity} must be 1–3 words`);
    if (!isBox(r.bbox) || r.bbox[0] > r.bbox[2] || r.bbox[1] > r.bbox[3]) throw badRequest(`entity_refs: bad bbox for ${r.entity}`);
  }
  for (const r of c.regions) {
    const ent = p.entities.find((e) => e.name === r?.entity);
    if (!ent || ent.kind !== 'region') throw badRequest(`regions: ${String(r?.entity)} is not a region entity`);
    if (!Array.isArray(r.points) || !r.points.every(isPt)) throw badRequest(`regions: bad points for ${r.entity}`);
  }
  const regionEntities = p.entities.filter((e) => e.kind === 'region').map((e) => e.name);
  if (regionEntities.some((name) => !c.regions.some((r) => r.entity === name))) throw new ApiError('CALIBRATION_INCOMPLETE');
  // Canonical encoding is the final judge (duplicates, shapes, degenerate lines, behind_sign).
  try {
    encodeCalibration(c, p);
  } catch (e) {
    throw badRequest(`calibration rejected: ${(e as Error).message}`);
  }
  return { calibration: c, calibration_hash: calibrationHash(c, p) };
}

/** True when the program needs a calibration and every region entity is placed. */
export function calibrationComplete(p: Program, c: Calibration | null): boolean {
  if (p.kind !== 'rules') return true;
  if (!c) return false;
  return p.entities.filter((e) => e.kind === 'region').every((e) => c.regions.some((r) => r.entity === e.name));
}
