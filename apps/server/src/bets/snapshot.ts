// BetSnapshot (API-CONTRACT §2.18) from a `bets` row plus the two parties' UserRefs.
// Exported for other streams: GET /v1/bets/:bet_id (§2.14), terms, lock, etc. should build
// their `{bet: BetSnapshot}` responses with `betSnapshot()` too.
//
// Fields this stream cannot fill yet are null until their owners land: `envelope` / `draft`
// (terms stream: bet_terms_versions), `pending_tx` (lock/tx stream: chain_txs), `attempt_no`,
// `latest_ruling`, `appeal`. Pass them through `extras` when you have them.
import { inArray } from 'drizzle-orm';
import { bets, users, type Db } from '@youre-on/db';
import type { BetSnapshot } from '@youre-on/shared/api';
import type { BetState, ChainAck, OnchainStatus } from '@youre-on/shared/bet-state';
import type { Party, UserRef } from '@youre-on/shared/primitives';
import { HttpError } from '../errors';

export type BetRow = typeof bets.$inferSelect;
type UserRow = Pick<typeof users.$inferSelect, 'id' | 'display_name' | 'wallet_pubkey'>;

const ONCHAIN: Record<Exclude<BetRow['onchain_status'], 'none'>, OnchainStatus> = {
  open: 'Open',
  locked: 'Locked',
  resolved: 'Resolved',
  appealed: 'Appealed',
  settled: 'Settled',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
};

/** Postgres onchain_status ('none' | snake_case) -> SCHEMAS OnchainStatus (null for 'none'). */
export function toOnchainStatus(s: BetRow['onchain_status'] | null): OnchainStatus | null {
  return s === null || s === 'none' ? null : ONCHAIN[s];
}

/**
 * DATA-MODEL §8.4: 'rpc' while our own RPC `confirmed` set `onchain_pending` and Streams has
 * not echoed it yet (onchain_status still holds the OLD status, e.g. 'locked' while RULED is
 * rpc-confirmed); 'stream' once the projector applied it; 'none' before anything onchain.
 */
export function chainAckOf(row: Pick<BetRow, 'onchain_status' | 'onchain_pending'>): ChainAck {
  if (row.onchain_pending !== null) return 'rpc';
  if (row.onchain_status !== 'none') return 'stream';
  return 'none';
}

/** users row -> UserRef. A wallet-less user (unclaimed demo account) has no UserRef. */
export function userRefOf(u: UserRow): UserRef | null {
  if (!u.wallet_pubkey) return null;
  return {
    user_id: u.id,
    pubkey: u.wallet_pubkey as UserRef['pubkey'], // users_wallet_pubkey_fmt CHECK
    display_name: u.display_name,
    avatar_url: null, // presigned avatar URLs land with POST /v1/me/avatar (S3, PENDING)
  };
}

/** Loads UserRefs by id; throws INVALID_STATE if a requested user has no wallet or is missing. */
export async function loadUserRefs(
  db: Pick<Db, 'select'>,
  ids: readonly string[],
): Promise<Map<string, UserRef>> {
  const rows = await db
    .select({ id: users.id, display_name: users.display_name, wallet_pubkey: users.wallet_pubkey })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  const out = new Map<string, UserRef>();
  for (const r of rows) {
    const ref = userRefOf(r);
    if (ref) out.set(r.id, ref);
  }
  for (const id of ids) {
    if (!out.has(id)) {
      throw new HttpError('INVALID_STATE', 'That player has no wallet yet.', {
        reason: 'no_wallet',
        user_id: id,
      });
    }
  }
  return out;
}

const unix = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);
const iso = (d: Date): string => d.toISOString();

export interface SnapshotExtras {
  prev_state?: BetState | null;
  envelope?: BetSnapshot['envelope'];
  draft?: BetSnapshot['draft'];
  pending_tx?: BetSnapshot['pending_tx'];
  attempt_no?: number | null;
  latest_ruling?: BetSnapshot['latest_ruling'];
  appeal?: BetSnapshot['appeal'];
}

export function partyOf(
  row: Pick<BetRow, 'party_a_id' | 'party_b_id'>,
  userId: string | null,
): Party | null {
  if (userId === row.party_a_id) return 'A';
  if (userId === row.party_b_id) return 'B';
  return null;
}

/** Builds the §2.18 BetSnapshot. `viewerUserId` sets `my_party`. */
export function betSnapshot(
  row: BetRow,
  refs: { a: UserRef; b: UserRef },
  viewerUserId: string | null,
  extras: SnapshotExtras = {},
): BetSnapshot {
  const signatures: Record<string, string> = {};
  const lockSig = row.accept_sig ?? row.create_sig; // atomic: one tx carries both
  if (lockSig) signatures.lock = lockSig;
  if (row.resolve_sig) signatures.resolve = row.resolve_sig;
  if (row.appeal_sig) signatures.appeal = row.appeal_sig;
  if (row.payout_sig) signatures.payout = row.payout_sig;
  if (row.close_sig) signatures.close = row.close_sig;

  const auth = (at: Date | null, method: BetRow['a_authorization_method']) =>
    at && method ? { method, authorized_at: iso(at) } : null;

  return {
    bet_id: row.id,
    room_id: row.room_id,
    state: row.state,
    prev_state: extras.prev_state ?? null,
    onchain_status: toOnchainStatus(row.onchain_status),
    chain_ack: chainAckOf(row),
    pending_tx: extras.pending_tx ?? null,
    party_a: refs.a,
    party_b: refs.b,
    my_party: partyOf(row, viewerUserId),
    envelope: extras.envelope ?? null,
    draft: extras.draft ?? null,
    authorizations: {
      A: auth(row.a_authorized_at, row.a_authorization_method),
      B: auth(row.b_authorized_at, row.b_authorization_method),
    },
    deadlines: {
      accept_deadline: unix(row.accept_deadline),
      resolve_deadline: unix(row.resolve_deadline),
      appeal_deadline: unix(row.appeal_deadline),
      appeal_resolve_deadline: unix(row.appeal_resolve_deadline),
    },
    attempt_no: extras.attempt_no ?? null,
    redo_count: row.redo_count,
    latest_ruling: extras.latest_ruling ?? null,
    appeal: extras.appeal ?? null,
    payout:
      row.payout_a !== null && row.payout_b !== null
        ? { to_a: row.payout_a.toString(), to_b: row.payout_b.toString() }
        : null,
    signatures: signatures as BetSnapshot['signatures'],
    end_reason: row.end_reason,
    last_seq: row.last_seq,
  };
}
