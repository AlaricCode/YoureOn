// Chain projector (API-CONTRACT §5.4, DATA-MODEL §3.5 / §8.1-§8.3, ESCROW §7.1). Runs inside the
// webhook's DB transaction (ingest.ts), once per delivery, with every newly stored chain_events
// row. "The QuickNode Stream carries the program's events and is the source of truth for money
// moved: it writes the database projection, gates paid/voided states, drives the stage ticker;
// if the two ever disagree, the chain wins" (ARCHITECTURE).
//
// Per delivery:
//   - Config events: stored only (bet_id NULL), marked applied.
//   - Orphans (no bets row): apply_error 'unknown_bet' (DATA-MODEL §8.3), never pushed; parked,
//     so a later copy (rpc_poll / startup sweep) re-folds them if the row appears.
//   - Bets are locked FOR UPDATE in a stable order (DATA-MODEL §8.2 step 3).
//
// Per bet:
//   1. Attribution (ESCROW §7.1, TM-E5). A bet's events apply only once chain_events holds a
//      BetCreated whose signature the SERVER sent for it: chain_txs (atomic_lock, or the
//      sequential create_bet; its signature is recorded at send, before any event can exist), or
//      bets.pending_sig (the tx sender's own RPC confirm). Until then rows stay 'not_ours' and
//      are re-folded later, so arrival order does not matter. A BetCreated this projector applied
//      earlier stays the verified lock (it was matched against a server signature when applied).
//      Events are then bound to OUR instance of the bet_id (attributeEvents): close_bet frees the
//      PDA and anyone may create_bet again with the same bet_id (ESCROW §5.1, test G4).
//   2. Fold (fold.ts): ALL attributed events of the bet (applied earlier + new) -> the
//      projector-owned columns, the furthest onchain_status, the terminal payout. Pure and
//      order-independent; duplicates and replays fold to the same projection.
//   3. Diff + write, inside a SAVEPOINT: only changed columns are written (the LockService /
//      PayoutService RPC-confirmed writes are left alone when they agree), onchain_status only
//      advances, onchain_pending clears once the chain reached it (chain_ack -> 'stream'), and
//      the offchain state moves when the chain is ahead (chain wins: a missed RPC confirm is
//      reconciled here, e.g. FINALIZED -> PAID, AWAITING_LOCK -> LOCKED, EXPIRED -> LOCKED).
//      chain_txs.stream_seen_at is stamped; outbox bet_locked / payout rows are queued.
//      A deterministic failure (CHECK / trigger) rolls back to the savepoint only: that bet's
//      chain.* events are still pushed, an audit row + alert record the disagreement, and the
//      next delivery for the bet re-attempts the projection from the full event set. Transient
//      errors propagate (the webhook answers 503 and QuickNode retries).
//   4. Fan-out: each new event is appended to bet_events as `chain.<Name>` (gapless seq,
//      chain_event_id set; the payload carries the signature, so the stage links it to the
//      Explorer) and applied_at is set. A state move adds `bet.state` and, where the RPC path
//      would have voiced it, the judge.cue (LOCKED, PAID / VOIDED, EXPIRED). The caller publishes
//      after COMMIT.
//
// Mismatches between the chain and the row (terms_hash, stakes, wallets, hashes, deadlines) are
// never a reason to drop a money event: they are written into audit_log ('chain.mismatch') and
// logged as alerts; apply_error stays an attribution / decode verdict only.
//
// Deliberately NOT here (owned elsewhere, or needs RPC, which the webhook must not call): the
// chain_txs status column and the nonce lease (LockService settles them at its own confirm or in
// its sweep; marking a lock 'confirmed' here would strand its nonce), the finalize timer (the
// keeper's finalize-due sweep is the durable backstop), token-balance cross-checks (the filter
// does not forward balances), the appeal panel.
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { auditLog, bets, chainEvents, chainTxs, outbox, users, type Db } from '@youre-on/db';
import { ChainEvents, type ChainEventName } from '@youre-on/shared';
import { formatUsd } from '@youre-on/shared/money';
import type { RealtimeEventType } from '@youre-on/shared/realtime';
import { judgeCue } from '../bets/cues';
import type { BetRow } from '../bets/snapshot';
import { statePayload } from '../lock/common';
import { loadEnvelope } from '../lock/terms';
import { silentLogger, type Logger } from '../log';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { dbErrorSummary, isTransientDbError } from './db-errors';
import {
  chainWins,
  diffProjection,
  foldChainEvents,
  impliedState,
  terminalFacts,
  type ChainFold,
  type FoldEvent,
  type FoldMismatch,
  type StateMove,
} from './fold';

