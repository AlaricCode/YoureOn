/**
 * In-game identity for actor-bound legs (§8.5, §8.6): candidate templates,
 * observations, the fused identity timeline, and the proof plan (which
 * checkpoints can be proven, with which observed embedding).
 *
 * - Real hosts (RawDetection): anonymous person tracks (`quantizePersonTracks`)
 *   + face observations from the job's per-person-line `face` embeddings
 *   (services/perception fills them every FACE_SAMPLE_STRIDE-th frame when
 *   `need_faces`, CONTRACTS-ERRATA backend-audit-faces) + voice observations
 *   from the audio witnesses (STT diarized segments, ECAPA-class
 *   `embedVoice`) + re-ID links from the optional `reid` vectors →
 *   `fuseTimeline` → `bindPersons`. A silent actor is identified by face.
 * - Mock hosts (`engine.simulate`): the sessions are already bound (person
 *   tracks carry `id_conf`); the timeline is read back from the session and
 *   face observations are synthesized with the identity provider near each
 *   checkpoint (subject = the bound participant when `id_conf ≥ ID_CONF_MIN`,
 *   else an unknown person), so `no_identity` still fails identity.
 */
import { createHash } from 'node:crypto';
import {
  circuitMatch,
  cosineBps,
  ID_CONF_MIN,
  PRESENCE_MIN,
  PROVER_FACE_LOOKBACK_FRAMES,
  padToCircuit,
  proofTau,
  proverInput,
  quantizeEmbedding,
  type Checkpoint,
  type FusedTimeline,
  type IdObservation,
  type Modality,
  type PersonTrack,
  type RawDetection,
  type ReidLink,
  REID_LOOKBACK_FRAMES,
  REID_SIM_MIN_BPS,
  type Program,
  type SegmentedIdObservation,
  type SessionTracks,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import { BiometricVault, type StoredTemplate } from '../identity/biometrics.js';
import { decodeWav, encodeWav } from '../util/wav.js';
import type { BetInfo } from './betInfo.js';
import type { AudioWitnessTranscript } from './footage.js';
import type { ProofPlan } from './records.js';

/** Face sampling stride (D-46: every 3rd frame at 10 fps). */
export const FACE_SAMPLE_STRIDE = 3;
/** Synthetic track ids for entity-bound person tracks of mock sessions. */
export const MOCK_PERSON_TRACK_BASE = 1000;

export interface CandidateTemplates {
  /** candidate index → quantized template (null if not enrolled in the modality) */
  face: (Int8Array | null)[];
  voice: (Int8Array | null)[];
}

export function biometricVault(ctx: AppContext): BiometricVault {
  return new BiometricVault(ctx.store, ctx.config.biometricKey, ctx.clock);
}

function safeTemplate(vault: BiometricVault, userId: string, m: Modality): StoredTemplate | null {
  if (userId.startsWith('wallet:')) return null;
  try {
    return vault.template(userId, m);
  } catch {
    return null;
  }
}

export function candidateTemplates(ctx: AppContext, info: BetInfo): CandidateTemplates {
  const vault = biometricVault(ctx);
  return {
    face: info.candidates.map((u) => safeTemplate(vault, u, 'face')?.q ?? null),
    voice: info.candidates.map((u) => safeTemplate(vault, u, 'voice')?.q ?? null),
  };
}

/** All-M score row for an observed embedding (unenrolled candidates score 0). */
export function scoreRow(templates: (Int8Array | null)[], observed: Int8Array): { candidate: number; cos_bps: number }[] {
  return templates.map((t, candidate) => ({ candidate, cos_bps: t && t.length === observed.length ? cosineBps(t, observed) : 0 }));
}

/** A person entity track of a session that some leg references, with its participant. */
function boundPersonTracks(p: Program, s: SessionTracks): { participant: number; entity_idx: number; frames: SessionTracks['tracks'][number]['frames'] }[] {
  return s.tracks.flatMap((t) => {
    const e = p.entities[t.entity_idx];
    return e && e.kind === 'person' && t.frames.some((q) => q !== null) ? [{ participant: e.participant, entity_idx: t.entity_idx, frames: t.frames }] : [];
  });
}

/** FusedTimeline read back from an already-bound session (mock hosts). */
export function timelineFromSession(p: Program, s: SessionTracks, nCandidates: number): FusedTimeline {
  const P = p.participants.length;
  const stitched: FusedTimeline['stitched'] = Array.from({ length: P }, () => new Array(s.n_frames).fill(null));
  for (const t of boundPersonTracks(p, s)) {
    const row = stitched[t.participant];
    if (!row) continue;
    t.frames.forEach((q, f) => {
      if (q && q.conf >= PRESENCE_MIN) row[f] = { track_id: MOCK_PERSON_TRACK_BASE + t.entity_idx, conf: q.id_conf };
    });
  }
  return { n_frames: s.n_frames, n_candidates: nCandidates, stitched };
}

export interface ObservationSet {
  observations: SegmentedIdObservation[];
  /** `${modality}:${frame}:${track_id ?? 'v'}` → observed quantized embedding */
  observed: Map<string, Int8Array>;
}

export const obsKey = (o: Pick<IdObservation, 'modality' | 'frame' | 'track_id'>): string =>
  `${o.modality}:${o.frame}:${o.track_id ?? 'v'}`;

/** Deterministic synthetic "face crop" bytes for mock observations. */
function mockCrop(bet: string, participant: number, frame: number): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`mock-face|${bet}|${participant}|${frame}`).digest());
}

