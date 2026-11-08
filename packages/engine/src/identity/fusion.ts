/**
 * Identity timeline fusion (§8.5, offchain, engine).
 *
 * State S[t][c] (u32, init 0). For f = 0 … n_frames−1:
 *  1. Re-ID inheritance for tracks whose first present frame is f.
 *  2. Decay ×9977/10000 for tracks present at f and not starting at f.
 *  3. Observations at f (faces first, then voices; each by ascending track_id).
 *  4. conf_c(t,f) = floor(100·S[t][c] / (Σ_q S[t][q] + 1000)).
 * Then greedy stitching per frame by (conf desc, t asc, p asc).
 */
import {
  CONF_SMOOTHING,
  FACE_NONMATCH_NUM,
  MAX_CANDIDATES,
  OBS_WEIGHT_BASE,
  OBS_WEIGHT_MAX,
  REID_INHERIT_NUM,
  REID_LOOKBACK_FRAMES,
  REID_SIM_MIN_BPS,
  SCORE_DECAY_NUM,
  SCORE_DEN,
} from '../constants.js';
import type { FusedTimeline, IdObservation, PersonTrack, QFrame, ReidLink, StitchedFrame } from '../types.js';
import { matchFromScores, modalityThresholds } from './match.js';
import { idiv, mulDiv } from './math.js';

const U32_MAX = 0xffffffff;

/** A person-track frame counts as present when it has a record with conf > 0. */
export function isPresent(q: QFrame | null | undefined): q is QFrame {
  return q !== null && q !== undefined && q.conf > 0;
}

/** Observation weight `min(4000, 1000 + (cos1−τ) + ((cos1−cos2)−δ))` for a matched observation. */
export function observationWeight(cos1: number, cos2: number, tau: number, delta: number): number {
  return Math.min(OBS_WEIGHT_MAX, OBS_WEIGHT_BASE + (cos1 - tau) + (cos1 - cos2 - delta));
}

interface TrackInfo {
  id: number;
  present: boolean[];
  first: number; // -1 if never present
  last: number;
}

/** Internal per-frame result, also used by tests and the prover. */
export interface FusionTrace {
  timeline: FusedTimeline;
  /** conf[f] = Map(track_id → per-candidate conf) for tracks present at f */
  conf: Map<number, number[]>[];
}

export function fuseTimeline(
  tracks: PersonTrack[],
  observations: IdObservation[],
  reid: ReidLink[],
  nCandidates: number,
  nParticipants: number,
  nFrames: number,
): FusedTimeline {
  return fuseTimelineTrace(tracks, observations, reid, nCandidates, nParticipants, nFrames).timeline;
}