/** A Drizzle transaction handle (what db.transaction passes to its callback). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const APPLY_ERROR = {
  /** Parked: no bets row for the bet_id (re-folded when a later copy arrives). */
  unknownBet: 'unknown_bet',
  /** Parked: the bet has no BetCreated under a server-sent lock signature yet (re-folded later). */
  notOurs: 'not_ours',
  /** Final: outside our instance of the bet_id (foreign BetCreated, before our lock, after our close). */
  notOursLock: 'not_ours_lock',
  /** Parked: the projector threw a deterministic error; stored by ingest's fallback, re-folded later. */
  projectorFailed: 'projector_failed',
  noBetId: 'no_bet_id',
  unknownEvent: 'unknown_event',
  /** Final: the stored payload does not parse as SCHEMAS ChainEvents.<name>. */
  payloadInvalid: 'payload_invalid',
  /**
   * Parked: attributed and already PUSHED (applied_at set, bet_events row exists), but the bets
   * write was rejected (CHECK / trigger). Re-folded by the bet's next event, a duplicate copy,
   * or the keeper's retry pass (reconciler.ts), and never pushed twice.
   */
  projectionRejected: 'projection_rejected',
} as const;

/** Verdicts a later delivery may revisit: the projector treats these rows as not yet applied. */
export const REFOLDABLE_ERRORS: readonly string[] = [
  APPLY_ERROR.notOurs,
  APPLY_ERROR.unknownBet,
  APPLY_ERROR.projectorFailed,
  APPLY_ERROR.projectionRejected,
];
const REFOLDABLE = new Set(REFOLDABLE_ERRORS);
/** Rows that decoded (an attribution verdict is not a decode failure). */
const ATTRIBUTION_VERDICTS = new Set([...REFOLDABLE_ERRORS, APPLY_ERROR.notOursLock]);

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
  /** Both parties' user channels (the hub dedupes by seq per socket), as lock/common fanout does. */
  user_ids?: readonly string[];
}

export interface ChainProjector {
  /** Runs inside the delivery transaction. Returns what to publish after COMMIT. */
  apply(
    tx: Tx,
    inserted: readonly InsertedChainEvent[],
    nowMs: number,
    log?: Logger,
  ): Promise<Fanout[]>;
}

// ---- attribution lookups ---------------------------------------------------------------------

/** bet_id -> every lock signature the server sent for the bet (BetCreated must carry one). */
export type LockSignatureLookup = (
  tx: Tx,
  betIds: readonly string[],
) => Promise<Map<string, ReadonlySet<string>>>;

/**
 * bet_id -> every signature the server itself sent for the bet. Used to attribute rows whose
 * position in the chain is unknown (rpc_poll rows have no block height).
 */
export type ServerSignatureLookup = (
  tx: Tx,
  betIds: readonly string[],
) => Promise<Map<string, ReadonlySet<string>>>;

/**
 * bets.pending_sig while onchain_pending is 'open' / 'locked': the lock signature the tx sender
 * recorded at its own RPC `confirmed` (DATA-MODEL §8.1). Only server-written columns count:
 * create_sig is projector-written FROM chain events, so using it would let an event vouch for
 * itself. A fallback only: the projector clears pending once the Stream echoes the lock.
 */
export async function betsColumnLockSignatures(
  tx: Pick<Tx, 'select'>,
  betIds: readonly string[],
): Promise<Map<string, string>> {
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
}

