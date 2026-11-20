// Stream-gap reconciler: on every keeper tick, transactions the SERVER sent whose escrow events
// the QuickNode Stream has not delivered within the fallback delay (rpcPollFallbackMs) are fetched
// with getTransaction and ingested as source 'rpc_poll', through the same decoder rules
// (streams.ts eventsFromRpcTransaction mirrors filter.js) and the same projector.
//
// rpc_poll is a DEGRADED mode. The Stream stays the normal source: its copy stamps
// chain_txs.stream_seen_at (then the tx is never polled), whichever copy arrives second is a
// dedupe no-op (a late Stream copy backfills the block position, ingest.ts), and every chain.*
// event says which source observed it (observed_via), so the stage can tell them apart. Without a
// Stream at all (none configured, or a paused or out-of-credits Stream) this keeps the projection
// (onchain_status, chain_ack, payouts, the chain-wins reconcile of missed confirms) and the
// stage's chain ticker working. Anything the server did not send (a permissionless finalize /
// timeout_refund by someone else) arrives only through the Stream: nothing here lists a bet's
// signatures (getSignaturesForAddress).
//
// Spec: docs/planning/DATA-MODEL.md §8.3.
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { bets, chainEvents, chainTxs } from '@youre-on/db';
import { STREAM_FALLBACK_MS } from '@youre-on/shared/constants';
import type { AppDeps } from '../context';
import type { Env } from '../env';
import { eventAuthorityAddress } from './filter-config';
import { isTransientDbError } from './db-errors';
import { ingestChainEvents, publishFanout, refoldParkedInTx, storeUnprojected } from './ingest';
import { APPLY_ERROR, createChainProjector, type ChainProjector } from './projector';
import { eventsFromRpcTransaction } from './streams';
import { isRetriableRpcError, type ChainRuntime } from './tx';

/**
 * The default rpc_poll delay while a Stream is configured. STREAM_FALLBACK_MS (5 s) is shorter
 * than the Stream's normal lag (dataset batches, elastic batching, delivery): rpc_poll would store
 * every server-tx event first, every chain.* event would say observed_via 'rpc_poll', and the
 * Stream's copies would only dedupe. Without a Stream nothing else will come, so 5 s.
 */
export const RPC_POLL_FALLBACK_WITH_STREAM_MS = 30_000;

/**
 * How long a server tx waits for its Stream copy before rpc_poll fetches it: RPC_POLL_FALLBACK_MS,
 * else 30 s with a Stream configured (QN_STREAM_SECURITY_TOKEN), else STREAM_FALLBACK_MS.
 */
export function rpcPollFallbackMs(
  env: Partial<Pick<Env, 'RPC_POLL_FALLBACK_MS' | 'QN_STREAM_SECURITY_TOKEN'>>,
): number {
  if (env.RPC_POLL_FALLBACK_MS !== undefined) return env.RPC_POLL_FALLBACK_MS;
  return env.QN_STREAM_SECURITY_TOKEN ? RPC_POLL_FALLBACK_WITH_STREAM_MS : STREAM_FALLBACK_MS;
}

/** Older server txs are left to the Stream / the operator. */
export const RPC_POLL_MAX_AGE_MS = 30 * 60_000;
/** getTransaction calls per keeper tick. */
export const RPC_POLL_BATCH = 10;
/** Wall-clock budget of one pass's RPC polling; what is left waits for the next tick. */
export const RPC_POLL_BUDGET_MS = 2_000;
/** How often one bet's rejected projection is retried. */
export const REFOLD_RETRY_MS = 60_000;
/** Parked projections are retried for this long (a fix may take a while to ship). */
export const REFOLD_MAX_AGE_MS = 24 * 60 * 60_000;
const BACKOFF_MAX_MS = 60_000;
/** Bets re-folded per tick by retryRejected. */
const REFOLD_BATCH = 5;
/** getBlock calls per tick by fillHeights. */
export const HEIGHT_BATCH = 3;
const HEIGHT_BACKOFF_MS = 30_000;
const HEIGHT_BACKOFF_MAX_MS = 10 * 60_000;

export interface ReconcileResult {
  polled: number;
  /** chain_events rows newly stored from rpc_poll. */
  ingested: number;
  published: number;
  /** getTransaction found nothing yet (still in flight, or never landed). */
  missing: number;
  /** Slots whose block height was backfilled (fillHeights). */
  heights: number;
  /** Bets whose parked projection was retried. */
  refolded: number;
  /** Why polling stopped early: the time budget ran out, or the RPC throttled (429 / 5xx). */
  stopped: 'budget' | 'rpc_throttled' | null;
}