export function fuseTimelineTrace(
  tracks: PersonTrack[],
  observations: IdObservation[],
  reid: ReidLink[],
  nCandidates: number,
  nParticipants: number,
  nFrames: number,
): FusionTrace {
  const M = nCandidates;
  const P = nParticipants;
  if (!Number.isInteger(M) || M < 0 || M > MAX_CANDIDATES) throw new RangeError(`nCandidates must be 0..${MAX_CANDIDATES}`);
  if (!Number.isInteger(P) || P < 0 || P > M) throw new RangeError('nParticipants must be 0..nCandidates');
  if (!Number.isInteger(nFrames) || nFrames < 0) throw new RangeError('nFrames must be a non-negative integer');

  // tracks in ascending track_id order
  const infos: TrackInfo[] = [];
  const byId = new Map<number, number>();
  const sorted = [...tracks].sort((a, b) => a.track_id - b.track_id);
  for (const t of sorted) {
    if (byId.has(t.track_id)) throw new RangeError(`duplicate track_id ${t.track_id}`);
    const present: boolean[] = new Array(nFrames);
    let first = -1;
    let last = -1;
    for (let f = 0; f < nFrames; f++) {
      present[f] = isPresent(t.frames[f]);
      if (present[f]) {
        if (first < 0) first = f;
        last = f;
      }
    }
    byId.set(t.track_id, infos.length);
    infos.push({ id: t.track_id, present, first, last });
  }
  const S: number[][] = infos.map(() => new Array<number>(M).fill(0));

  // observations grouped by frame: faces by track_id, then voices by track_id (stable)
  const faces: IdObservation[][] = Array.from({ length: nFrames }, () => []);
  const voices: IdObservation[][] = Array.from({ length: nFrames }, () => []);
  for (const o of observations) {
    if (!Number.isInteger(o.frame) || o.frame < 0 || o.frame >= nFrames) continue;
    if (o.modality === 'face') faces[o.frame]!.push(o);
    else if (o.modality === 'voice') voices[o.frame]!.push(o);
  }
  const key = (o: IdObservation) => (o.track_id === null ? Number.POSITIVE_INFINITY : o.track_id);
  for (let f = 0; f < nFrames; f++) {
    faces[f]!.sort((a, b) => key(a) - key(b));
    voices[f]!.sort((a, b) => key(a) - key(b));
  }

  // re-ID links by destination
  const linksTo = new Map<number, ReidLink[]>();
  for (const l of reid) {
    const arr = linksTo.get(l.to_track) ?? [];
    arr.push(l);
    linksTo.set(l.to_track, arr);
  }

  const face = modalityThresholds('face');
  const voice = modalityThresholds('voice');
  const scoresFor = (o: IdObservation) => o.scores.filter((s) => Number.isInteger(s.candidate) && s.candidate >= 0 && s.candidate < M);

  const stitched: (StitchedFrame | null)[][] = Array.from({ length: P }, () => new Array(nFrames).fill(null));
  const confTrace: Map<number, number[]>[] = [];

  for (let f = 0; f < nFrames; f++) {
    // 1. re-ID inheritance
    for (let t = 0; t < infos.length; t++) {
      const info = infos[t]!;
      if (info.first !== f) continue;
      let best: ReidLink | null = null;
      for (const l of linksTo.get(info.id) ?? []) {
        if (l.sim_bps < REID_SIM_MIN_BPS) continue;
        const fromIdx = byId.get(l.from_track);
        if (fromIdx === undefined || fromIdx === t) continue;
        const lp = infos[fromIdx]!.last;
        if (lp < f - REID_LOOKBACK_FRAMES || lp > f - 1) continue;
        if (best === null || l.sim_bps > best.sim_bps || (l.sim_bps === best.sim_bps && l.from_track < best.from_track)) {
          best = l;
        }
      }
      if (best !== null) {
        const from = S[byId.get(best.from_track)!]!;
        S[t] = from.map((v) => mulDiv(v, REID_INHERIT_NUM, SCORE_DEN));
      }
    }
    // 2. decay
    for (let t = 0; t < infos.length; t++) {
      const info = infos[t]!;
      if (!info.present[f] || info.first === f) continue;
      const row = S[t]!;
      for (let c = 0; c < M; c++) row[c] = mulDiv(row[c]!, SCORE_DECAY_NUM, SCORE_DEN);
    }
    // 3a. faces
    for (const o of faces[f]!) {
      if (o.track_id === null) continue;
      const t = byId.get(o.track_id);
      if (t === undefined || !infos[t]!.present[f]) continue;
      const m = matchFromScores(scoresFor(o), 'face');
      if (m.best === null) continue;
      const row = S[t]!;
      if (m.matched) {
        const w = observationWeight(m.cos1, m.cos2, face.tau, face.delta);
        row[m.best] = Math.min(U32_MAX, row[m.best]! + w);
      } else if (m.cos1 < face.tau) {
        for (let c = 0; c < M; c++) row[c] = mulDiv(row[c]!, FACE_NONMATCH_NUM, SCORE_DEN);
      }
    }
    // 3b. voices
    for (const o of voices[f]!) {
      const m = matchFromScores(scoresFor(o), 'voice');
      if (!m.matched || m.best === null) continue;
      const w = idiv(observationWeight(m.cos1, m.cos2, voice.tau, voice.delta), 2);
      const presentIdx: number[] = [];
      for (let t = 0; t < infos.length; t++) if (infos[t]!.present[f]) presentIdx.push(t);
      let target = -1;
      if (presentIdx.length === 1) {
        target = presentIdx[0]!;
      } else {
        const hits = presentIdx.filter((t) => strictArgmax(S[t]!) === m.best);
        if (hits.length === 1) target = hits[0]!;
      }
      if (target < 0) continue;
      const row = S[target]!;
      row[m.best] = Math.min(U32_MAX, row[m.best]! + w);
    }
    // 4. confidences
    const confs = new Map<number, number[]>();
    for (let t = 0; t < infos.length; t++) {
      if (!infos[t]!.present[f]) continue;
      const row = S[t]!;
      let sum = 0;
      for (let c = 0; c < M; c++) sum += row[c]!;
      confs.set(infos[t]!.id, row.map((v) => idiv(100 * v, sum + CONF_SMOOTHING)));
    }
    confTrace.push(confs);
    // stitching (greedy)
    const pairs: { t: number; p: number; conf: number }[] = [];
    for (const [tid, cs] of confs) {
      for (let p = 0; p < P; p++) if (cs[p]! > 0) pairs.push({ t: tid, p, conf: cs[p]! });
    }
    pairs.sort((a, b) => b.conf - a.conf || a.t - b.t || a.p - b.p);
    const usedT = new Set<number>();
    const usedP = new Set<number>();
    for (const pr of pairs) {
      if (usedT.has(pr.t) || usedP.has(pr.p)) continue;
      usedT.add(pr.t);
      usedP.add(pr.p);
      stitched[pr.p]![f] = { track_id: pr.t, conf: pr.conf };
    }
  }

  return { timeline: { n_frames: nFrames, n_candidates: M, stitched }, conf: confTrace };
}

/** Index of the strict maximum (unique max), or −1 (ties or empty). All-zero rows have no strict argmax unless M = 1. */
export function strictArgmax(row: number[]): number {
  let best = -1;
  let bestV = -1;
  let tie = false;
  for (let c = 0; c < row.length; c++) {
    const v = row[c]!;
    if (v > bestV) {
      bestV = v;
      best = c;
      tie = false;
    } else if (v === bestV) {
      tie = true;
    }
  }
  return tie ? -1 : best;
}