const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
  const s = m.get(k) ?? new Set<string>();
  s.add(v);
  m.set(k, s);
};

/**
 * DATA-MODEL §8.2 step 2: the signature of every atomic_lock (or sequential create_bet) row the
 * server built for the bet, whatever its status (a lock marked expired / failed that landed
 * after all is still ours: the chain decides), plus pending_sig (above).
 */
export const serverLockSignatures: LockSignatureLookup = async (tx, betIds) => {
  const out = new Map<string, Set<string>>();
  if (betIds.length === 0) return out;
  const rows = await tx
    .select({ bet_id: chainTxs.bet_id, signature: chainTxs.signature })
    .from(chainTxs)
    .where(
      and(
        inArray(chainTxs.bet_id, [...betIds]),
        inArray(chainTxs.kind, ['atomic_lock', 'create_bet']),
        isNotNull(chainTxs.signature),
      ),
    );
  for (const r of rows) addTo(out, r.bet_id, r.signature!);
  for (const [id, sig] of await betsColumnLockSignatures(tx, betIds)) addTo(out, id, sig);
  return out;
};

/**
 * Both sets in one chain_txs query, with pending_sig read from the bets rows the projector already
 * holds FOR UPDATE (the default lookups; serverLockSignatures / serverTxSignatures are the
 * injectable equivalents).
 */
async function signatureSets(
  tx: Tx,
  rows: readonly BetRow[],
): Promise<{ lock: Map<string, Set<string>>; all: Map<string, Set<string>> }> {
  const lock = new Map<string, Set<string>>();
  const all = new Map<string, Set<string>>();
  if (rows.length === 0) return { lock, all };
  const txs = await tx
    .select({ bet_id: chainTxs.bet_id, kind: chainTxs.kind, signature: chainTxs.signature })
    .from(chainTxs)
    .where(
      and(
        inArray(
          chainTxs.bet_id,
          rows.map((r) => r.id),
        ),
        isNotNull(chainTxs.signature),
      ),
    );
  for (const t of txs) {
    addTo(all, t.bet_id, t.signature!);
    if (t.kind === 'atomic_lock' || t.kind === 'create_bet') addTo(lock, t.bet_id, t.signature!);
  }
  for (const r of rows) {
    if (!r.pending_sig) continue;
    addTo(all, r.id, r.pending_sig);
    if (r.onchain_pending === 'open' || r.onchain_pending === 'locked')
      addTo(lock, r.id, r.pending_sig);
  }
  return { lock, all };
}

/** Every chain_txs signature of the bet (resolve, payouts, close, …) plus pending_sig. */
export const serverTxSignatures: ServerSignatureLookup = async (tx, betIds) => {
  const out = new Map<string, Set<string>>();
  if (betIds.length === 0) return out;
  const rows = await tx
    .select({ bet_id: chainTxs.bet_id, signature: chainTxs.signature })
    .from(chainTxs)
    .where(and(inArray(chainTxs.bet_id, [...betIds]), isNotNull(chainTxs.signature)));
  for (const r of rows) addTo(out, r.bet_id, r.signature!);
  const pend = await tx
    .select({ id: bets.id, pending_sig: bets.pending_sig })
    .from(bets)
    .where(and(inArray(bets.id, [...betIds]), isNotNull(bets.pending_sig)));
  for (const r of pend) addTo(out, r.id, r.pending_sig!);
  return out;
};

// ---- attribution (ESCROW §5.1 / §7.1) ---------------------------------------------------------

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

const decoded = (r: AttributionRow) =>
  r.apply_error === null || ATTRIBUTION_VERDICTS.has(r.apply_error);

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

// ---- the projector ---------------------------------------------------------------------------

const isConfig = (n: string) => n === 'ConfigInitialized' || n === 'ConfigUpdated';
const isChainEventName = (n: string): n is ChainEventName =>
  Object.prototype.hasOwnProperty.call(ChainEvents, n);

type ChainEventRow = typeof chainEvents.$inferSelect;