export interface StreamGapOptions {
  projector?: ChainProjector;
  /** Default STREAM_FALLBACK_MS; the server passes rpcPollFallbackMs(env) (keeper/index.ts). */
  fallbackMs?: number;
  maxAgeMs?: number;
  batch?: number;
  refoldRetryMs?: number;
  refoldMaxAgeMs?: number;
  /** Default RPC_POLL_BUDGET_MS. */
  budgetMs?: number;
  /** Wall clock for the budget (ms; default performance.now). Not deps.now: tests shift that. */
  clock?: () => number;
}

type Deps = Pick<AppDeps, 'db' | 'hub' | 'now' | 'log'>;
/** One pass's wall-clock budget for RPC calls. */
interface Budget {
  clock: () => number;
  until: number;
}

export class StreamGapReconciler {
  private readonly backoff = new Map<string, { at: number; delay: number }>();
  private readonly slotBackoff = new Map<number, { at: number; delay: number }>();
  private readonly refoldAt = new Map<string, number>();
  private authority: Promise<string> | null = null;
  private readonly projector: ChainProjector;

  constructor(private readonly o: StreamGapOptions = {}) {
    this.projector = o.projector ?? createChainProjector();
  }

  private eventAuthority(): Promise<string> {
    this.authority ??= eventAuthorityAddress();
    return this.authority;
  }

  private defer(sig: string, nowMs: number, fallback: number) {
    const prev = this.backoff.get(sig);
    const delay = Math.min(prev ? prev.delay * 2 : fallback, BACKOFF_MAX_MS);
    this.backoff.set(sig, { at: nowMs + delay, delay });
  }

  /** One pass: gap-fill from getTransaction, backfill block heights, retry parked projections. */
  async run(deps: Deps, rt: ChainRuntime | null, nowMs: number): Promise<ReconcileResult> {
    const out: ReconcileResult = {
      polled: 0,
      ingested: 0,
      published: 0,
      missing: 0,
      heights: 0,
      refolded: 0,
      stopped: null,
    };
    const clock = this.o.clock ?? (() => performance.now());
    const budget = { clock, until: clock() + (this.o.budgetMs ?? RPC_POLL_BUDGET_MS) };
    await this.fillGaps(deps, rt, nowMs, out, budget);
    if (!out.stopped) await this.fillHeights(deps, rt, nowMs, out, budget);
    out.refolded = await this.retryRejected(deps, nowMs);
    return out;
  }

