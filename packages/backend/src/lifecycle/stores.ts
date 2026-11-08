/**
 * Typed access to the lifecycle collections.
 */
import type { AppContext } from '../context.js';
import type { Collection } from '../persistence/store.js';
import {
  LC_COLLECTIONS,
  type ChunkArchiveRecord,
  type ChunkMetaRecord,
  type LiveRecord,
  type PerceptionRecord,
  type SceneRecord,
  type WitnessListRecord,
} from './records.js';

export interface LifecycleStores {
  scenes: Collection<SceneRecord>;
  witnesses: Collection<WitnessListRecord>;
  chunks: Collection<ChunkMetaRecord>;
  live: Collection<LiveRecord>;
  perception: Collection<PerceptionRecord>;
  chunkArchive: Collection<ChunkArchiveRecord>;
}

export function lifecycleStores(ctx: AppContext): LifecycleStores {
  return {
    scenes: ctx.store.collection<SceneRecord>(LC_COLLECTIONS.scenes),
    witnesses: ctx.store.collection<WitnessListRecord>(LC_COLLECTIONS.witnesses),
    chunks: ctx.store.collection<ChunkMetaRecord>(LC_COLLECTIONS.chunks),
    live: ctx.store.collection<LiveRecord>(LC_COLLECTIONS.live),
    perception: ctx.store.collection<PerceptionRecord>(LC_COLLECTIONS.perception),
    chunkArchive: ctx.store.collection<ChunkArchiveRecord>(LC_COLLECTIONS.chunkArchive),
  };
}

export const chunkId = (bet: string, witness: string, index: number): string => `${bet}:${witness}:${index}`;

/** All chunk records of one witness, ascending by index. */
export function witnessChunks(s: LifecycleStores, bet: string, witness: string): ChunkMetaRecord[] {
  const hot = s.chunks.filter((c) => c.bet === bet && c.witness_key === witness);
  const rows = hot.length > 0 ? hot : (s.chunkArchive.get(bet)?.chunks.filter((c) => c.witness_key === witness) ?? []);
  return rows.sort((a, b) => a.index - b.index);
}

/** Moves a terminal bet's chunk records into one archive record (one write, out of the hot collection). */
export function archiveBetChunks(s: LifecycleStores, bet: string, nowMs: number): number {
  const rows = s.chunks.filter((c) => c.bet === bet);
  if (rows.length === 0) return 0;
  const prev = s.chunkArchive.get(bet)?.chunks ?? [];
  s.chunkArchive.set(bet, { bet, chunks: [...prev, ...rows], archived_at_ms: nowMs });
  for (const r of rows) s.chunks.delete(r.id);
  return rows.length;
}

/**
 * Makes the scene's current calibration the one committed onchain (the first
 * `fund` fixes `bet.calibration_hash`): a later PUT that slipped in before
 * the fund landed is rolled back to the committed entry of `history`.
 * Returns the committed calibration (null when unknown to this backend), or
 * the current one while nothing is committed.
 */
export function pinCommittedCalibration(s: LifecycleStores, betId: string, committedHash: string): SceneRecord | null {
  const scene = s.scenes.get(betId) ?? null;
  if (!scene || /^0+$/.test(committedHash) || scene.calibration_hash === committedHash) return scene;
  const cal = scene.history?.[committedHash];
  if (!cal) return null;
  const pinned: SceneRecord = { ...scene, calibration: cal, calibration_hash: committedHash };
  s.scenes.set(betId, pinned);
  return pinned;
}