/** The stored row as SCHEMAS ChainEvents.<name> (ChainMeta from the columns), or null. */
export function parseStoredEvent(r: ChainEventRow): FoldEvent | null {
  if (!isChainEventName(r.event_name)) return null;
  const parsed = ChainEvents[r.event_name].safeParse({
    signature: r.signature,
    slot: r.slot,
    block_height: r.block_height,
    outer_ix: r.outer_ix,
    inner_ix: r.inner_ix,
    block_time: r.block_time ? Math.floor(r.block_time.getTime() / 1000) : null,
    observed_via: r.source === 'rpc_poll' ? 'rpc_poll' : 'quicknode_stream',
    ...r.payload,
  });
  if (!parsed.success) return null;
  return { id: r.id, name: r.event_name, signature: r.signature, data: parsed.data } as FoldEvent;
}

export interface ChainProjectorOptions {
  /** Defaults to serverLockSignatures (chain_txs + pending_sig). */
  lockSignatures?: LockSignatureLookup;
  /** Defaults to serverTxSignatures (chain_txs + pending_sig). */
  serverSignatures?: ServerSignatureLookup;
}

export function createChainProjector(o: ChainProjectorOptions = {}): ChainProjector {
  const custom = o.lockSignatures !== undefined || o.serverSignatures !== undefined;
  const lookups = async (tx: Tx, rows: readonly BetRow[]) => {
    if (!custom) return signatureSets(tx, rows);
    const ids = rows.map((r) => r.id);
    return {
      lock: await (o.lockSignatures ?? serverLockSignatures)(tx, ids),
      all: await (o.serverSignatures ?? serverTxSignatures)(tx, ids),
    };
  };
  return {
    async apply(tx, inserted, nowMs, log = silentLogger) {
      const now = new Date(nowMs);
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
          .set({ applied_at: now, apply_error: null })
          .where(inArray(chainEvents.id, config));
      await setError(tx, noBet, APPLY_ERROR.noBetId);
      await setError(tx, unknown, APPLY_ERROR.unknownEvent);
      if (betIds.size === 0) return [];

      // Lock the bets in a stable order (DATA-MODEL §8.2 step 3: SELECT … FOR UPDATE).
      const ids = [...betIds].sort();
      const rows = await tx
        .select()
        .from(bets)
        .where(inArray(bets.id, ids))
        .orderBy(asc(bets.id))
        .for('update');
      const found = new Map(rows.map((r) => [r.id, r]));
      const orphans = inserted
        .filter((r) => !r.apply_error && r.bet_id && betIds.has(r.bet_id) && !found.has(r.bet_id))
        .map((r) => r.id);
      await setError(tx, orphans, APPLY_ERROR.unknownBet);

      const present = ids.filter((id) => found.has(id));
      if (present.length === 0) return [];
      const { lock: lockSigs, all: serverSigs } = await lookups(
        tx,
        present.map((id) => found.get(id)!),
      );
      const fanout: Fanout[] = [];
      for (const betId of present) {
        const fresh = inserted.filter((r) => r.bet_id === betId && !r.apply_error).map((r) => r.id);
        fanout.push(
          ...(await projectBet(tx, {
            bet: found.get(betId)!,
            lockSigs: lockSigs.get(betId) ?? new Set(),
            serverSigs: serverSigs.get(betId) ?? new Set(),
            fresh,
            nowMs,
            log,
          })),
        );
      }
      return fanout;
    },
  };
}

/** A chain_txs row whose stream_seen_at was just stamped (its first Stream copy arrived). */
export interface StreamSeen {
  bet_id: string;
  kind: string;
  sent_at: Date | null;
  rpc_confirmed_at: Date | null;
  /** Which source stored the tx's events first: 'rpc_poll' when the Stream copy was a duplicate. */
  first_copy: 'stream' | 'rpc_poll';
}

/** RETURNING columns of the stream_seen_at stamp (StreamSeen minus first_copy). */
export const streamSeenCols = {
  bet_id: chainTxs.bet_id,
  kind: chainTxs.kind,
  sent_at: chainTxs.sent_at,
  rpc_confirmed_at: chainTxs.rpc_confirmed_at,
};