/**
 * Mock face observations every FACE_SAMPLE_STRIDE frames in the prover
 * look-back window of each checkpoint, on the participant's bound track.
 */
export async function mockFaceObservations(
  ctx: AppContext,
  info: BetInfo,
  s: SessionTracks,
  checkpoints: Checkpoint[],
  templates: CandidateTemplates,
): Promise<ObservationSet> {
  const out: ObservationSet = { observations: [], observed: new Map() };
  const tracks = boundPersonTracks(info.program, s);
  const seen = new Set<string>();
  for (const cp of checkpoints) {
    const t = tracks.find((x) => x.participant === cp.participant);
    if (!t) continue;
    for (let g = cp.frame; g >= Math.max(0, cp.frame - PROVER_FACE_LOOKBACK_FRAMES); g--) {
      if (g % FACE_SAMPLE_STRIDE !== 0) continue;
      const q = t.frames[g];
      if (!q || q.conf < PRESENCE_MIN) continue;
      const track_id = MOCK_PERSON_TRACK_BASE + t.entity_idx;
      const key = obsKey({ modality: 'face', frame: g, track_id });
      if (seen.has(key)) continue;
      seen.add(key);
      const subject = q.id_conf >= ID_CONF_MIN ? (info.participants[cp.participant]?.user_id ?? null) : null;
      const emb = await ctx.providers.identity.embedFace(mockCrop(info.id, cp.participant, g), { subject_user_id: subject });
      const observed = quantizeEmbedding(emb);
      out.observations.push({ frame: g, modality: 'face', track_id, scores: scoreRow(templates.face, observed) });
      out.observed.set(key, observed);
    }
  }
  return out;
}

/**
 * The proof plan for a set of checkpoints (§8.6 prover input preference):
 * a checkpoint is provable when `proverInput` finds an observation whose
 * embedding satisfies `circuitMatch` against the participant's template.
 */
export function planProofs(
  timeline: FusedTimeline,
  obs: ObservationSet,
  checkpoints: Checkpoint[],
  templates: CandidateTemplates,
): { plans: ProofPlan[]; provable: Checkpoint[] } {
  const plans: ProofPlan[] = [];
  const provable: Checkpoint[] = [];
  for (const cp of checkpoints) {
    const check = (o: IdObservation, tau: number): boolean => {
      const tmpl = (o.modality === 'face' ? templates.face : templates.voice)[cp.participant];
      const observed = obs.observed.get(obsKey(o));
      return !!tmpl && !!observed && circuitMatch(padToCircuit(tmpl), padToCircuit(observed), tau);
    };
    const o = proverInput(timeline, obs.observations, cp, { circuitCheck: check });
    if (!o) continue;
    const observed = obs.observed.get(obsKey(o))!;
    plans.push({
      participant: cp.participant,
      frame: cp.frame,
      modality: o.modality,
      tau_bps: proofTau(o.modality),
      observed: Array.from(observed),
      status: 'pending',
      signature: null,
      error: null,
    });
    provable.push({ participant: cp.participant, frame: cp.frame });
  }
  return { plans, provable };
}

/**
 * Voice observations (§8.5 step 3) from diarized audio-witness segments: the
 * segment's audio is cut from its chunk WAV, embedded (`embedVoice`) and
 * scored against the candidates' voice templates; one observation at the
 * segment's midpoint frame, covering `[start_frame, end_frame]`.
 */
export async function voiceObservations(
  ctx: AppContext,
  info: BetInfo,
  transcripts: AudioWitnessTranscript[],
  templates: CandidateTemplates,
  nFrames: number,
): Promise<ObservationSet> {
  const out: ObservationSet = { observations: [], observed: new Map() };
  if (!templates.voice.some((t) => t !== null)) return out;
  for (const tr of transcripts) {
    for (const seg of tr.segments) {
      const start = Math.max(0, Math.floor(seg.start_ms / 100));
      const end = Math.min(nFrames - 1, Math.floor(Math.max(seg.start_ms, seg.end_ms - 1) / 100));
      if (end < start || end < 0) continue;
      const body = ctx.blobs.getChunk(info.id, tr.witness.witness_key, seg.chunk);
      if (!body) continue;
      let clip: Uint8Array;
      try {
        const wav = decodeWav(body);
        const a = Math.max(0, Math.floor((seg.rel_start_ms * wav.sampleRate) / 1000));
        const b = Math.min(wav.samples.length, Math.ceil((seg.rel_end_ms * wav.sampleRate) / 1000));
        if (b - a < wav.sampleRate / 4) continue; // < 250 ms of speech: too short to embed
        clip = encodeWav(wav.samples.slice(a, b), wav.sampleRate);
      } catch {
        continue;
      }
      const observed = quantizeEmbedding(await ctx.providers.identity.embedVoice(clip, {}));
      const frame = (start + end) >> 1;
      const o: SegmentedIdObservation = {
        frame,
        modality: 'voice',
        track_id: null,
        scores: scoreRow(templates.voice, observed),
        start_frame: start,
        end_frame: end,
      };
      const key = obsKey(o);
      if (out.observed.has(key)) continue;
      out.observations.push(o);
      out.observed.set(key, observed);
    }
  }
  return out;
}

