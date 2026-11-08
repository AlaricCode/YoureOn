/**
 * `bindPersons(session, personTracks, timeline, p)` (§8.5): writes the
 * stitched identity timeline into the `person` entity tracks of a session.
 *
 * For a `person` entity bound to participant i that is referenced by some leg,
 * frame f becomes the stitched track's QFrame with `id_conf = conf_i(t, f)`,
 * or absent when participant i has no assignment at f. Persons used only in
 * the outcome (`side(...)`) keep their all-null tracks (§6.2). `ref_h` is
 * recomputed from the first present frame.
 */
import type { Expr, FusedTimeline, PersonTrack, Program, QFrame, SessionTracks } from '../types.js';
import { isPresent } from './fusion.js';

function collectRefs(e: Expr | undefined, out: Set<string>): void {
  if (e === undefined) return;
  const node = e as unknown as Record<string, unknown>;
  for (const k of ['a', 'b'] as const) {
    const r = node[k] as { e?: unknown } | undefined;
    if (r && typeof r.e === 'string') out.add(r.e);
  }
  if (Array.isArray(node.args)) for (const x of node.args as Expr[]) collectRefs(x, out);
  for (const k of ['arg', 'first', 'then'] as const) {
    const x = node[k];
    if (x && typeof x === 'object') collectRefs(x as Expr, out);
  }
}

/** Entity names referenced by any leg expression. */
export function referencedEntities(p: Program): Set<string> {
  const out = new Set<string>();
  for (const leg of p.legs) {
    collectRefs(leg.valid_attempt, out);
    collectRefs(leg.success, out);
  }
  return out;
}

export function bindPersons(
  session: SessionTracks,
  personTracks: PersonTrack[],
  timeline: FusedTimeline,
  p: Program,
): SessionTracks {
  if (timeline.n_frames !== session.n_frames) {
    throw new RangeError(`timeline has ${timeline.n_frames} frames, session has ${session.n_frames}`);
  }
  const byId = new Map<number, PersonTrack>();
  for (const t of personTracks) byId.set(t.track_id, t);
  const refs = referencedEntities(p);
  const tracks = session.tracks.map((st) => {
    const ent = p.entities[st.entity_idx];
    if (!ent || ent.kind !== 'person' || ent.name !== st.entity || !refs.has(ent.name)) return st;
    const row = timeline.stitched[ent.participant];
    const frames: (QFrame | null)[] = new Array(session.n_frames).fill(null);
    for (let f = 0; f < session.n_frames; f++) {
      const s = row?.[f] ?? null;
      if (s === null) continue;
      const q = byId.get(s.track_id)?.frames[f];
      if (!isPresent(q)) continue;
      frames[f] = { ...q, id_conf: Math.max(0, Math.min(100, s.conf)) };
    }
    const first = frames.find((q) => q !== null) ?? null;
    return {
      ...st,
      participant_idx: ent.participant,
      ref_h: first ? first.y1 - first.y0 : 0,
      frames,
    };
  });
  return { ...session, tracks };
}
