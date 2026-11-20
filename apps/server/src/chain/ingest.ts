// Webhook ingest, one DB transaction per delivery:
//
//   INSERT INTO chain_events … ON CONFLICT (signature, outer_ix, inner_ix) DO NOTHING RETURNING …
//   projector.apply(tx, inserted)         (same transaction)
//   COMMIT, then publish the chain.* envelopes to the WS hub.
//
// Duplicates alone produce an empty RETURNING, so a replayed delivery is a cheap no-op, with two
// exceptions (storedDuplicates): a duplicate of a PARKED row goes back to the projector, so a later
// copy of the same event un-parks it; and a Stream copy of a row rpc_poll stored first backfills
// its block position and chain_txs.stream_seen_at (chain.stream_seen is logged after COMMIT, so the
// Streams latency is measured whichever copy came first).
// No RPC calls happen in here: the ack budget is p95 ≤ 150 ms.
//
// Spec: docs/planning/DATA-MODEL.md §8.2.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { chainEvents, chainTxs } from '@youre-on/db';
import type { Logger } from '../log';
import type { AppDeps } from '../context';
import {
  APPLY_ERROR,
  logStreamSeen,
  REFOLDABLE_ERRORS,
  streamSeenCols,
  type ChainProjector,
  type Fanout,
  type InsertedChainEvent,
  type StreamSeen,
  type Tx,
} from './projector';
import type { ParsedChainEvent } from './streams';

const keyOf = (r: { signature: string; outer_ix: number; inner_ix: number }) =>
  `${r.signature}:${r.outer_ix}:${r.inner_ix}`;

const parkedCols = {
  id: chainEvents.id,
  bet_id: chainEvents.bet_id,
  event_name: chainEvents.event_name,
  apply_error: chainEvents.apply_error,
};

export interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  published: number;
}

export async function ingestChainEvents(
  deps: Pick<AppDeps, 'db' | 'hub' | 'now'> & Partial<Pick<AppDeps, 'log'>>,
  projector: ChainProjector,
  events: readonly ParsedChainEvent[],
  o: { deliveryId: string | null; source?: 'stream' | 'rpc_poll' },
): Promise<IngestResult> {
  if (events.length === 0) return { received: 0, inserted: 0, duplicates: 0, published: 0 };
  const nowMs = deps.now();
  const rows = toRows(events, o, nowMs);
  const { inserted, fanout, seen } = await deps.db.transaction(async (tx) => {
    const ins = await tx
      .insert(chainEvents)
      .values(rows)
      .onConflictDoNothing({
        target: [chainEvents.signature, chainEvents.outer_ix, chainEvents.inner_ix],
      })
      .returning({
        ...parkedCols,
        signature: chainEvents.signature,
        outer_ix: chainEvents.outer_ix,
        inner_ix: chainEvents.inner_ix,
      });
    const fresh = new Set(ins.map(keyOf));
    const dupes = rows.filter((r) => !fresh.has(keyOf(r)));
    const { parked, seen } = dupes.length
      ? await storedDuplicates(tx, dupes, nowMs)
      : { parked: [], seen: [] };
    const toApply: InsertedChainEvent[] = [
      ...ins.map(({ id, bet_id, event_name, apply_error }) => ({
        id,
        bet_id,
        event_name,
        apply_error,
      })),
      // Parked rows go in as fresh (apply_error cleared) so the projector re-checks attribution.
      ...parked.map((r) => ({ ...r, apply_error: null })),
    ];
    const out = toApply.length ? await projector.apply(tx, toApply, nowMs, deps.log) : [];
    return { inserted: ins.length, fanout: out, seen };
  });
  publishFanout(deps, fanout);
  if (deps.log) logStreamSeen(deps.log, seen, nowMs);
  return {
    received: events.length,
    inserted,
    duplicates: events.length - inserted,
    published: fanout.length,
  };
}

function toRows(
  events: readonly ParsedChainEvent[],
  o: { deliveryId: string | null; source?: 'stream' | 'rpc_poll' },
  nowMs: number,
) {
  return events.map((e) => ({
    signature: e.signature,
    outer_ix: e.outer_ix,
    inner_ix: e.inner_ix,
    slot: e.slot,
    block_height: e.block_height,
    tx_index: e.tx_index,
    block_time: e.block_time_s === null ? null : new Date(e.block_time_s * 1000),
    program_id: e.program_id,
    event_name: e.event_name,
    bet_id: e.bet_id,
    payload: e.payload,
    raw_b64: e.raw_b64,
    source: o.source ?? ('stream' as const),
    delivery_id: o.deliveryId,
    received_at: new Date(nowMs),
    apply_error: e.apply_error,
  }));
}

/** After COMMIT: bet:<id> (+ the room's stage), and both parties' user channels when given. */
export function publishFanout(deps: Pick<AppDeps, 'hub'>, fanout: readonly Fanout[]): void {
  for (const f of fanout) {
    deps.hub.publishBetEvent(f.envelope, f.room_id);
    for (const u of f.user_ids ?? []) deps.hub.publishToUser(u, f.envelope);
  }
}

