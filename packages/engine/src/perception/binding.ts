/**
 * §6.2 track binding.
 *
 * Objects use sticky binding [D-44]:
 *  1. initial track = candidate with max IoU against `entity_refs[e].bbox` at the
 *     first frame where any candidate exists (fallback: highest conf; ties →
 *     lower track_id);
 *  2. keep that track while it exists (up to its last sample);
 *  3. hand-off: another candidate held by a `released_by` actor of this entity
 *     for RELEASE_HOLD consecutive frames while the bound track is not held;
 *  4. after the bound track ends: absent for REBIND_DELAY_FRAMES, then rebind to
 *     a candidate in an actor's expanded hand box, else the highest-conf one.
 *
 * Persons bind per frame to the largest-area person track (`person_any`, and
 * practice/D-45 for `person` before identity stitching).
 */
import { HAND_EXPAND_PCT, RELEASE_HOLD, REBIND_DELAY_FRAMES } from '../constants.js';
import type { QFrame } from '../types.js';
import { area, center, expand, iouBps, isPresent, ptInRect, type Box } from './geometry.js';
import type { RawTrack } from './raw.js';

export interface BoundTrack {
  frames: (QFrame | null)[];
  /** raw track_id the entity is bound to at each frame (null = unbound) */
  source: (number | null)[];
}

/** `held(g)` of §3.5 for a candidate record and an actor record. */
export function heldBy(obj: QFrame | null | undefined, actor: QFrame | null | undefined): boolean {
  if (!isPresent(obj) || !isPresent(actor)) return false;
  return ptInRect(center(obj), expand(actor, HAND_EXPAND_PCT));
}

function heldByAny(obj: QFrame | null | undefined, actors: readonly (readonly (QFrame | null)[])[], f: number): boolean {
  return actors.some((a) => heldBy(obj, a[f]));
}

/** Order: higher conf first, then lower track_id. */
function byConfThenId(f: number) {
  return (a: RawTrack, b: RawTrack): number => b.samples.get(f)!.conf - a.samples.get(f)!.conf || a.track_id - b.track_id;
}

function initialPick(cands: RawTrack[], f: number, ref: Box | null): RawTrack {
  if (ref) {
    let best: RawTrack | null = null;
    let bestIou = 0;
    for (const c of cands) {
      const iou = iouBps(c.samples.get(f)!, ref) ?? 0;
      if (iou > bestIou || (iou === bestIou && best !== null && iou > 0 && c.track_id < best.track_id)) {
        best = c;
        bestIou = iou;
      }
    }
    if (best && bestIou > 0) return best;
  }
  return [...cands].sort(byConfThenId(f))[0]!;
}

function rebindPick(cands: RawTrack[], f: number, actors: readonly (readonly (QFrame | null)[])[]): RawTrack {
  const inHand = cands.filter((c) => {
    const s = c.samples.get(f)!;
    return actors.some((a) => {
      const ab = a[f];
      return isPresent(ab) && ptInRect(center(s), expand(ab, HAND_EXPAND_PCT));
    });
  });
  const pool = inHand.length > 0 ? inHand : cands;
  return [...pool].sort(byConfThenId(f))[0]!;
}

/**
 * Sticky object binding over `n_frames` frames.
 * @param cands raw tracks labelled with the entity name
 * @param ref   calibration `entity_refs[e].bbox` (normalized) or null
 * @param actors session frames of the entity's `released_by` actors
 */
export function bindObject(
  cands: readonly RawTrack[],
  nFrames: number,
  ref: Box | null,
  actors: readonly (readonly (QFrame | null)[])[],
): BoundTrack {
  const frames: (QFrame | null)[] = new Array(nFrames).fill(null);
  const source: (number | null)[] = new Array(nFrames).fill(null);
  const byId = new Map<number, RawTrack>();
  for (const c of cands) byId.set(c.track_id, c);

  let bound: RawTrack | null = null;
  let everBound = false;
  let rebindAt = 0;
  const run = new Map<number, number>(); // hand-off run lengths

  for (let f = 0; f < nFrames; f++) {
    const here = cands.filter((c) => c.samples.has(f));
    if (bound && f > bound.last) {
      // Step 4: the bound track ended.
      rebindAt = bound.last + 1 + REBIND_DELAY_FRAMES;
      bound = null;
      run.clear();
    }
    if (!bound) {
      if (here.length > 0) {
        if (!everBound) {
          bound = initialPick(here, f, ref);
          everBound = true;
        } else if (f >= rebindAt) {
          bound = rebindPick(here, f, actors);
        }
      }
    } else if (actors.length > 0) {
      // Step 3: hand-off to a candidate held by an actor while the bound track is not held.
      const boundHeld = heldByAny(bound.samples.get(f), actors, f);
      let best: RawTrack | null = null;
      let bestRun = 0;
      for (const c of here) {
        if (c === bound) continue;
        const r = !boundHeld && heldByAny(c.samples.get(f), actors, f) ? (run.get(c.track_id) ?? 0) + 1 : 0;
        run.set(c.track_id, r);
        if (r >= RELEASE_HOLD && (r > bestRun || (r === bestRun && best !== null && c.track_id < best.track_id))) {
          best = c;
          bestRun = r;
        }
      }
      for (const id of [...run.keys()]) if (!here.some((c) => c.track_id === id)) run.set(id, 0);
      if (best) {
        bound = best;
        run.clear();
      }
    }
    if (bound) {
      source[f] = bound.track_id;
      const s = bound.samples.get(f);
      if (s) frames[f] = { ...s };
    }
  }
  return { frames, source };
}

/** Per-frame largest-area track (ties → lower track_id). */
export function bindLargest(cands: readonly RawTrack[], nFrames: number): BoundTrack {
  const frames: (QFrame | null)[] = new Array(nFrames).fill(null);
  const source: (number | null)[] = new Array(nFrames).fill(null);
  const sorted = [...cands].sort((a, b) => a.track_id - b.track_id);
  for (let f = 0; f < nFrames; f++) {
    let best: RawTrack | null = null;
    let bestArea = -1;
    for (const c of sorted) {
      const s = c.samples.get(f);
      if (!s) continue;
      const a = area(s);
      if (a > bestArea) {
        best = c;
        bestArea = a;
      }
    }
    if (best) {
      frames[f] = { ...best.samples.get(f)! };
      source[f] = best.track_id;
    }
  }
  return { frames, source };
}
