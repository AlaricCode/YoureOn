// Chain projector, MINIMAL STUB (API-CONTRACT §5.4, DATA-MODEL §8.2 step 3, ESCROW §7.1).
//
// What it does, inside the webhook's DB transaction:
//   - Config events: stored only (bet_id NULL), marked applied.
//   - Orphans (no bets row): apply_error 'unknown_bet' (DATA-MODEL §8.3), never pushed.
//   - Attribution (ESCROW §7.1, TM-E5): a bet's events are applied only once chain_events holds
//     a BetCreated for it whose signature equals the bet's recorded lock signature. Until then
//     they stay unapplied with apply_error 'not_ours' and are re-folded on every later delivery
//     for that bet (and when a duplicate of a parked row arrives, see ingest.ts), so arrival
//     order does not matter. Once verified, events are bound to OUR instance of the bet_id
//     (attributeEvents below): close_bet frees the PDA and anyone may create_bet again with the
//     same bet_id (ESCROW §5.1, test G4). A BetCreated under any other signature, anything before
//     our lock, after our BetClosed, or at/after a later foreign BetCreated is 'not_ours_lock'
//     (final, logged, never pushed).
//   - Applied events: appended to bet_events as `chain.<Name>` (gapless seq, chain_event_id set),
//     applied_at set; the caller publishes the envelopes after COMMIT.
//
// What it deliberately does NOT do yet (bet lifecycle, owned by the lock/settlement streams):
// write bets.onchain_status / outcome / payouts / *_sig / deadlines, clear onchain_pending,
// move bets.state, cross-check terms_hash / stakes / token balances, chain_txs.stream_seen_at,
// outbox rows, judge.cue PAID/VOIDED, arming finalize timers. Swap in a full ChainProjector via
// createChainRoutes({ projector }) when those land.
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { bets, chainEvents, type Db } from '@youre-on/db';
import { ChainEvents, type ChainEventName } from '@youre-on/shared';
import type { RealtimeEventType } from '@youre-on/shared/realtime';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';

/** A Drizzle transaction handle (what db.transaction passes to its callback). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const APPLY_ERROR = {
  unknownBet: 'unknown_bet',
  /** Parked: the bet has no BetCreated under its lock signature yet (re-folded later). */
  notOurs: 'not_ours',
  /** Final: outside our instance of the bet_id (foreign BetCreated, before our lock, after our close). */
  notOursLock: 'not_ours_lock',
  /** Final: the projector threw a deterministic error; stored for audit by ingest's fallback. */
  projectorFailed: 'projector_failed',
  noBetId: 'no_bet_id',
  unknownEvent: 'unknown_event',
} as const;

/** The rows the dedupe INSERT actually inserted (RETURNING). */
export interface InsertedChainEvent {
  id: bigint;
  bet_id: string | null;
  event_name: string;
  apply_error: string | null;
}

export interface Fanout {
  envelope: BetEventEnvelope;
  room_id: string | null;
}

export interface ChainProjector {
  /** Runs inside the delivery transaction. Returns what to publish after COMMIT. */
  apply(tx: Tx, inserted: readonly InsertedChainEvent[], nowMs: number): Promise<Fanout[]>;
}

/**
 * bet_id → the bet's recorded lock signature (atomic lock tx; sequential fallback: create_bet).
 * DATA-MODEL §8.2 reads it from chain_txs (LockService), which does not exist yet.
 */
export type LockSignatureLookup = (
  tx: Tx,
  betIds: readonly string[],
) => Promise<Map<string, string>>;

/**
 * bet_id → every signature the server itself sent for the bet (chain_txs once it lands). Used to
 * attribute rows whose position in the chain is unknown (rpc_poll rows have no block height).
 */
export type ServerSignatureLookup = (
  tx: Tx,
  betIds: readonly string[],
) => Promise<Map<string, ReadonlySet<string>>>;

/**
 * Interim lookup until chain_txs lands: the tx sender records the lock in `bets.pending_sig`
 * (with onchain_pending 'open'/'locked') at its own RPC `confirmed` (DATA-MODEL §8.1). Only
 * server-written columns count: `create_sig` is projector-written FROM chain events, so using it
 * here would let a chain event vouch for itself. LIMIT: this works only while pending_sig is
 * set; the full projector (which clears pending) must switch to chain_txs first.
 */
export const betsColumnLockSignatures: LockSignatureLookup = async (tx, betIds) => {
  if (betIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: bets.id, pending_sig: bets.pending_sig, onchain_pending: bets.onchain_pending })
    .from(bets)
    .where(inArray(bets.id, [...betIds]));
  const out = new Map<string, string>();
  for (const r of rows) {
    const sig =
      r.onchain_pending === 'open' || r.onchain_pending === 'locked' ? r.pending_sig : null;
    if (sig) out.set(r.id, sig);
  }
  return out;
};

