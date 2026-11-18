// Stream-gap reconciler (DATA-MODEL §8.3 "Gaps", ARCHITECTURE §3 "Background loops" / data flow,
// API-CONTRACT §5.4 "Reconciler"): on every keeper tick, transactions the SERVER sent whose
// escrow events the QuickNode Stream has not delivered within STREAM_FALLBACK_MS are fetched with
// getTransaction and ingested as source 'rpc_poll', through the same decoder rules
// (streams.ts eventsFromRpcTransaction = filter.js rules 1-5) and the same projector.
//
// rpc_poll is a DEGRADED mode. The Stream stays the normal source: its copy stamps
// chain_txs.stream_seen_at (then the tx is never polled), whichever copy arrives second is a
// dedupe no-op (a late Stream copy backfills the block position, ingest.ts), and every chain.*
// event says which source observed it (observed_via), so the stage can tell them apart. Without a
// Stream at all (the QuickNode key is pending, a paused or out-of-credits Stream) this keeps the
// projection (onchain_status, chain_ack, payouts, the chain-wins reconcile of missed confirms) and
// the stage's chain ticker working.
//
// Bounded: only server-sent txs (chain_txs with a signature and a sent_at, never nonce advances;
// any status, since a lock marked expired / failed that landed after all is still ours), sent
// between STREAM_FALLBACK_MS and RPC_POLL_MAX_AGE_MS ago, with no chain_events row yet, at most
// RPC_POLL_BATCH getTransaction calls per tick, and a per-signature backoff (excluded in SQL, so
// backed-off rows never starve newer ones). Anything the server did not send (a permissionless
// finalize / timeout_refund by someone else) only arrives through the Stream (the startup sweep
// over getSignaturesForAddress(bet_pda) is not built).
//
// Oldest first: each tx is its own delivery, and the projector fans a delivery out in arrival
// order, so polling in send order keeps the chain.* events of one bet in chain order.
//
// Second pass, retryRejected: bets whose projection is parked ('projection_rejected' /
// 'projector_failed': a CHECK, trigger or projector bug refused the bets write) are re-folded
// every REFOLD_RETRY_MS for REFOLD_MAX_AGE_MS, so a fix by hand or a redeploy completes them even
// when no later event will ever arrive. A retry that is still rejected only logs (the first
// rejection was audited).
import {
  and,
  asc,
  eq,
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
import { chainEvents, chainTxs } from '@youre-on/db';
import { STREAM_FALLBACK_MS } from '@youre-on/shared/constants';
import type { AppDeps } from '../context';
import { eventAuthorityAddress } from './filter-config';
import { isTransientDbError } from './db-errors';
import { ingestChainEvents, publishFanout, refoldParkedInTx, storeUnprojected } from './ingest';
import { APPLY_ERROR, createChainProjector, type ChainProjector } from './projector';
import { eventsFromRpcTransaction } from './streams';
import type { ChainRuntime } from './tx';

/** Older server txs are left to the Stream / the operator. */
export const RPC_POLL_MAX_AGE_MS = 30 * 60_000;
/** getTransaction calls per keeper tick. */
export const RPC_POLL_BATCH = 10;
/** How often one bet's rejected projection is retried. */
export const REFOLD_RETRY_MS = 60_000;
/** Parked projections are retried for this long (a fix may take a while to ship). */
export const REFOLD_MAX_AGE_MS = 24 * 60 * 60_000;
const BACKOFF_MAX_MS = 60_000;
/** Bets re-folded per tick by retryRejected. */
const REFOLD_BATCH = 5;

export interface ReconcileResult {
  polled: number;
  /** chain_events rows newly stored from rpc_poll. */
  ingested: number;
  published: number;
  /** getTransaction found nothing yet (still in flight, or never landed). */
  missing: number;
  /** Bets whose parked projection was retried. */
  refolded: number;
}

export interface StreamGapOptions {
  projector?: ChainProjector;
  fallbackMs?: number;
  maxAgeMs?: number;
  batch?: number;
  refoldRetryMs?: number;
  refoldMaxAgeMs?: number;
}

type Deps = Pick<AppDeps, 'db' | 'hub' | 'now' | 'log'>;

export class StreamGapReconciler {
  private readonly backoff = new Map<string, { at: number; delay: number }>();
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

  /** One pass: gap-fill from getTransaction, then retry parked projections. */
  async run(deps: Deps, rt: ChainRuntime | null, nowMs: number): Promise<ReconcileResult> {
    const out: ReconcileResult = { polled: 0, ingested: 0, published: 0, missing: 0, refolded: 0 };
    await this.fillGaps(deps, rt, nowMs, out);
    out.refolded = await this.retryRejected(deps, nowMs);
    return out;
  }

  private async fillGaps(deps: Deps, rt: ChainRuntime | null, nowMs: number, out: ReconcileResult) {
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
      out.polled++;
      try {
        const tx = await client.transaction(sig);
        if (!tx) {
          out.missing++;
          this.defer(sig, nowMs, fallback);
          continue;
        }
        // A failed tx emits nothing the projector may use (filter rule 1); the tx's own service
        // settles its row. Keep it out of the way.
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
      }
    }
  }

  /** Re-folds bets whose projection is parked as rejected / failed (see the header). */
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
