// The pure half of the chain projector: folds every attributed event of one bet into the
// projector-owned `bets` columns, diffs that against the row, and decides the offchain state the
// chain implies ("the chain wins").
//
// Order-independent by construction: the fold is a function of the SET of events (status = the
// furthest status reached; each column comes from the event that owns it; final outcome = the
// terminal event's, else BetResolved's), so duplicates, out-of-order and replayed deliveries all
// produce the same projection. The diff only ever moves forward:
//   - onchain_status is written only when it advances (bets_guard rejects a regression, and a
//     terminal status never changes);
//   - a column is written only when the chain value differs from the row (same values: no-op,
//     so the LockService / PayoutService RPC-confirmed writes are left alone when they agree);
//   - binding fields (terms_hash, stakes, mint, party wallets) are never written, only checked.
// events.rs is the source of truth for event names and fields; there is no BetPaid: money moves
// in BetConceded / BetFinalized / AppealResolved / BetRefunded / BetCancelled (then BetClosed).
//
// Spec: docs/planning/DATA-MODEL.md §3.5.
import type { BetRow } from '../bets/snapshot';
import { BetState } from '@youre-on/shared/bet-state';
import type { ChainEventName, ChainEventPayload } from '@youre-on/shared';
import type { OnchainOutcome } from '@youre-on/shared/ruling';

export type PgOnchainStatus = BetRow['onchain_status'];
type PgOutcome = NonNullable<BetRow['outcome']>;
type PgPayoutVia = NonNullable<BetRow['payout_via']>;
type EndReason = NonNullable<BetRow['end_reason']>;

/** Postgres onchain_status enum declaration order: compared with < / >=. */
export const STATUS_RANK: Record<PgOnchainStatus, number> = {
  none: 0,
  open: 1,
  locked: 2,
  resolved: 3,
  appealed: 4,
  settled: 5,
  refunded: 6,
  cancelled: 7,
};
export const statusRank = (s: PgOnchainStatus): number => STATUS_RANK[s];
export const isTerminalStatus = (s: PgOnchainStatus): boolean =>
  statusRank(s) >= STATUS_RANK.settled;

/** The shared OnchainStatus (Rust variant) -> Postgres (snake_case). */
const PG_STATUS: Record<string, Exclude<PgOnchainStatus, 'none'>> = {
  Open: 'open',
  Locked: 'locked',
  Resolved: 'resolved',
  Appealed: 'appealed',
  Settled: 'settled',
  Refunded: 'refunded',
  Cancelled: 'cancelled',
};
export const PG_OUTCOME: Record<OnchainOutcome, PgOutcome> = {
  PartyA: 'party_a',
  PartyB: 'party_b',
  Split: 'split',
  Refund: 'refund',
};

/** The five token-moving events and the instruction that emits each one. */
export const TERMINAL_VIA = {
  BetConceded: 'concede',
  BetFinalized: 'finalize',
  AppealResolved: 'resolve_appeal',
  BetRefunded: 'timeout_refund',
  BetCancelled: 'cancel_open_bet',
} as const satisfies Record<string, PgPayoutVia>;
export type TerminalName = keyof typeof TERMINAL_VIA;
export const isTerminalEvent = (n: string): n is TerminalName =>
  Object.prototype.hasOwnProperty.call(TERMINAL_VIA, n);

/** One attributed, schema-valid chain event (the ChainEvents payload, meta included). */
export type FoldEvent = {
  [N in ChainEventName]: { id: bigint; name: N; signature: string; data: ChainEventPayload<N> };
}[ChainEventName];

/** Projector-owned `bets` columns, as the chain says they are. */
export type ProjectedColumns = Partial<
  Pick<
    BetRow,
    | 'create_sig'
    | 'accept_sig'
    | 'resolve_sig'
    | 'appeal_sig'
    | 'payout_sig'
    | 'close_sig'
    | 'accept_deadline'
    | 'bet_pda'
    | 'vault'
    | 'locked_at'
    | 'resolve_deadline'
    | 'resolved_at'
    | 'appeal_deadline'
    | 'evidence_hash'
    | 'ruling_hash'
    | 'appealed_at'
    | 'appeal_resolve_deadline'
    | 'outcome'
    | 'payout_a'
    | 'payout_b'
    | 'payout_via'
    | 'settled_at'
    | 'appeal_ruling_hash'
    | 'closed_at'
  >
>;
type ProjectedKey = keyof ProjectedColumns;

/** Binding fields the chain must agree with; checked, never written (bets_guard freezes them). */
type BindingKey =
  'terms_hash' | 'stake_a' | 'stake_b' | 'mint' | 'party_a_wallet' | 'party_b_wallet';

