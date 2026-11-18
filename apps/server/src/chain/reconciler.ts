// Stream-gap reconciler (DATA-MODEL §8.3 "Gaps", ARCHITECTURE §3 "Background loops" / data flow,
// API-CONTRACT §5.4 "Reconciler"): on every keeper tick, transactions the SERVER sent whose
// escrow events the QuickNode Stream has not delivered within STREAM_FALLBACK_MS are fetched with
// getTransaction and ingested as source 'rpc_poll', through the same decoder rules
// (streams.ts eventsFromRpcTransaction = filter.js rules 1-5) and the same projector.
//
// rpc_poll is a DEGRADED mode. The Stream stays the normal source: its copy stamps
// chain_txs.stream_seen_at (then the tx is never polled), whichever copy arrives second is a
// dedupe no-op, and every chain.* event says which source observed it (observed_via), so the
// stage can tell them apart. Without a Stream at all (the QuickNode key is pending, a paused or
// out-of-credits Stream) this keeps the projection (onchain_status, chain_ack, payouts, the
// chain-wins reconcile of missed confirms) and the stage's chain ticker working.
//
// Bounded: only server-sent txs (chain_txs with a signature, never nonce advances), sent between
// STREAM_FALLBACK_MS and RPC_POLL_MAX_AGE_MS ago, with no chain_events row yet, at most
// RPC_POLL_BATCH getTransaction calls per tick, and a per-signature backoff while one is not
// found. Anything the server did not send (a permissionless finalize / timeout_refund by someone
// else) only arrives through the Stream (or the startup sweep, which is not built yet).
//
// Oldest first: each tx is its own delivery, and the projector fans a delivery out in arrival
// order, so polling in send order keeps the chain.* events of one bet in chain order.
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
  sql,
} from 'drizzle-orm';
import { chainEvents, chainTxs } from '@youre-on/db';
import { STREAM_FALLBACK_MS } from '@youre-on/shared/constants';
import type { AppDeps } from '../context';
import { eventAuthorityAddress } from './filter-config';
import { ingestChainEvents } from './ingest';
import { createChainProjector, type ChainProjector } from './projector';
import { eventsFromRpcTransaction } from './streams';
import type { ChainRuntime } from './tx';

/** Older server txs are left to the Stream / the operator. */
export const RPC_POLL_MAX_AGE_MS = 30 * 60_000;
/** getTransaction calls per keeper tick. */
export const RPC_POLL_BATCH = 10;
const BACKOFF_MAX_MS = 60_000;

export interface ReconcileResult {
  polled: number;
  /** chain_events rows newly stored from rpc_poll. */
  ingested: number;
  published: number;
  /** getTransaction found nothing yet (still in flight, or never landed). */
  missing: number;
}

export interface StreamGapOptions {
  projector?: ChainProjector;
  fallbackMs?: number;
  maxAgeMs?: number;
  batch?: number;
}

type Deps = Pick<AppDeps, 'db' | 'hub' | 'now' | 'log'>;

export class StreamGapReconciler {
  private readonly backoff = new Map<string, { at: number; delay: number }>();
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

  /** One pass. A no-op when the chain is not configured or the client cannot getTransaction. */
  async run(deps: Deps, rt: ChainRuntime | null, nowMs: number): Promise<ReconcileResult> {
    const out: ReconcileResult = { polled: 0, ingested: 0, published: 0, missing: 0 };
    const client = rt?.client;
    if (!client?.transaction) return out;
    const fallback = this.o.fallbackMs ?? STREAM_FALLBACK_MS;
    const maxAge = this.o.maxAgeMs ?? RPC_POLL_MAX_AGE_MS;
    const batch = this.o.batch ?? RPC_POLL_BATCH;
    for (const [sig, b] of this.backoff) if (b.at < nowMs - maxAge) this.backoff.delete(sig);

    const rows = await deps.db
      .select({ signature: chainTxs.signature, kind: chainTxs.kind, bet_id: chainTxs.bet_id })
      .from(chainTxs)
      .where(
        and(
          isNotNull(chainTxs.signature),
          isNull(chainTxs.stream_seen_at),
          ne(chainTxs.kind, 'nonce_advance'),
          inArray(chainTxs.status, ['sent', 'confirmed']),
          lte(chainTxs.sent_at, new Date(nowMs - fallback)),
          gte(chainTxs.sent_at, new Date(nowMs - maxAge)),
          notExists(
            deps.db
              .select({ one: sql`1` })
              .from(chainEvents)
              .where(eq(chainEvents.signature, chainTxs.signature)),
          ),
        ),
      )
      .orderBy(asc(chainTxs.sent_at))
      .limit(batch * 4);

    for (const r of rows) {
      if (out.polled >= batch) break;
      const sig = r.signature!;
      const b = this.backoff.get(sig);
      if (b && b.at > nowMs) continue;
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
        const res = await ingestChainEvents(deps, this.projector, events, {
          deliveryId: `rpc_poll:${tx.slot ?? '-'}`,
          source: 'rpc_poll',
        });
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
    return out;
  }
}
