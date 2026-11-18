// Webhook ingest, one DB transaction per delivery (DATA-MODEL §8.2, API-CONTRACT §5.3–§5.4).
//
//   INSERT INTO chain_events … ON CONFLICT (signature, outer_ix, inner_ix) DO NOTHING RETURNING …
//   projector.apply(tx, inserted)         (same transaction)
//   COMMIT, then publish the chain.* envelopes to the WS hub.
//
// Duplicates alone produce an empty RETURNING, so a replayed delivery is a cheap no-op (§8.3),
// with one exception: a duplicate of a PARKED row (REFOLDABLE_ERRORS: 'not_ours' = no server
// lock signature matched yet, 'unknown_bet' = no bets row yet, 'projector_failed' = stored by the
// deterministic-failure fallback) is handed to the projector again, so the reconciler's / startup
// sweep's rpc_poll copy of the same event un-parks it.
// No RPC calls happen in here: the ack budget is p95 ≤ 150 ms.
import { and, inArray, isNull } from 'drizzle-orm';
import { chainEvents } from '@youre-on/db';
import type { AppDeps } from '../context';
import {
  APPLY_ERROR,
  REFOLDABLE_ERRORS,
  type ChainProjector,
  type Fanout,
  type InsertedChainEvent,
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
  const { inserted, fanout } = await deps.db.transaction(async (tx) => {
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
    const parked = dupes.length ? await parkedDuplicates(tx, dupes) : [];
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
    return { inserted: ins.length, fanout: out };
  });
  publishFanout(deps, fanout);
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

/** Stored rows matching these keys that are still parked (REFOLDABLE_ERRORS, never applied). */
async function parkedDuplicates(
  tx: Tx,
  keys: readonly { signature: string; outer_ix: number; inner_ix: number }[],
): Promise<InsertedChainEvent[]> {
  const want = new Set(keys.map(keyOf));
  const rows = await tx
    .select({
      ...parkedCols,
      signature: chainEvents.signature,
      outer_ix: chainEvents.outer_ix,
      inner_ix: chainEvents.inner_ix,
    })
    .from(chainEvents)
    .where(
      and(
        inArray(chainEvents.signature, [...new Set(keys.map((k) => k.signature))]),
        inArray(chainEvents.apply_error, [...REFOLDABLE_ERRORS]),
        isNull(chainEvents.applied_at),
      ),
    );
  return rows
    .filter((r) => want.has(keyOf(r)))
    .map(({ id, bet_id, event_name, apply_error }) => ({ id, bet_id, event_name, apply_error }));
}

/**
 * Re-folds the parked rows (REFOLDABLE_ERRORS) of these bets inside the caller's transaction, e.g.
 * from a transaction that records a lock signature, so a Stream delivery that beat the signature
 * write is applied at once. (The LockService records chain_txs.signature before it sends, so on
 * the normal path nothing is ever parked for a server lock.) Publish the returned fanout after
 * COMMIT with publishFanout.
 */
export async function refoldParkedInTx(
  tx: Tx,
  projector: ChainProjector,
  betIds: readonly string[],
  nowMs: number,
): Promise<Fanout[]> {
  if (betIds.length === 0) return [];
  const rows = await tx
    .select(parkedCols)
    .from(chainEvents)
    .where(
      and(
        inArray(chainEvents.bet_id, [...betIds]),
        inArray(chainEvents.apply_error, [...REFOLDABLE_ERRORS]),
        isNull(chainEvents.applied_at),
      ),
    );
  return rows.length
    ? projector.apply(
        tx,
        rows.map((r) => ({ ...r, apply_error: null })),
        nowMs,
      )
    : [];
}

/**
 * Fallback after a deterministic projector failure (DATA-MODEL §8.2 step 4: mismatches get a 2xx
 * and an audit row, never a retry). Stores the delivery WITHOUT the projector, one row per
 * statement so a single bad row cannot drop the rest; rows that decoded get apply_error
 * 'projector_failed'. Returns how many rows were newly stored and how many failed to store.
 * Transient errors are rethrown so the caller can still answer 503.
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