export interface Terminal {
  name: TerminalName;
  event_id: bigint;
  signature: string;
  status: Exclude<PgOnchainStatus, 'none'>;
  outcome: PgOutcome;
  to_a: bigint;
  to_b: bigint;
  /** BetRefunded only: the status the refund came from. */
  from_status: PgOnchainStatus | null;
}

export interface ChainFold {
  /** The furthest status any event reached ('none' when no event moves status). */
  status: PgOnchainStatus;
  columns: ProjectedColumns;
  /** Which event produced each column (mismatch audit rows name it). */
  source: Partial<Record<ProjectedKey | BindingKey, bigint>>;
  /** Binding values the chain committed to. */
  binding: Partial<Pick<BetRow, BindingKey>>;
  terminal: Terminal | null;
  /** The event that produced `status`. */
  status_event: bigint | null;
}

const at = (unixSeconds: number) => new Date(unixSeconds * 1000);

/** Event -> the onchain status it proves (BetClosed proves nothing new: status unchanged). */
export function statusOf(e: FoldEvent): PgOnchainStatus {
  switch (e.name) {
    case 'BetCreated':
      return 'open';
    case 'BetAccepted':
      return 'locked';
    case 'BetResolved':
      return 'resolved';
    case 'BetAppealed':
      return 'appealed';
    case 'BetConceded':
    case 'BetFinalized':
    case 'AppealResolved':
    case 'BetRefunded':
    case 'BetCancelled':
      return PG_STATUS[e.data.final_status] ?? 'none';
    case 'BetClosed':
      return 'none';
  }
}

/**
 * Folds the events of ONE instance of a bet (already attributed and schema-checked). The first
 * event of each kind wins (the program emits each at most once per instance, so a second one
 * can only be a duplicate copy).
 */
export function foldChainEvents(events: readonly FoldEvent[]): ChainFold {
  const out: ChainFold = {
    status: 'none',
    columns: {},
    source: {},
    binding: {},
    terminal: null,
    status_event: null,
  };
  const seen = new Set<string>();
  const set = <K extends ProjectedKey>(k: K, v: ProjectedColumns[K], id: bigint) => {
    out.columns[k] = v;
    out.source[k] = id;
  };
  const bind = <K extends BindingKey>(k: K, v: BetRow[K], id: bigint) => {
    if (out.binding[k] !== undefined) return;
    out.binding[k] = v;
    out.source[k] = id;
  };
  let resolvedOutcome: PgOutcome | null = null;
  for (const e of events) {
    const s = statusOf(e);
    if (statusRank(s) > statusRank(out.status)) {
      out.status = s;
      out.status_event = e.id;
    }
    const family = isTerminalEvent(e.name) ? 'terminal' : e.name;
    if (seen.has(family)) continue;
    seen.add(family);
    switch (e.name) {
      case 'BetCreated': {
        const d = e.data;
        set('create_sig', e.signature, e.id);
        set('accept_deadline', at(d.accept_deadline), e.id);
        set('bet_pda', d.bet, e.id);
        set('vault', d.vault, e.id);
        bind('terms_hash', d.terms_hash, e.id);
        bind('stake_a', BigInt(d.stake_a), e.id);
        bind('stake_b', BigInt(d.stake_b), e.id);
        bind('mint', d.mint, e.id);
        bind('party_a_wallet', d.party_a, e.id);
        bind('party_b_wallet', d.party_b, e.id);
        break;
      }
      case 'BetAccepted': {
        const d = e.data;
        set('accept_sig', e.signature, e.id);
        set('locked_at', at(d.ts), e.id);
        set('resolve_deadline', at(d.resolve_deadline), e.id);
        bind('terms_hash', d.terms_hash, e.id);
        bind('stake_a', BigInt(d.stake_a), e.id);
        bind('stake_b', BigInt(d.stake_b), e.id);
        bind('party_a_wallet', d.party_a, e.id);
        bind('party_b_wallet', d.party_b, e.id);
        break;
      }
      case 'BetResolved': {
        const d = e.data;
        set('resolve_sig', e.signature, e.id);
        set('resolved_at', at(d.ts), e.id);
        set('appeal_deadline', at(d.appeal_deadline), e.id);
        set('evidence_hash', d.evidence_hash, e.id);
        set('ruling_hash', d.ruling_hash, e.id);
        resolvedOutcome = PG_OUTCOME[d.outcome];
        out.source.outcome ??= e.id;
        break;
      }
      case 'BetAppealed': {
        const d = e.data;
        set('appeal_sig', e.signature, e.id);
        set('appealed_at', at(d.ts), e.id);
        set('appeal_resolve_deadline', at(d.appeal_resolve_deadline), e.id);
        break;
      }
      case 'BetClosed': {
        set('close_sig', e.signature, e.id);
        set('closed_at', at(e.data.ts), e.id);
        break;
      }
      case 'BetConceded':
      case 'BetFinalized':
      case 'AppealResolved':
      case 'BetRefunded':
      case 'BetCancelled': {
        const d = e.data;
        const status = PG_STATUS[d.final_status];
        if (!status) break;
        const t: Terminal = {
          name: e.name,
          event_id: e.id,
          signature: e.signature,
          status,
          outcome: PG_OUTCOME[d.outcome],
          to_a: BigInt(d.to_a),
          to_b: BigInt(d.to_b),
          from_status: e.name === 'BetRefunded' ? (PG_STATUS[e.data.from_status] ?? null) : null,
        };
        out.terminal = t;
        set('payout_sig', e.signature, e.id);
        set('settled_at', at(d.ts), e.id);
        set('payout_a', t.to_a, e.id);
        set('payout_b', t.to_b, e.id);
        set('payout_via', TERMINAL_VIA[e.name], e.id);
        set('outcome', t.outcome, e.id);
        if (e.name === 'AppealResolved') set('appeal_ruling_hash', e.data.appeal_ruling_hash, e.id);
        bind('mint', d.mint, e.id);
        bind('party_a_wallet', d.party_a, e.id);
        bind('party_b_wallet', d.party_b, e.id);
        break;
      }
    }
  }
  if (out.columns.outcome === undefined && resolvedOutcome) out.columns.outcome = resolvedOutcome;
  return out;
}

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
};