  /**
   * Fetches the server txs the Stream has not delivered. Bounded: only server-sent txs (chain_txs
   * with a signature and a sent_at, never nonce advances; any status, since a lock marked expired /
   * failed that landed after all is still ours), sent between the fallback delay and maxAge ago,
   * with no chain_events row yet, at most `batch` getTransaction calls per tick, and a
   * per-signature backoff (excluded in SQL, so backed-off rows never starve newer ones). The
   * keeper runs its tasks one after another, so a pass must stay short even when the RPC
   * throttles: the calls go over the client's low-retry poll RPC (tx.ts POLL_RPC_ATTEMPTS),
   * polling stops when the wall-clock budget runs out, and the first 429 / 5xx ends it (the rest
   * waits for the next tick, the rate limit is left to the lock and payout confirms).
   *
   * Oldest first: each tx is its own delivery, and the projector fans a delivery out in arrival
   * order, so polling in send order keeps the chain.* events of one bet in chain order.
   */
  private async fillGaps(
    deps: Deps,
    rt: ChainRuntime | null,
    nowMs: number,
    out: ReconcileResult,
    { clock, until }: Budget,
  ) {
    const client = rt?.client;
    if (!client?.transaction) return;
    const fallback = this.o.fallbackMs ?? STREAM_FALLBACK_MS;
    const maxAge = this.o.maxAgeMs ?? RPC_POLL_MAX_AGE_MS;
    const batch = this.o.batch ?? RPC_POLL_BATCH;
    for (const [sig, b] of this.backoff) if (b.at < nowMs - maxAge) this.backoff.delete(sig);
    const waiting = [...this.backoff].filter(([, b]) => b.at > nowMs).map(([sig]) => sig);

    const rows = await deps.db
      .select({ signature: chainTxs.signature, kind: chainTxs.kind, bet_id: chainTxs.bet_id })
      .from(chainTxs)
      .where(
        and(
          isNotNull(chainTxs.signature),
          isNull(chainTxs.stream_seen_at),
          ne(chainTxs.kind, 'nonce_advance'),
          lte(chainTxs.sent_at, new Date(nowMs - fallback)),
          gte(chainTxs.sent_at, new Date(nowMs - maxAge)),
          waiting.length ? notInArray(chainTxs.signature, waiting) : undefined,
          notExists(
            deps.db
              .select({ one: sql`1` })
              .from(chainEvents)
              .where(eq(chainEvents.signature, chainTxs.signature)),
          ),
        ),
      )
      .orderBy(asc(chainTxs.sent_at))
      .limit(batch);

    for (const r of rows) {
      const sig = r.signature!;
      if (clock() >= until) {
        out.stopped = 'budget';
        break;
      }
      out.polled++;
      try {
        const tx = await client.transaction(sig);
        if (!tx) {
          out.missing++;
          this.defer(sig, nowMs, fallback);
          continue;
        }
        // A failed tx emits nothing the projector may use (the filter drops it too); the tx's own
        // service settles its row. Keep it out of the way.
        const events = eventsFromRpcTransaction(tx, await this.eventAuthority()).events;
        if (events.length === 0) {
          this.backoff.set(sig, { at: nowMs + maxAge, delay: BACKOFF_MAX_MS });
          continue;
        }
        const delivery = { deliveryId: `rpc_poll:${tx.slot ?? '-'}`, source: 'rpc_poll' as const };
        let res;
        try {
          res = await ingestChainEvents(deps, this.projector, events, delivery);
        } catch (err) {
          if (isTransientDbError(err)) throw err;
          // Deterministic (a projector bug): keep the rows, as the webhook does, so retryRejected
          // finishes them after a fix instead of the copy being lost.
          const kept = await storeUnprojected(deps, events, delivery, isTransientDbError);
          deps.log.error('chain.rpc_poll_projector_failed', {
            alert: true,
            bet_id: r.bet_id,
            kind: r.kind,
            err,
            ...kept,
          });
          this.backoff.delete(sig);
          continue;
        }
        this.backoff.delete(sig);
        out.ingested += res.inserted;
        out.published += res.published;
        deps.log.warn('chain.stream_gap_filled', {
          bet_id: r.bet_id,
          kind: r.kind,
          signature: sig,
          events: events.length,
          inserted: res.inserted,
        });
      } catch (err) {
        this.defer(sig, nowMs, fallback);
        deps.log.warn('chain.rpc_poll_failed', { bet_id: r.bet_id, kind: r.kind, err });
        if (isRetriableRpcError(err)) {
          out.stopped = 'rpc_throttled';
          break;
        }
      }
    }
  }

