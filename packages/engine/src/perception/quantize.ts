/**
 * `quantizeSession(raw, meta)` (§6.2): non-consensus but deterministic.
 *
 * Output covers every non-region entity in entity order. Objects use sticky
 * binding with hand-off/rebind ([D-44]); `person_any` binds per frame to the
 * largest person track; `person` entities referenced by a leg get the
 * pre-identity binding (detections labelled with the entity name if the job
 * produced any, else the largest person track, `id_conf = 0`) which
 * `bindPersons` (§8.5) later replaces; persons referenced by no leg stay all-null.
 */
import { RAW_PERSON_ENTITY } from '../constants.js';
import type { PersonTrack, QFrame, QuantizeMeta, RawDetection, SessionTrack, SessionTracks } from '../types.js';
import { bindLargest, bindObject, type BoundTrack } from './binding.js';
import { occlusionFill } from './fill.js';
import { boxFromArray, isPresent, type Box } from './geometry.js';
import { groupRawTracks, tracksWithLabel, type RawTrack } from './raw.js';
import { releaseActors, trackedEntityIndices } from './program-info.js';

/** `ref_h` = `y1 - y0` at the first present frame (0 if never present). */
export function refHeight(frames: readonly (QFrame | null)[]): number {
  for (const r of frames) if (isPresent(r)) return r.y1 - r.y0;
  return 0;
}

function personLabelSet(meta: QuantizeMeta): Set<string> {
  const s = new Set<string>([RAW_PERSON_ENTITY]);
  for (const e of meta.program.entities) if (e.kind === 'person' || e.kind === 'person_any') s.add(e.name);
  return s;
}

function checkMeta(meta: QuantizeMeta): void {
  if (!Number.isSafeInteger(meta.n_frames) || meta.n_frames < 0) throw new Error('quantizeSession: n_frames must be a non-negative integer');
}

/** Anonymous person tracks (label "person"), session-length and occlusion-filled, for `fuseTimeline`/`bindPersons` (§8.5). */
export function quantizePersonTracks(raw: readonly RawDetection[], meta: QuantizeMeta): PersonTrack[] {
  checkMeta(meta);
  const personLabels = personLabelSet(meta);
  const all = groupRawTracks(raw, meta, (l) => personLabels.has(l));
  return tracksWithLabel(all, RAW_PERSON_ENTITY).map((t) => {
    const frames: (QFrame | null)[] = new Array(meta.n_frames).fill(null);
    const source: (number | null)[] = new Array(meta.n_frames).fill(null);
    for (const [f, s] of t.samples) {
      frames[f] = { ...s };
    }
    for (let f = t.first; f <= t.last && f < meta.n_frames; f++) source[f] = t.track_id;
    return { track_id: t.track_id, frames: occlusionFill(frames, source) };
  });
}

export function quantizeSession(raw: readonly RawDetection[], meta: QuantizeMeta): SessionTracks {
  checkMeta(meta);
  const p = meta.program;
  const n = meta.n_frames;
  const personLabels = personLabelSet(meta);
  const all = groupRawTracks(raw, meta, (l) => personLabels.has(l));
  const personTracks = tracksWithLabel(all, RAW_PERSON_ENTITY);
  const tracked = new Set(trackedEntityIndices(p));
  const actorsOf = releaseActors(p);
  const refs = new Map<string, Box>();
  for (const r of meta.calibration?.scene.entity_refs ?? []) refs.set(r.entity, boxFromArray(r.bbox));

  const bound = new Map<string, BoundTrack>();
  const empty = (): BoundTrack => ({ frames: new Array(n).fill(null), source: new Array(n).fill(null) });

  // Persons first: they are the `released_by` actors objects depend on.
  p.entities.forEach((e, i) => {
    if (e.kind === 'person_any') {
      bound.set(e.name, bindLargest([...tracksWithLabel(all, e.name), ...personTracks], n));
    } else if (e.kind === 'person') {
      if (!tracked.has(i)) {
        bound.set(e.name, empty());
        return;
      }
      const named = tracksWithLabel(all, e.name);
      bound.set(e.name, bindLargest(named.length > 0 ? named : personTracks, n));
    }
  });
  for (const [name, b] of bound) bound.set(name, { frames: occlusionFill(b.frames, b.source), source: b.source });

  // Objects in entity order (an object actor, if any, must precede its object).
  for (const e of p.entities) {
    if (e.kind !== 'object') continue;
    const actors = (actorsOf.get(e.name) ?? []).map((a) => bound.get(a)?.frames).filter((x): x is (QFrame | null)[] => !!x);
    const cands: RawTrack[] = tracksWithLabel(all, e.name);
    const b = bindObject(cands, n, refs.get(e.name) ?? null, actors);
    bound.set(e.name, { frames: occlusionFill(b.frames, b.source), source: b.source });
  }

  const tracks: SessionTrack[] = [];
  p.entities.forEach((e, i) => {
    if (e.kind === 'region') return;
    const frames = bound.get(e.name)?.frames ?? new Array(n).fill(null);
    tracks.push({
      entity: e.name,
      entity_idx: i,
      participant_idx: e.kind === 'person' ? e.participant : null,
      ref_h: refHeight(frames),
      frames,
    });
  });
  return { fps: 10, n_frames: n, model_hash: meta.model_hash, flags: meta.flags, tracks };
}