export interface FoldMismatch {
  field: string;
  /** The chain's value and the row's, as strings (audit_log details). */
  chain: string;
  db: string | null;
  event_id: bigint | null;
}

/**
 * An outcome the RPC path wrote earlier (e.g. at resolve) legitimately changes when the terminal
 * event is an appeal decision, a timeout refund or a cancel (AppealResolved, BetRefunded,
 * BetCancelled): not a mismatch, just the newer value.
 */
const outcomeEvolves = (k: ProjectedKey, fold: ChainFold): boolean =>
  k === 'outcome' &&
  (fold.terminal?.name === 'AppealResolved' ||
    fold.terminal?.name === 'BetRefunded' ||
    fold.terminal?.name === 'BetCancelled');

export interface ProjectionDiff {
  /** What to write (empty: nothing to do). Never contains state / end_reason. */
  patch: ProjectedColumns &
    Partial<Pick<BetRow, 'onchain_status' | 'onchain_pending' | 'pending_sig'>>;
  /** The onchain_status after the write. */
  status: PgOnchainStatus;
  advanced: boolean;
  mismatches: FoldMismatch[];
}

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

/**
 * The write that brings `row` in line with the chain. Monotonic: onchain_status only advances,
 * and a terminal row keeps its status and money columns (a disagreement is reported instead).
 * Clears onchain_pending once the chain reached it (chain_ack -> stream).
 */
export function diffProjection(row: BetRow, fold: ChainFold): ProjectionDiff {
  const mismatches: FoldMismatch[] = [];
  const patch: ProjectionDiff['patch'] = {};
  const terminalLocked = isTerminalStatus(row.onchain_status);
  let status = row.onchain_status;
  if (statusRank(fold.status) > statusRank(row.onchain_status)) {
    if (terminalLocked)
      mismatches.push({
        field: 'onchain_status',
        chain: fold.status,
        db: row.onchain_status,
        event_id: fold.status_event,
      });
    else {
      patch.onchain_status = fold.status;
      status = fold.status;
    }
  } else if (
    terminalLocked &&
    fold.terminal &&
    fold.status !== row.onchain_status &&
    isTerminalStatus(fold.status)
  )
    mismatches.push({
      field: 'onchain_status',
      chain: fold.status,
      db: row.onchain_status,
      event_id: fold.status_event,
    });
  const money: ReadonlySet<ProjectedKey> = new Set([
    'payout_a',
    'payout_b',
    'payout_sig',
    'payout_via',
    'outcome',
    'settled_at',
  ]);
  for (const k of Object.keys(fold.columns) as ProjectedKey[]) {
    const v = fold.columns[k];
    if (v === undefined || v === null) continue;
    const cur = row[k];
    if (same(cur, v)) continue;
    // A terminal row's money columns are final; a chain disagreement there is reported only.
    const frozen = terminalLocked && money.has(k) && cur !== null;
    if (cur !== null && !outcomeEvolves(k, fold))
      mismatches.push({ field: k, chain: str(v)!, db: str(cur), event_id: fold.source[k] ?? null });
    if (!frozen) (patch as Record<string, unknown>)[k] = v;
  }
  for (const k of Object.keys(fold.binding) as BindingKey[]) {
    const v = fold.binding[k];
    if (v === undefined || same(row[k], v)) continue;
    mismatches.push({
      field: k,
      chain: str(v)!,
      db: str(row[k]),
      event_id: fold.source[k] ?? null,
    });
  }
  // The chain reached (or passed) what the RPC path was waiting for. Terminal statuses are not
  // ordered among themselves (settled / refunded / cancelled are alternatives), so any terminal
  // status settles any pending one.
  if (
    row.onchain_pending !== null &&
    status !== 'none' &&
    (statusRank(status) >= statusRank(row.onchain_pending) || isTerminalStatus(status))
  ) {
    patch.onchain_pending = null;
    patch.pending_sig = null;
  }
  return { patch, status, advanced: status !== row.onchain_status, mismatches };
}