/**
 * The stored twins of this delivery's duplicates. Returns the ones still parked
 * (REFOLDABLE_ERRORS) for the projector. A Stream copy of a row an rpc_poll copy stored first also
 * backfills what getTransaction could not give (block_height, tx_index: attribution orders by
 * them) and stamps chain_txs.stream_seen_at (the Stream did see the tx); `seen` is what it
 * stamped, for the chain.stream_seen latency log (the projector logs it for first copies).
 */
async function storedDuplicates(
  tx: Tx,
  dupes: readonly ReturnType<typeof toRows>[number][],
  nowMs: number,
): Promise<{ parked: InsertedChainEvent[]; seen: StreamSeen[] }> {
  const incoming = new Map(dupes.map((d) => [keyOf(d), d]));
  const rows = await tx
    .select({
      ...parkedCols,
      signature: chainEvents.signature,
      outer_ix: chainEvents.outer_ix,
      inner_ix: chainEvents.inner_ix,
      block_height: chainEvents.block_height,
      tx_index: chainEvents.tx_index,
      source: chainEvents.source,
    })
    .from(chainEvents)
    .where(inArray(chainEvents.signature, [...new Set(dupes.map((k) => k.signature))]));
  const mine = rows.filter((r) => incoming.has(keyOf(r)));
  /** signature -> the source of its stored copy, for the Stream copies of this delivery. */
  const backfilled = new Map<string, 'stream' | 'rpc_poll'>();
  for (const r of mine) {
    const d = incoming.get(keyOf(r))!;
    if (d.source !== 'stream') continue;
    backfilled.set(r.signature, r.source === 'rpc_poll' ? 'rpc_poll' : 'stream');
    const block_height = r.block_height ?? d.block_height;
    const tx_index = r.tx_index ?? d.tx_index;
    if (block_height !== r.block_height || tx_index !== r.tx_index)
      await tx.update(chainEvents).set({ block_height, tx_index }).where(eq(chainEvents.id, r.id));
  }
  const stamped = backfilled.size
    ? await tx
        .update(chainTxs)
        .set({ stream_seen_at: new Date(nowMs) })
        .where(
          and(inArray(chainTxs.signature, [...backfilled.keys()]), isNull(chainTxs.stream_seen_at)),
        )
        .returning({ ...streamSeenCols, signature: chainTxs.signature })
    : [];
  return {
    parked: mine
      .filter((r) => r.apply_error !== null && REFOLDABLE_ERRORS.includes(r.apply_error))
      .map(({ id, bet_id, event_name, apply_error }) => ({ id, bet_id, event_name, apply_error })),
    seen: stamped.map(({ signature, ...s }) => ({
      ...s,
      first_copy: backfilled.get(signature!) ?? 'stream',
    })),
  };
}

/**
 * Re-folds the parked rows (REFOLDABLE_ERRORS) of these bets inside the caller's transaction (the
 * reconciler's height backfill and retry pass). The LockService records chain_txs.signature before
 * it sends, so on the normal path nothing is ever parked for a server lock. Publish the returned
 * fanout after COMMIT with publishFanout.
 */
export async function refoldParkedInTx(
  tx: Tx,
  projector: ChainProjector,
  betIds: readonly string[],
  nowMs: number,
  log?: Logger,
): Promise<Fanout[]> {
  if (betIds.length === 0) return [];
  const rows = await tx
    .select(parkedCols)
    .from(chainEvents)
    .where(
      and(
        inArray(chainEvents.bet_id, [...betIds]),
        inArray(chainEvents.apply_error, [...REFOLDABLE_ERRORS]),
      ),
    );
  return rows.length
    ? projector.apply(
        tx,
        rows.map((r) => ({ ...r, apply_error: null })),
        nowMs,
        log,
      )
    : [];
}

/**
 * Fallback after a deterministic projector failure (a mismatch gets a 2xx and an audit row, never
 * a retry). Stores the delivery WITHOUT the projector, one row per statement so a single bad row
 * cannot drop the rest; rows that decoded get apply_error 'projector_failed'. Returns how many
 * rows were newly stored and how many failed to store. Transient errors are rethrown so the
 * caller can still answer 503.
 */
export async function storeUnprojected(
  deps: Pick<AppDeps, 'db' | 'now'>,
  events: readonly ParsedChainEvent[],
  o: { deliveryId: string | null; source?: 'stream' | 'rpc_poll' },
  isTransient: (e: unknown) => boolean,
): Promise<{ stored: number; failed: number }> {
  let stored = 0;
  let failed = 0;
  for (const r of toRows(events, o, deps.now())) {
    try {
      const ins = await deps.db
        .insert(chainEvents)
        .values({ ...r, apply_error: r.apply_error ?? APPLY_ERROR.projectorFailed })
        .onConflictDoNothing({
          target: [chainEvents.signature, chainEvents.outer_ix, chainEvents.inner_ix],
        })
        .returning({ id: chainEvents.id });
      stored += ins.length;
    } catch (e) {
      if (isTransient(e)) throw e;
      failed++;
    }
  }
  return { stored, failed };
}