/**
 * The Streams lane latency (ARCHITECTURE §6 "Streams: send -> webhook", PENDING-KEY): once per
 * server tx, when its first Stream copy arrives, whether the projector applied it or it was a
 * duplicate of an rpc_poll copy (ingest.ts). The operator reads these to measure the Stream's lag.
 */
export function logStreamSeen(log: Logger, seen: readonly StreamSeen[], nowMs: number): void {
  for (const s of seen)
    log.info('chain.stream_seen', {
      bet_id: s.bet_id,
      kind: s.kind,
      first_copy: s.first_copy,
      send_to_stream_ms: s.sent_at ? nowMs - s.sent_at.getTime() : null,
      rpc_confirm_to_stream_ms: s.rpc_confirmed_at ? nowMs - s.rpc_confirmed_at.getTime() : null,
    });
}

function setError(tx: Tx, ids: readonly bigint[], apply_error: string) {
  return ids.length
    ? tx
        .update(chainEvents)
        .set({ apply_error })
        .where(inArray(chainEvents.id, [...ids]))
    : Promise.resolve();
}

interface BetInput {
  bet: BetRow;
  lockSigs: ReadonlySet<string>;
  serverSigs: ReadonlySet<string>;
  /** This delivery's rows for the bet (to park when the lock is not verified yet). */
  fresh: readonly bigint[];
  nowMs: number;
  log: Logger;
}

