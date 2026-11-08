/**
 * Exact resolvers for the read seam other services use
 * (integration/sources.ts `setBetSources`): chunk records, witnesses and the
 * perception summary as this service stores them.
 */
import type { ChunkMeta, PerceptionMeta, WitnessMeta } from '../integration/sources.js';
import { witnessChunks, type LifecycleStores } from './stores.js';

export function chunkMetas(s: LifecycleStores, betId: string, witnessKey: string): ChunkMeta[] {
  return witnessChunks(s, betId, witnessKey).map((c) => ({
    witness_key: c.witness_key,
    index: c.index,
    kind: c.kind,
    body_format: c.body_format,
    start_ms: c.start_ms,
    duration_ms: c.duration_ms,
    body_sha256: c.body_sha256,
    chunk_hash: c.chunk_hash,
    prev_hash: c.prev_hash,
    final: c.final,
    late: c.late,
  }));
}

export function witnessMetas(s: LifecycleStores, betId: string): WitnessMeta[] {
  return (s.witnesses.get(betId)?.witnesses ?? []).map((w) => ({
    witness_key: w.witness_key,
    kind: w.kind,
    user_id: w.user_id,
    label: w.label,
    offset_ms: w.offset_ms,
    synced: w.synced,
  }));
}

export function perceptionMeta(s: LifecycleStores, betId: string): PerceptionMeta | null {
  const r = s.perception.get(betId);
  if (!r || r.step === 'pending' || r.step === 'failed') return null;
  return {
    hosts: r.hosts.map((h) => ({ ...h })),
    agreed: r.cross?.ok ?? false,
    entity_agreement_bps: { ...(r.cross?.entity_agreement_bps ?? {}) },
    audio_disagree: r.audio_disagree,
    phone_disagree: r.phone_disagree,
  };
}
