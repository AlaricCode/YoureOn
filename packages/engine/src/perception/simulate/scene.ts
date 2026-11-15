/**
 * Scene builder for `simulate` (§13 mock perception): writes per-entity frame
 * records and emits SessionTracks for every non-region entity in entity order.
 */
import { COORD_MAX, FPS } from '../../constants.js';
import type { Calibration, Program, QFrame, SessionTrack, SessionTracks } from '../../types.js';
import { boxFromArray, type Box } from '../geometry.js';
import { refHeight } from '../quantize.js';
import { trackedEntityIndices } from '../program-info.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex } from '../root.js';

/** Mock model_hash: sha256("mock-perception/v1"), fixed so sessions are reproducible. */
export const MOCK_MODEL_HASH = toHex(sha256(new TextEncoder().encode('mock-perception/v1')));

export interface RecordOpts {
  conf?: number;
  id_conf?: number;
  pose?: number;
  fill?: number;
}

export function clampBox(b: Box): Box {
  const c = (v: number): number => Math.max(0, Math.min(COORD_MAX, Math.round(v)));
  const x0 = c(b.x0);
  const x1 = c(b.x1);
  const y0 = c(b.y0);
  const y1 = c(b.y1);
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/** Box of size (w, h) centered at (cx, cy), clamped to the frame. */
export function boxAt(cx: number, cy: number, w: number, h: number): Box {
  const x0 = cx - Math.floor(w / 2);
  const y0 = cy - Math.floor(h / 2);
  return clampBox({ x0, y0, x1: x0 + w, y1: y0 + h });
}

export class SceneBuilder {
  readonly n: number;
  readonly frames = new Map<string, (QFrame | null)[]>();
  flags = 0;

  constructor(
    readonly p: Program,
    nFrames: number,
  ) {
    this.n = nFrames;
    for (const e of p.entities) if (e.kind !== 'region') this.frames.set(e.name, new Array(nFrames).fill(null));
  }

  private isPerson(name: string): boolean {
    const e = this.p.entities.find((x) => x.name === name);
    return e?.kind === 'person' || e?.kind === 'person_any';
  }

  set(name: string, f: number, box: Box, o: RecordOpts = {}): void {
    const arr = this.frames.get(name);
    if (!arr) throw new Error(`simulate: unknown non-region entity ${name}`);
    if (f < 0 || f >= this.n) return;
    const b = clampBox(box);
    const person = this.isPerson(name);
    arr[f] = {
      ...b,
      conf: o.conf ?? 90,
      fill: o.fill ?? 80,
      id_conf: person && this.p.entities.find((x) => x.name === name)?.kind === 'person' ? (o.id_conf ?? 0) : 0,
      pose: person ? (o.pose ?? 0) : 0,
    };
  }

  /** Same box for frames `[from, to)`. */
  hold(name: string, from: number, to: number, box: Box, o: RecordOpts = {}): void {
    for (let f = Math.max(0, from); f < Math.min(this.n, to); f++) this.set(name, f, box, o);
  }

  clear(name: string, f: number): void {
    const arr = this.frames.get(name);
    if (arr && f >= 0 && f < this.n) arr[f] = null;
  }

  get(name: string, f: number): QFrame | null {
    return this.frames.get(name)?.[f] ?? null;
  }

  /** Apply `fn` to every present record of `name` in `[from, to)`. */
  patch(name: string, from: number, to: number, fn: (r: QFrame, f: number) => QFrame | null): void {
    const arr = this.frames.get(name);
    if (!arr) return;
    for (let f = Math.max(0, from); f < Math.min(this.n, to); f++) {
      const r = arr[f];
      if (r) arr[f] = fn({ ...r }, f);
    }
  }

  build(): SessionTracks {
    const tracks: SessionTrack[] = [];
    const tracked = new Set(trackedEntityIndices(this.p));
    this.p.entities.forEach((e, i) => {
      if (e.kind === 'region') return;
      // §6.2: persons referenced only in the outcome (no leg) stay all-null.
      const frames = e.kind === 'person' && !tracked.has(i) ? new Array<QFrame | null>(this.n).fill(null) : this.frames.get(e.name)!;
      tracks.push({
        entity: e.name,
        entity_idx: i,
        participant_idx: e.kind === 'person' ? e.participant : null,
        ref_h: refHeight(frames),
        frames,
      });
    });
    return { fps: FPS as 10, n_frames: this.n, model_hash: MOCK_MODEL_HASH, flags: this.flags, tracks };
  }
}

/** Calibration bbox of an entity, if any. */
export function refBox(c: Calibration | null, entity: string): Box | null {
  const r = c?.scene.entity_refs.find((x) => x.entity === entity);
  return r ? boxFromArray(r.bbox) : null;
}

/** Deterministic fallback layout for entities without a calibration bbox. */
export function fallbackBox(p: Program, entity: string): Box {
  const i = Math.max(0, p.entities.findIndex((x) => x.name === entity));
  const e = p.entities[i];
  const col = i % 4;
  const x0 = 500 + col * 2400;
  if (e?.kind === 'person' || e?.kind === 'person_any') return { x0, y0: 1500, x1: x0 + 1800, y1: 9500 };
  return { x0, y0: 6000, x1: x0 + 1000, y1: 8000 };
}

export function entityBox(p: Program, c: Calibration | null, entity: string): Box {
  return refBox(c, entity) ?? fallbackBox(p, entity);
}