async function projectBet(tx: Tx, i: BetInput): Promise<Fanout[]> {
  const { bet, nowMs, log } = i;
  const all = await tx
    .select()
    .from(chainEvents)
    .where(eq(chainEvents.bet_id, bet.id))
    .orderBy(
      sql`${chainEvents.block_height} ASC NULLS LAST`,
      sql`${chainEvents.tx_index} ASC NULLS LAST`,
      asc(chainEvents.signature),
      asc(chainEvents.outer_ix),
      asc(chainEvents.inner_ix),
      asc(chainEvents.id),
    );
  const applied = (r: ChainEventRow) => r.applied_at !== null && r.apply_error === null;
  const candidate = (r: ChainEventRow) =>
    !applied(r) && (r.apply_error === null || REFOLDABLE.has(r.apply_error));
  // The verified lock: a BetCreated under a server-sent signature, else one applied earlier (it
  // was matched against a server signature then; pending_sig may have been cleared since).
  const lock =
    all.find(
      (r) =>
        r.event_name === 'BetCreated' &&
        (applied(r) || candidate(r)) &&
        i.lockSigs.has(r.signature),
    ) ??
    all.find(
      (r) =>
        r.event_name === 'BetCreated' &&
        r.applied_at !== null &&
        (r.apply_error === null || r.apply_error === APPLY_ERROR.projectionRejected),
    );
  if (!lock) {
    await setError(tx, i.fresh, APPLY_ERROR.notOurs);
    return [];
  }
  const ours = attributeEvents(all, lock, i.serverSigs);

  const events: FoldEvent[] = [];
  const pending: { row: ChainEventRow; event: FoldEvent }[] = [];
  const notOurs: bigint[] = [];
  const invalid: bigint[] = [];
  for (const r of all) {
    if (!isChainEventName(r.event_name)) continue;
    const isNew = candidate(r);
    if (!isNew && !applied(r)) continue; // a final verdict or a decode failure
    if (isNew && !ours(r)) {
      notOurs.push(r.id); // a squat, or a new bet after close_bet: logged, never pushed
      continue;
    }
    const ev = parseStoredEvent(r);
    if (!ev) {
      if (isNew) invalid.push(r.id);
      continue;
    }
    events.push(ev);
    if (isNew) pending.push({ row: r, event: ev });
  }
  await setError(tx, notOurs, APPLY_ERROR.notOursLock);
  await setError(tx, invalid, APPLY_ERROR.payloadInvalid);
  if (pending.length === 0) return [];

  // ---- fold + diff + write (savepoint) ----
  const fold = foldChainEvents(events);
  const diff = diffProjection(bet, fold);
  const move = chainWins(
    bet,
    impliedState(diff.status, terminalFacts(fold, bet), bet.evidence_source),
    diff.status,
  );
  const streamSigs = [
    ...new Set(pending.filter((p) => p.row.source === 'stream').map((p) => p.row.signature)),
  ];
  const set: Partial<BetRow> = { ...diff.patch };
  if (move) {
    set.state = move.state;
    set.end_reason = move.end_reason;
    if (move.end_reason === null && bet.refusal_category !== null) set.refusal_category = null;
  }
  let after: BetRow = bet;
  let rejected: ReturnType<typeof dbErrorSummary> | null = null;
  let seen: Omit<StreamSeen, 'first_copy'>[] = [];
  if (Object.keys(set).length || streamSigs.length)
    try {
      after = await tx.transaction(async (sp) => {
        let row = bet;
        if (Object.keys(set).length) {
          const [r] = await sp.update(bets).set(set).where(eq(bets.id, bet.id)).returning();
          row = r ?? bet;
        }
        if (streamSigs.length)
          seen = await sp
            .update(chainTxs)
            .set({ stream_seen_at: new Date(nowMs) })
            .where(
              and(
                eq(chainTxs.bet_id, bet.id),
                inArray(chainTxs.signature, streamSigs),
                isNull(chainTxs.stream_seen_at),
              ),
            )
            .returning(streamSeenCols);
        await queuePushes(sp, bet, row, fold, new Set(pending.map((p) => p.row.id)), nowMs);
        return row;
      });
      logStreamSeen(
        log,
        seen.map((x) => ({ ...x, first_copy: 'stream' as const })),
        nowMs,
      );
    } catch (e) {
      if (isTransientDbError(e)) throw e;
      rejected = dbErrorSummary(e);
    }

  // ---- audit the disagreements (outside the savepoint, so they survive a rejection) ----
  // Only for rows seen for the first time: a retry of a rejected projection does not re-audit.
  const pendingIds = pending.map((p) => p.row.id);
  const firstSeen = new Set(
    pending
      .filter((p) => p.row.apply_error !== APPLY_ERROR.projectionRejected)
      .map((p) => p.row.id),
  );
  const names = new Map(events.map((e) => [e.id, e.name]));
  // ...and when this write overwrites a value someone else changed after its event was applied
  const overwritten = new Set(rejected ? [] : Object.keys(diff.patch));
  const mismatches = diff.mismatches.filter(
    (m) => m.event_id === null || firstSeen.has(m.event_id) || overwritten.has(m.field),
  );
  if (mismatches.length) {
    log.error('chain.mismatch', { alert: true, bet_id: bet.id, mismatches: mismatches.map(fmt) });
    await tx.insert(auditLog).values({
      actor_kind: 'system',
      action: 'chain.mismatch',
      bet_id: bet.id,
      details: { mismatches: mismatches.map((m) => ({ ...fmt(m), event: eventName(names, m) })) },
    });
  }
  if (rejected && firstSeen.size === 0)
    log.warn('chain.projection_still_rejected', { bet_id: bet.id, ...rejected });
  else if (rejected) {
    log.error('chain.projection_rejected', { alert: true, bet_id: bet.id, ...rejected });
    await tx.insert(auditLog).values({
      actor_kind: 'system',
      action: 'chain.projection_rejected',
      bet_id: bet.id,
      details: {
        ...rejected,
        events: pending.map((p) => p.event.name),
        onchain_status: diff.status,
        state: move?.state ?? null,
      },
    });
  } else if (pending.some((p) => p.row.apply_error === APPLY_ERROR.projectionRejected))
    log.warn('chain.projection_recovered', { bet_id: bet.id, onchain_status: diff.status });

  // ---- fan out: chain.* in chain order (each row once), then the state move ----
  const envs: BetEventEnvelope[] = [];
  for (const { row, event } of pending) {
    if (row.applied_at !== null) continue; // pushed by an earlier (rejected) pass
    envs.push(
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: `chain.${event.name}` as RealtimeEventType,
        payload: event.data as never,
        chain_event_id: row.id,
        now: nowMs,
      }),
    );
  }
  await tx
    .update(chainEvents)
    .set({
      // ISO text + cast: a Date param in raw sql is not serialized by drizzle (resolve-due fix)
      applied_at: sql`coalesce(${chainEvents.applied_at}, ${new Date(nowMs).toISOString()}::timestamptz)`,
      apply_error: rejected ? APPLY_ERROR.projectionRejected : null,
    })
    .where(inArray(chainEvents.id, pendingIds));
  if (move && !rejected) {
    envs.push(...(await stateEnvelopes(tx, bet, after, move, fold, nowMs)));
    log.warn('chain.state_reconciled', {
      bet_id: bet.id,
      from: bet.state,
      to: move.state,
      onchain_status: diff.status,
    });
  }
  const user_ids = [bet.party_a_id, bet.party_b_id];
  return envs.map((envelope) => ({ envelope, room_id: bet.room_id, user_ids }));
}

