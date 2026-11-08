/**
 * Typed access to the lifecycle collections.
 */
import type { AppContext } from '../context.js';
import type { Collection } from '../persistence/store.js';
import {
  LC_COLLECTIONS,
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
}

export function lifecycleStores(ctx: AppContext): LifecycleStores {
  return {
    scenes: ctx.store.collection<SceneRecord>(LC_COLLECTIONS.scenes),
    witnesses: ctx.store.collection<WitnessListRecord>(LC_COLLECTIONS.witnesses),
    chunks: ctx.store.collection<ChunkMetaRecord>(LC_COLLECTIONS.chunks),
    live: ctx.store.collection<LiveRecord>(LC_COLLECTIONS.live),
    perception: ctx.store.collection<PerceptionRecord>(LC_COLLECTIONS.perception),
  };
}

export const chunkId = (bet: string, witness: string, index: number): string => `${bet}:${witness}:${index}`;

/** All chunk records of one witness, ascending by index. */
export function witnessChunks(s: LifecycleStores, bet: string, witness: string): ChunkMetaRecord[] {
  return s.chunks.filter((c) => c.bet === bet && c.witness_key === witness).sort((a, b) => a.index - b.index);
}