/** Interim: the only server-written signature column on bets is pending_sig (see above). */
export const betsColumnServerSignatures: ServerSignatureLookup = async (tx, betIds) => {
  if (betIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: bets.id, pending_sig: bets.pending_sig })
    .from(bets)
    .where(inArray(bets.id, [...betIds]));
  return new Map(rows.map((r) => [r.id, new Set(r.pending_sig ? [r.pending_sig] : [])]));
};

/** What attribution needs to know about one chain_events row. */
export interface AttributionRow {
  id: bigint;
  signature: string;
  event_name: string;
  block_height: number | null;
  tx_index: number | null;
  apply_error: string | null;
}

/**
 * Chain order of two events: -1 / 1 when known, 0 for the same transaction, null when unknown
 * (a NULL block height, i.e. an rpc_poll row, or the same block without both tx indexes).
 */
export function chainOrder(a: AttributionRow, b: AttributionRow): -1 | 0 | 1 | null {
  if (a.signature === b.signature) return 0;
  if (a.block_height === null || b.block_height === null) return null;
  if (a.block_height !== b.block_height) return a.block_height < b.block_height ? -1 : 1;
  if (a.tx_index === null || b.tx_index === null || a.tx_index === b.tx_index) return null;
  return a.tx_index < b.tx_index ? -1 : 1;
}

const byChainPosition = (a: AttributionRow, b: AttributionRow) =>
  (a.block_height ?? Infinity) - (b.block_height ?? Infinity) ||
  (a.tx_index ?? Infinity) - (b.tx_index ?? Infinity);

/** Rows that decoded (apply_error is empty or an attribution verdict, not a decode failure). */
const decoded = (r: AttributionRow) =>
  r.apply_error === null ||
  r.apply_error === APPLY_ERROR.notOurs ||
  r.apply_error === APPLY_ERROR.notOursLock;

/**
 * Binds a bet's events to OUR instance of its bet_id (ESCROW §5.1 / §7.1, TM-E5, TM-I1).
 *
 * `all` is every chain_events row stored for the bet_id; `lock` is the verified BetCreated under
 * our lock signature. Our instance runs from `lock` to our BetClosed (inclusive; terminal + close
 * share one tx). A later create_bet with the same bet_id (after close_bet freed the PDA) starts an
 * independent bet: its BetCreated and everything at or after it is not ours. Rows whose chain
 * position is unknown are accepted only when they are unambiguous: the server sent the signature,
 * or no other instance (foreign BetCreated) and no BetClosed is on record for the bet_id.
 */
export function attributeEvents(
  all: readonly AttributionRow[],
  lock: AttributionRow,
  serverSigs: ReadonlySet<string>,
): (row: AttributionRow) => boolean {
  const rows = all.filter(decoded);
  const foreign = rows.filter(
    (r) => r.event_name === 'BetCreated' && r.signature !== lock.signature,
  );
  const closes = rows.filter((r) => r.event_name === 'BetClosed').sort(byChainPosition);
  // Our close: the first BetClosed after our lock; without a lock position, one the server sent.
  const ourClose =
    closes.find((c) => chainOrder(c, lock) === 1) ??
    closes.find((c) => serverSigs.has(c.signature) && chainOrder(c, lock) !== -1);
  // Foreign creates known to come after our lock bound our instance from above.
  const laterForeign = foreign.filter((f) => chainOrder(f, lock) === 1);
  const contested = foreign.length > 0 || closes.length > 0;

  return (e) => {
    if (e.id === lock.id || e.signature === lock.signature) return true;
    if (e.event_name === 'BetCreated') return false; // not our lock's create
    if (chainOrder(e, lock) === -1) return false; // before our lock (an earlier squatter's bet)
    if (ourClose) {
      if (e.signature === ourClose.signature) return true;
      if (chainOrder(e, ourClose) === 1) return false; // after our close
    }
    for (const f of laterForeign) {
      const o = chainOrder(e, f);
      if (o === 0 || o === 1) return false; // part of, or after, the next instance
    }
    if (serverSigs.has(e.signature)) return true;
    if (!contested) return true;
    // Contested: every relation that matters must be known and inside our window.
    return (
      chainOrder(e, lock) === 1 &&
      (!ourClose || chainOrder(e, ourClose) === -1) &&
      foreign.every((f) => {
        const fl = chainOrder(f, lock);
        return fl === -1 || chainOrder(e, f) === -1;
      }) &&
      closes.every((c) => c === ourClose || chainOrder(c, lock) === -1 || chainOrder(e, c) === -1)
    );
  };
}

/** Decodable rows that may still be applied (fresh, or parked until the BetCreated matched). */
const applicable = or(
  isNull(chainEvents.apply_error),
  eq(chainEvents.apply_error, APPLY_ERROR.notOurs),
);

const isConfig = (n: string) => n === 'ConfigInitialized' || n === 'ConfigUpdated';
const isChainEventName = (n: string): n is ChainEventName =>
  Object.prototype.hasOwnProperty.call(ChainEvents, n);