const fmt = (m: FoldMismatch) => ({ field: m.field, chain: m.chain, db: m.db });
const eventName = (names: Map<bigint, string>, m: FoldMismatch) =>
  m.event_id === null ? null : (names.get(m.event_id) ?? null);

// ---- side effects of a state move -------------------------------------------------------------

async function partyNames(tx: Pick<Tx, 'select'>, bet: BetRow) {
  const rows = await tx
    .select({ id: users.id, name: users.display_name })
    .from(users)
    .where(inArray(users.id, [bet.party_a_id, bet.party_b_id]));
  const by = new Map(rows.map((r) => [r.id, r.name]));
  return { A: by.get(bet.party_a_id) ?? 'A', B: by.get(bet.party_b_id) ?? 'B' };
}

const usd = (micro: bigint) => formatUsd(micro.toString());

/** reason strings match the RPC path's, so phones treat both the same (mobile reads it as end_reason). */
function reasonFor(move: StateMove, after: BetRow, fold: ChainFold): string | null {
  switch (move.state) {
    case 'RULED':
      return after.appeal_deadline
        ? `appeal_deadline=${Math.floor(after.appeal_deadline.getTime() / 1000)}`
        : null;
    case 'PAID':
    case 'VOIDED':
      return after.payout_via ?? fold.terminal?.name ?? null;
    case 'EXPIRED':
    case 'CANCELLED':
      return move.end_reason;
    default:
      return null;
  }
}

/** bet.state (+ the judge.cue the RPC path would have sent) for a move the chain forced. */
async function stateEnvelopes(
  tx: Tx,
  before: BetRow,
  after: BetRow,
  move: StateMove,
  fold: ChainFold,
  nowMs: number,
): Promise<BetEventEnvelope[]> {
  const envs = [
    await appendBetEvent(tx, {
      bet_id: before.id,
      type: 'bet.state',
      payload: statePayload(after, before.state, reasonFor(move, after, fold)),
      now: nowMs,
    }),
  ];
  const cue = await cueFor(tx, before, after, move, fold);
  if (cue)
    envs.push(
      await appendBetEvent(tx, { bet_id: before.id, type: 'judge.cue', payload: cue, now: nowMs }),
    );
  return envs;
}

