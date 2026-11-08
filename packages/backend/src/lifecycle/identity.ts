/**
 * In-game identity for actor-bound legs (§8.5, §8.6): candidate templates,
 * observations, the fused identity timeline, and the proof plan (which
 * checkpoints can be proven, with which observed embedding).
 *
 * - Real hosts (RawDetection): anonymous person tracks (`quantizePersonTracks`)
 *   + voice observations from the audio witnesses (STT diarized segments,
 *   ECAPA-class `embedVoice` on each segment) → `fuseTimeline` → `bindPersons`.
 *   Face observations need face crops from the footage, which the perception
 *   job does not return yet (TODO: services/perception face crops), so real
 *   runs currently rely on voice.
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