// ---- the chain wins ---------------------------------------------------------------------------

const ORDER = BetState.options;
const stateRank = (s: BetState) => ORDER.indexOf(s);
const TERMINAL_STATES: ReadonlySet<BetState> = new Set(['PAID', 'VOIDED', 'CANCELLED', 'EXPIRED']);

export interface StateMove {
  state: BetState;
  end_reason: EndReason | null;
}

/**
 * The terminal facts impliedState needs: the fold's terminal event, else (the row is already
 * terminal onchain, e.g. projected by an earlier pass) what the row recorded from it.
 */
export function terminalFacts(
  fold: Pick<ChainFold, 'terminal'>,
  row: Pick<BetRow, 'onchain_status' | 'outcome' | 'accept_sig' | 'appealed_at'>,
): Pick<Terminal, 'outcome' | 'from_status'> | null {
  if (fold.terminal) return fold.terminal;
  if (!isTerminalStatus(row.onchain_status) || !row.outcome) return null;
  return {
    outcome: row.outcome,
    from_status:
      row.onchain_status !== 'refunded'
        ? null
        : row.accept_sig === null
          ? 'open'
          : row.appealed_at
            ? 'appealed'
            : 'locked',
  };
}

/** The offchain state an onchain status implies. */
export function impliedState(
  status: PgOnchainStatus,
  terminal: Pick<Terminal, 'outcome' | 'from_status'> | null,
  evidenceSource: BetRow['evidence_source'],
): StateMove | null {
  switch (status) {
    case 'none':
      return null;
    case 'open':
      return { state: 'AWAITING_LOCK', end_reason: null };
    case 'locked':
      return { state: 'LOCKED', end_reason: null };
    case 'resolved':
      return { state: 'RULED', end_reason: null };
    case 'appealed':
      return { state: 'APPEALED', end_reason: null };
    case 'settled':
      return { state: terminal?.outcome === 'refund' ? 'VOIDED' : 'PAID', end_reason: null };
    case 'refunded': {
      const from = terminal?.from_status ?? null;
      const end_reason: EndReason =
        from === 'open'
          ? evidenceSource === 'gemini'
            ? 'quote_expired'
            : 'accept_timeout'
          : from === 'appealed'
            ? 'appeal_timeout'
            : 'resolve_timeout';
      return { state: 'EXPIRED', end_reason };
    }
    case 'cancelled':
      return { state: 'CANCELLED', end_reason: 'cancelled' };
  }
}

/**
 * state := implied(onchain_status) when the implied state is later in the enum order, or when the
 * row is CANCELLED / EXPIRED while the chain shows locked..settled (the one exception bets_guard
 * allows). Every other terminal state is final. null = leave state alone.
 */
export function chainWins(
  row: Pick<BetRow, 'state' | 'end_reason'>,
  implied: StateMove | null,
  status: PgOnchainStatus,
): StateMove | null {
  if (!implied || implied.state === row.state) return null;
  if (TERMINAL_STATES.has(row.state)) {
    const revivable = row.state === 'CANCELLED' || row.state === 'EXPIRED';
    const inWindow =
      statusRank(status) >= STATUS_RANK.locked && statusRank(status) <= STATUS_RANK.settled;
    return revivable && inWindow ? implied : null;
  }
  return stateRank(implied.state) > stateRank(row.state) ? implied : null;
}
