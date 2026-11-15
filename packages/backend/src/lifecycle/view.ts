/**
 * Read-only lifecycle facts for other services (BetView §12.2, Receipt
 * §12.11, booth §10.1): calibration, witnesses, timing, evidence stats and
 * the perception summary. Never throws for unknown bets.
 */
import type { Calibration, CrossCheckResult } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { BLOB_NS_PERCEPTION, sealedBlobKey } from './perception.js';
import type { PerceptionHostInfo, ProofPlan } from './records.js';
import { lifecycleStores, witnessChunks } from './stores.js';

export interface LifecycleView {
  calibration: Calibration | null;
  calibration_hash: string | null;
  started_at_ms: number | null;
  t0_ms: number | null;
  ended_at_ms: number | null;
  witnesses: { id: string; label: string; kind: 'camera' | 'audio' | 'detections'; user_id: string | null; synced: boolean | null }[];
  evidence: { label: string; witness_key: string; chunks: number; synced: boolean; gap: boolean; late_chunks: number; gaps_ms: number[] }[];
  perception: {
    step: string;
    hosts: PerceptionHostInfo[];
    cross: CrossCheckResult | null;
    cross_check_ok: boolean;
    audio_disagree: boolean;
    phone_disagree: boolean;
    window_unavailable: boolean;
    perception_root: string;
    proofs: Pick<ProofPlan, 'participant' | 'frame' | 'modality' | 'status' | 'signature'>[];
  } | null;
}

/** §12.11 evidence row data: per-witness chunk counts, gaps (≤ CHUNK_GAP_MAX_MS tolerated) and late records. */
function evidenceStats(ctx: AppContext, betId: string) {
  const s = lifecycleStores(ctx);
  const list = s.witnesses.get(betId)?.witnesses ?? [];
  return list.map((w) => {
    const cs = witnessChunks(s, betId, w.witness_key);
    const gaps: number[] = [];
    let gap = false;
    for (let i = 1; i < cs.length; i++) {
      const d = cs[i]!.start_ms - (cs[i - 1]!.start_ms + cs[i - 1]!.duration_ms);
      if (d > 500) gap = true;
      else if (d > 0) gaps.push(d);
    }
    return {
      label: w.label,
      witness_key: w.witness_key,
      chunks: cs.length,
      synced: w.synced === true,
      gap,
      late_chunks: cs.filter((c) => c.late).length,
      gaps_ms: gaps,
    };
  });
}

export function lifecycleView(ctx: AppContext, betId: string): LifecycleView {
  const s = lifecycleStores(ctx);
  const scene = s.scenes.get(betId);
  const live = s.live.get(betId);
  const per = s.perception.get(betId);
  return {
    calibration: scene?.calibration ?? null,
    calibration_hash: scene?.calibration_hash ?? null,
    started_at_ms: live?.started_at_ms ?? null,
    t0_ms: live?.t0_ms ?? null,
    ended_at_ms: live?.ended_at_ms ?? null,
    witnesses: (s.witnesses.get(betId)?.witnesses ?? []).map((w) => ({
      id: w.witness_key,
      label: w.label,
      kind: w.kind,
      user_id: w.user_id,
      synced: w.synced,
    })),
    evidence: evidenceStats(ctx, betId),
    perception: per
      ? {
          step: per.step,
          hosts: per.hosts,
          cross: per.cross,
          cross_check_ok: (per.flags & 0x02) !== 0,
          audio_disagree: per.audio_disagree,
          phone_disagree: per.phone_disagree,
          window_unavailable: per.window_unavailable,
          perception_root: per.perception_root,
          proofs: per.proofs.map((p) => ({ participant: p.participant, frame: p.frame, modality: p.modality, status: p.status, signature: p.signature })),
        }
      : null,
  };
}

/** The sealed host-A SessionTracks (exhibits, booth re-evaluation), or null. */
export function sealedSession(ctx: AppContext, betId: string): unknown {
  try {
    const b = ctx.blobs.getBlob(BLOB_NS_PERCEPTION, sealedBlobKey(betId));
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  } catch {
    return null;
  }
}