export function createStubProjector(
  o: { lockSignatures?: LockSignatureLookup; serverSignatures?: ServerSignatureLookup } = {},
): ChainProjector {
  const lockSignatures = o.lockSignatures ?? betsColumnLockSignatures;
  const serverSignatures = o.serverSignatures ?? betsColumnServerSignatures;
  return {
    async apply(tx, inserted, nowMs) {
      const now = new Date(nowMs);
      const setError = (ids: bigint[], apply_error: string) =>
        ids.length
          ? tx.update(chainEvents).set({ apply_error }).where(inArray(chainEvents.id, ids))
          : Promise.resolve();

      const config: bigint[] = [];
      const noBet: bigint[] = [];
      const unknown: bigint[] = [];
      const betIds = new Set<string>();
      for (const r of inserted) {
        if (r.apply_error) continue; // decode/payload failure: stored for audit only
        if (isConfig(r.event_name)) config.push(r.id);
        else if (!isChainEventName(r.event_name)) unknown.push(r.id);
        else if (!r.bet_id) noBet.push(r.id);
        else betIds.add(r.bet_id);
      }
      if (config.length)
        await tx
          .update(chainEvents)
          .set({ applied_at: now })
          .where(inArray(chainEvents.id, config));
      await setError(noBet, APPLY_ERROR.noBetId);
      await setError(unknown, APPLY_ERROR.unknownEvent);
      if (betIds.size === 0) return [];

      // Lock the bets in a stable order (DATA-MODEL §8.2 step 3: SELECT … FOR UPDATE).
      const ids = [...betIds].sort();
      const rows = await tx
        .select({ id: bets.id, room_id: bets.room_id })
        .from(bets)
        .where(inArray(bets.id, ids))
        .orderBy(asc(bets.id))
        .for('update');
      const found = new Map(rows.map((r) => [r.id, r.room_id]));
      const orphanIds = inserted
        .filter((r) => !r.apply_error && r.bet_id && betIds.has(r.bet_id) && !found.has(r.bet_id))
        .map((r) => r.id);
      await setError(orphanIds, APPLY_ERROR.unknownBet);

      const present = ids.filter((id) => found.has(id));
      const lockSigs = await lockSignatures(tx, present);
      const serverSigs = await serverSignatures(tx, present);
      const fanout: Fanout[] = [];
      for (const betId of present) {
        const lockSig = lockSigs.get(betId);
        const all = lockSig
          ? await tx
              .select({
                id: chainEvents.id,
                signature: chainEvents.signature,
                event_name: chainEvents.event_name,
                block_height: chainEvents.block_height,
                tx_index: chainEvents.tx_index,
                apply_error: chainEvents.apply_error,
              })
              .from(chainEvents)
              .where(eq(chainEvents.bet_id, betId))
          : [];
        const verified = all.find(
          (r) =>
            r.event_name === 'BetCreated' &&
            r.signature === lockSig &&
            (r.apply_error === null || r.apply_error === APPLY_ERROR.notOurs),
        );
        if (!verified) {
          const mine = inserted
            .filter((r) => r.bet_id === betId && !r.apply_error)
            .map((r) => r.id);
          await setError(mine, APPLY_ERROR.notOurs);
          continue;
        }
        const ours = attributeEvents(all, verified, serverSigs.get(betId) ?? new Set());
        // Fold every unapplied, applicable event of the bet (new ones and earlier 'not_ours').
        const pending = await tx
          .select()
          .from(chainEvents)
          .where(and(eq(chainEvents.bet_id, betId), isNull(chainEvents.applied_at), applicable))
          .orderBy(
            sql`${chainEvents.block_height} ASC NULLS LAST`,
            sql`${chainEvents.tx_index} ASC NULLS LAST`,
            asc(chainEvents.signature),
            asc(chainEvents.outer_ix),
            asc(chainEvents.inner_ix),
            asc(chainEvents.id),
          );
        for (const ev of pending) {
          if (!isChainEventName(ev.event_name)) continue;
          // Not our instance of this bet_id (a squat, or a new bet after close_bet): log, never push.
          if (!ours(ev)) {
            await setError([ev.id], APPLY_ERROR.notOursLock);
            continue;
          }
          const payload = ChainEvents[ev.event_name].safeParse({
            signature: ev.signature,
            slot: ev.slot,
            block_height: ev.block_height,
            outer_ix: ev.outer_ix,
            inner_ix: ev.inner_ix,
            block_time: ev.block_time ? Math.floor(ev.block_time.getTime() / 1000) : null,
            observed_via: ev.source === 'rpc_poll' ? 'rpc_poll' : 'quicknode_stream',
            ...ev.payload,
          });
          if (!payload.success) {
            await setError([ev.id], 'payload_invalid');
            continue;
          }
          const envelope = await appendBetEvent(tx, {
            bet_id: betId,
            type: `chain.${ev.event_name}` as RealtimeEventType,
            payload: payload.data as never,
            chain_event_id: ev.id,
            now: nowMs,
          });
          await tx
            .update(chainEvents)
            .set({ applied_at: now, apply_error: null })
            .where(eq(chainEvents.id, ev.id));
          fanout.push({ envelope, room_id: found.get(betId) ?? null });
        }
      }
      return fanout;
    },
  };
}