async function cueFor(tx: Tx, before: BetRow, after: BetRow, move: StateMove, fold: ChainFold) {
  if (move.state === 'LOCKED') {
    const names = await partyNames(tx, before);
    const pot = usd((after.stake_a ?? 0n) + (after.stake_b ?? 0n));
    const performer = (await loadEnvelope(tx, before.id, { finalOnly: true }))?.envelope.terms
      .performer;
    return judgeCue(
      'LOCKED',
      { pot, a: names.A, b: names.B, ...(performer ? { performer: names[performer] } : {}), tx: 1 },
      'Announce both stakes are locked in one transaction, then call request_attempt with attempt_no 1.',
    );
  }
  const t = fold.terminal;
  if ((move.state === 'PAID' || move.state === 'VOIDED') && t) {
    if (move.state === 'VOIDED')
      return judgeCue(
        'VOIDED',
        { a: usd(t.to_a), b: usd(t.to_b) },
        "Say it's void: both got their stake back.",
      );
    const names = await partyNames(tx, before);
    const winner = t.outcome === 'party_a' ? 'A' : t.outcome === 'party_b' ? 'B' : null;
    return judgeCue(
      'PAID',
      {
        winner: winner ? names[winner] : 'split',
        amount: usd(winner === 'B' ? t.to_b : t.to_a),
        to_a: usd(t.to_a),
        to_b: usd(t.to_b),
      },
      winner ? `Congratulate ${names[winner]} in one line.` : 'Say it is a split.',
    );
  }
  if (move.state === 'EXPIRED' && t)
    return judgeCue(
      'EXPIRED',
      { reason: move.end_reason ?? 'timeout' },
      'Say time ran out and the stakes went back. Nothing else.',
    );
  return null;
}

/**
 * Outbox rows (API-CONTRACT §7.4, DATA-MODEL §5.17) for money the chain just locked or moved,
 * written in the projection's transaction (a rejected write rolls them back with it; the retry
 * queues them again). dedupe_key = {bet_id}:{kind}:{signature}:{user_id}, so a re-fold or a
 * replay is a no-op. Display data only.
 */
async function queuePushes(
  sp: Tx,
  before: BetRow,
  after: BetRow,
  fold: ChainFold,
  applying: ReadonlySet<bigint>,
  nowMs: number,
) {
  const rows: (typeof outbox.$inferInsert)[] = [];
  const accepted = [...applying].some((id) => fold.source.accept_sig === id);
  const at = new Date(nowMs);
  const parties = [
    { user: before.party_a_id, amount: fold.terminal?.to_a ?? 0n },
    { user: before.party_b_id, amount: fold.terminal?.to_b ?? 0n },
  ];
  // Locked in: when this pass applies the BetAccepted (whatever wrote onchain_status first,
  // e.g. the LockService's chain-wins revive), unless the same fold already reached the payout
  // (a "locked in" push next to a "refunded" one would be stale).
  if (accepted && !fold.terminal && after.accept_sig) {
    const pot = usd((after.stake_a ?? 0n) + (after.stake_b ?? 0n));
    for (const p of parties)
      rows.push({
        recipient_user_id: p.user,
        bet_id: before.id,
        kind: 'bet_locked',
        payload: {
          bet_id: before.id,
          title: 'Locked in',
          body: `${pot} is locked in escrow.`,
          signature: after.accept_sig,
        },
        dedupe_key: `${before.id}:bet_locked:${after.accept_sig}:${p.user}`,
        next_attempt_at: at,
      });
  }
  const t = fold.terminal;
  if (t && applying.has(t.event_id)) {
    // A refund / cancel gives stakes back: nobody "lost", and a party that never staked (a
    // sequential cancel or a refund from Open: to_b = 0) gets no push at all.
    const refund = t.status !== 'settled' || t.outcome === 'refund';
    for (const p of parties) {
      if (refund && p.amount === 0n) continue;
      const copy = refund
        ? { title: `${usd(p.amount)} refunded`, body: 'Your stake is back in your wallet.' }
        : p.amount > 0n
          ? { title: `${usd(p.amount)} is yours`, body: 'Sent to your wallet.' }
          : { title: 'Bet settled', body: 'Better luck next time.' };
      rows.push({
        recipient_user_id: p.user,
        bet_id: before.id,
        kind: 'payout',
        payload: {
          bet_id: before.id,
          ...copy,
          amount: p.amount.toString(),
          signature: t.signature,
        },
        dedupe_key: `${before.id}:payout:${t.signature}:${p.user}`,
        next_attempt_at: at,
      });
    }
  }
  if (rows.length) await sp.insert(outbox).values(rows).onConflictDoNothing();
}