/** §6.1 extension (CONTRACTS-ERRATA backend-audit-faces): face embedding on a `person` line. */
export interface RawFace {
  /** 128 floats, L2-normalized (same model as services/embedder /embed/face) */
  emb: number[];
  /** detector confidence 0..1 */
  conf: number;
}
export type RawDetectionWithFace = RawDetection & { face?: RawFace };

const FRAME_MS = 100;

/** Smallest-t_ms line per (frame, track_id) of anonymous `person` lines, like §6.2 dedup. */
function personLinesByFrame(raw: readonly RawDetectionWithFace[], nFrames: number): Map<string, RawDetectionWithFace> {
  const best = new Map<string, RawDetectionWithFace>();
  for (const d of raw) {
    if (d.entity !== 'person' || typeof d.t_ms !== 'number' || !Number.isFinite(d.t_ms) || d.t_ms < 0) continue;
    const f = Math.floor(d.t_ms / FRAME_MS);
    if (f >= nFrames) continue;
    const k = `${f}#${d.track_id}`;
    const cur = best.get(k);
    if (!cur || d.t_ms < cur.t_ms) best.set(k, d);
  }
  return best;
}

/**
 * Face observations of a real host (§8.5 step 3): every deduplicated person
 * line carrying a `face` embedding on a FACE_SAMPLE_STRIDE frame becomes
 * `{frame, modality:'face', track_id, scores}`; its quantized embedding is
 * kept for the prover (§8.6 preference 1). Sorted by (frame, track_id).
 */
export function faceObservations(raw: readonly RawDetectionWithFace[], templates: CandidateTemplates, nFrames: number): ObservationSet {
  const out: ObservationSet = { observations: [], observed: new Map() };
  if (!templates.face.some((t) => t !== null)) return out;
  const rows: { frame: number; track_id: number; q: Int8Array }[] = [];
  for (const [k, d] of personLinesByFrame(raw, nFrames)) {
    const frame = Number(k.split('#')[0]);
    if (frame % FACE_SAMPLE_STRIDE !== 0 || !d.face || !Array.isArray(d.face.emb) || d.face.emb.length === 0) continue;
    let q: Int8Array;
    try {
      q = quantizeEmbedding(Float64Array.from(d.face.emb));
    } catch {
      continue;
    }
    rows.push({ frame, track_id: d.track_id, q });
  }
  rows.sort((a, b) => a.frame - b.frame || a.track_id - b.track_id);
  for (const r of rows) {
    const o: IdObservation = { frame: r.frame, modality: 'face', track_id: r.track_id, scores: scoreRow(templates.face, r.q) };
    out.observations.push(o as SegmentedIdObservation);
    out.observed.set(obsKey(o), r.q);
  }
  return out;
}

function cosBps(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? Math.round((dot / Math.sqrt(na * nb)) * 10000) : 0;
}

/**
 * §8.5 step 1 re-ID links from the optional `reid` appearance vectors: a
 * track that starts within REID_LOOKBACK_FRAMES after another person track
 * ended inherits from it when the end/start vectors are ≥ REID_SIM_MIN_BPS.
 */
export function reidLinks(raw: readonly RawDetectionWithFace[], persons: PersonTrack[], nFrames: number): ReidLink[] {
  const lines = personLinesByFrame(raw, nFrames);
  const span = new Map<number, { first: number; last: number; firstVec: number[] | null; lastVec: number[] | null }>();
  for (const [k, d] of lines) {
    const f = Number(k.split('#')[0]);
    const vec = Array.isArray(d.reid) && d.reid.length > 0 ? d.reid : null;
    const s = span.get(d.track_id);
    if (!s) {
      span.set(d.track_id, { first: f, last: f, firstVec: vec, lastVec: vec });
      continue;
    }
    if (f < s.first) [s.first, s.firstVec] = [f, vec ?? s.firstVec];
    if (f > s.last) [s.last, s.lastVec] = [f, vec ?? s.lastVec];
  }
  const ids = new Set(persons.map((p) => p.track_id));
  const links: ReidLink[] = [];
  for (const [to, t] of span) {
    if (!ids.has(to) || !t.firstVec) continue;
    for (const [from, s] of span) {
      if (from === to || !ids.has(from) || !s.lastVec) continue;
      if (s.last >= t.first || s.last < t.first - REID_LOOKBACK_FRAMES) continue;
      const sim = cosBps(s.lastVec, t.firstVec);
      if (sim >= REID_SIM_MIN_BPS) links.push({ from_track: from, to_track: to, sim_bps: sim });
    }
  }
  return links.sort((a, b) => a.to_track - b.to_track || a.from_track - b.from_track);
}