  /**
   * getTransaction has no block height, so rpc_poll asks getBlock for it, best effort. A row left
   * without one cannot be ordered against Stream rows (which carry a height but no slot), and a
   * contested bet (someone else's finalize + close came through the Stream) parks such events as
   * 'not_ours' (projector attributeEvents: order unknown). So, for bets with parked rows, this
   * asks getBlock again, stores the height on every row of that slot and re-folds the bets' parked
   * rows (HEIGHT_BATCH slots per tick, a per-slot backoff, the pass's budget): a payout of ours is
   * never dropped for want of a block height.
   */
  private async fillHeights(
    deps: Deps,
    rt: ChainRuntime | null,
    nowMs: number,
    out: ReconcileResult,
    { clock, until }: Budget,
  ) {
    const client = rt?.client;
    if (!client?.blockHeightAt) return;
    const maxAge = this.o.refoldMaxAgeMs ?? REFOLD_MAX_AGE_MS;
    for (const [slot, b] of this.slotBackoff)
      if (b.at < nowMs - maxAge) this.slotBackoff.delete(slot);
    const waiting = [...this.slotBackoff].filter(([, b]) => b.at > nowMs).map(([slot]) => slot);
    const parked = alias(chainEvents, 'parked');
    const rows = await deps.db
      .selectDistinct({ slot: chainEvents.slot })
      .from(chainEvents)
      .where(
        and(
          isNotNull(chainEvents.slot),
          isNull(chainEvents.block_height),
          gte(chainEvents.received_at, new Date(nowMs - maxAge)),
          waiting.length ? notInArray(chainEvents.slot, waiting) : undefined,
          exists(
            deps.db
              .select({ one: sql`1` })
              .from(parked)
              .where(
                and(
                  eq(parked.bet_id, chainEvents.bet_id),
                  eq(parked.apply_error, APPLY_ERROR.notOurs),
                ),
              ),
          ),
        ),
      )
      .limit(HEIGHT_BATCH);
    for (const { slot } of rows) {
      const s = slot!;
      if (clock() >= until) {
        out.stopped = 'budget';
        break;
      }
      let height: number | null;
      try {
        height = await client.blockHeightAt(s);
      } catch (err) {
        this.deferSlot(s, nowMs, HEIGHT_BACKOFF_MAX_MS);
        deps.log.warn('chain.block_height_failed', { slot: s, err });
        if (isRetriableRpcError(err)) {
          out.stopped = 'rpc_throttled';
          break;
        }
        continue;
      }
      if (height === null) {
        // the RPC knows no height for that block: asking again soon will not change that
        this.slotBackoff.set(s, { at: nowMs + maxAge, delay: maxAge });
        continue;
      }
      try {
        const fan = await deps.db.transaction(async (tx) => {
          const owners = await tx
            .selectDistinct({ bet_id: chainEvents.bet_id })
            .from(chainEvents)
            .where(and(eq(chainEvents.slot, s), isNotNull(chainEvents.bet_id)));
          const betIds = owners.map((o) => o.bet_id!).sort();
          // the projector's lock order (bets, then their chain_events rows)
          if (betIds.length)
            await tx
              .select({ id: bets.id })
              .from(bets)
              .where(inArray(bets.id, betIds))
              .orderBy(asc(bets.id))
              .for('update');
          await tx
            .update(chainEvents)
            .set({ block_height: height })
            .where(and(eq(chainEvents.slot, s), isNull(chainEvents.block_height)));
          return refoldParkedInTx(tx, this.projector, betIds, nowMs, deps.log);
        });
        publishFanout(deps, fan);
        this.slotBackoff.delete(s);
        out.heights++;
        out.published += fan.length;
        deps.log.warn('chain.block_height_backfilled', { slot: s, published: fan.length });
      } catch (err) {
        if (isTransientDbError(err)) throw err;
        this.deferSlot(s, nowMs, HEIGHT_BACKOFF_MAX_MS);
        deps.log.error('chain.block_height_backfill_failed', { alert: true, slot: s, err });
      }
    }
  }

  private deferSlot(slot: number, nowMs: number, max: number) {
    const prev = this.slotBackoff.get(slot);
    const delay = Math.min(prev ? prev.delay * 2 : HEIGHT_BACKOFF_MS, max);
    this.slotBackoff.set(slot, { at: nowMs + delay, delay });
  }

  /**
   * Re-folds bets whose projection is parked ('projection_rejected' / 'projector_failed': a CHECK,
   * trigger or projector bug refused the bets write) every REFOLD_RETRY_MS for REFOLD_MAX_AGE_MS,
   * so a fix by hand or a redeploy completes them even when no later event will ever arrive. A
   * retry that is still rejected only logs (the first rejection was audited).
   */
  async retryRejected(deps: Deps, nowMs: number): Promise<number> {
    const every = this.o.refoldRetryMs ?? REFOLD_RETRY_MS;
    const maxAge = this.o.refoldMaxAgeMs ?? REFOLD_MAX_AGE_MS;
    for (const [bet, at] of this.refoldAt) if (at < nowMs - maxAge) this.refoldAt.delete(bet);
    const waiting = [...this.refoldAt].filter(([, at]) => at > nowMs).map(([bet]) => bet);
    const rows = await deps.db
      .selectDistinct({ bet_id: chainEvents.bet_id })
      .from(chainEvents)
      .where(
        and(
          isNotNull(chainEvents.bet_id),
          inArray(chainEvents.apply_error, [
            APPLY_ERROR.projectionRejected,
            APPLY_ERROR.projectorFailed,
          ]),
          gte(chainEvents.received_at, new Date(nowMs - maxAge)),
          waiting.length ? notInArray(chainEvents.bet_id, waiting) : undefined,
        ),
      )
      .limit(REFOLD_BATCH);
    let n = 0;
    for (const { bet_id } of rows) {
      const betId = bet_id!;
      this.refoldAt.set(betId, nowMs + every);
      try {
        const fan = await deps.db.transaction((tx) =>
          refoldParkedInTx(tx, this.projector, [betId], nowMs, deps.log),
        );
        publishFanout(deps, fan);
        n++;
      } catch (err) {
        deps.log.warn('chain.refold_failed', { bet_id: betId, err });
      }
    }
    return n;
  }
}
