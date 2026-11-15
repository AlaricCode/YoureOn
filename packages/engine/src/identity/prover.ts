/**
 * Prover input selection at checkpoint (p, frame) (§8.6), in order of preference:
 *  1. the most recent face observation on p's stitched track at g ∈ [frame−30, frame],
 *     with cos_bps(p) ≥ τ_face and circuitMatch;
 *  2. otherwise, the voice observation matched to p whose segment covers `frame`;
 *  3. otherwise, no proof (the checkpoint fails ⇒ IDENTITY).
 */
import { PROVER_FACE_LOOKBACK_FRAMES, TAU_FACE_BPS, TAU_VOICE_BPS } from '../constants.js';
import type { Checkpoint, FusedTimeline, IdObservation, Modality } from '../types.js';
import { matchFromScores } from './match.js';

/**
 * An observation with the diarized segment it came from (voice). Voice
 * observations sit at the segment's midpoint frame; `start_frame`/`end_frame`
 * (inclusive) give the segment. Without them the segment is `[frame, frame]`.
 */
export type SegmentedIdObservation = IdObservation & { start_frame?: number; end_frame?: number };

export interface ProverInputOptions {
  /**
   * Exact circuit predicate for an observation (normally
   * `circuitMatch(enrolled_p, observed, tau)` with the stored embeddings).
   * The scores alone cannot decide it exactly; when omitted, only the
   * `cos_bps(p) ≥ τ` condition is applied.
   */
  circuitCheck?: (obs: IdObservation, tau: number) => boolean;
}

function scoreFor(o: IdObservation, p: number): number | null {
  const s = o.scores.find((x) => x.candidate === p);
  return s ? s.cos_bps : null;
}

/** Threshold used for a proof of the given modality (`tau_bps` public input). */
export function proofTau(modality: Modality): number {
  return modality === 'face' ? TAU_FACE_BPS : TAU_VOICE_BPS;
}

export function proverInput(
  timeline: FusedTimeline,
  observations: SegmentedIdObservation[],
  checkpoint: Checkpoint,
  opts: ProverInputOptions = {},
): IdObservation | null {
  const { participant: p, frame } = checkpoint;
  const row = timeline.stitched[p];
  const check = opts.circuitCheck ?? (() => true);

  // 1. faces on p's stitched track, most recent g first
  if (row) {
    let best: { o: IdObservation; g: number; cos: number } | null = null;
    for (const o of observations) {
      if (o.modality !== 'face' || o.track_id === null) continue;
      const g = o.frame;
      if (g < frame - PROVER_FACE_LOOKBACK_FRAMES || g > frame || g < 0 || g >= timeline.n_frames) continue;
      const st = row[g];
      if (!st || st.track_id !== o.track_id) continue;
      const cos = scoreFor(o, p);
      if (cos === null || cos < TAU_FACE_BPS) continue;
      if (!check(o, TAU_FACE_BPS)) continue;
      if (best === null || g > best.g || (g === best.g && cos > best.cos)) best = { o, g, cos };
    }
    if (best) return best.o;
  }

  // 2. voice matched to p whose segment covers the frame
  let bestVoice: { o: IdObservation; cos: number } | null = null;
  for (const o of observations) {
    if (o.modality !== 'voice') continue;
    const start = o.start_frame ?? o.frame;
    const end = o.end_frame ?? o.frame;
    if (frame < start || frame > end) continue;
    const m = matchFromScores(o.scores, 'voice');
    if (!m.matched || m.best !== p) continue;
    if (!check(o, TAU_VOICE_BPS)) continue;
    if (bestVoice === null || m.cos1 > bestVoice.cos) bestVoice = { o, cos: m.cos1 };
  }
  return bestVoice ? bestVoice.o : null;
}
