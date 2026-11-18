// GET /v1/me/bets?status=active|settled|all&cursor&limit (B) — API-CONTRACT §2.14.
//   200 {items: MeBetItem[], next_cursor}  (packages/shared api.ts MeBetsResponse)
// Each item is the same BetSnapshot GET /v1/bets/:bet_id returns (stage loadBetSnapshot) plus the
// BetSummary list fields, so the judge-cam phone (apps/mobile DemoApp, which polls
// `?status=active&limit=5` and reads `items[].bet_id`) can adopt it directly.
//
// Who sees what: only bets the caller is a party of, from any of the caller's devices. The demo
// judge cam is a second device of party A (API-CONTRACT §2.9 "Judge-cam identity"), so it finds
// A's bets here as a party. A judge-cam device's room bets of OTHER pairs are deliberately not
// listed: GET /v1/bets/:id (stage/routes canRead) and the WS bet subscription
// (realtime/access canSeeBet) are party-or-stage only, so the phone could not open them, and a
// newer foreign bet sorting first would starve its own. Every item is GETtable by the caller.
// Newest first (created_at, id); the cursor is the last item's bet_id.
import { and, desc, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { bets } from '@youre-on/db';
import { MeBetsStatus, type MeBetItem, type MeBetsResponse } from '@youre-on/shared/api';
import { TERMINAL_BET_STATES } from '@youre-on/shared/bet-state';
import { BetId } from '@youre-on/shared/primitives';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { partyOf, type BetRow } from '../bets/snapshot';
import { loadBetSnapshot } from '../stage/routes';

export const ME_BETS_DEFAULT_LIMIT = 20;
export const ME_BETS_MAX_LIMIT = 50;
const SETTLED_STATES = ['PAID', 'VOIDED'] as const;
const FROM_PG = { party_a: 'PartyA', party_b: 'PartyB', split: 'Split', refund: 'Refund' } as const;

export interface MeBetsQuery {
  status: MeBetsStatus;
  limit: number;
  cursor: string | null;
}

const invalid = (path: string, message: string) =>
  new HttpError('VALIDATION_FAILED', undefined, { issues: [{ path, message }] });

export function parseMeBetsQuery(q: {
  status?: string;
  limit?: string;
  cursor?: string;
}): MeBetsQuery {
  const status = MeBetsStatus.safeParse(q.status ?? 'all');
  if (!status.success) throw invalid('status', "one of 'active', 'settled', 'all'");
  let limit = ME_BETS_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    limit = /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!(limit >= 1 && limit <= ME_BETS_MAX_LIMIT))
      throw invalid('limit', `an integer 1..${ME_BETS_MAX_LIMIT}`);
  }
  let cursor: string | null = null;
  if (q.cursor !== undefined && q.cursor !== '') {
    const c = BetId.safeParse(q.cursor);
    if (!c.success) throw invalid('cursor', 'not a cursor from this endpoint');
    cursor = c.data;
  }
  return { status: status.data, limit, cursor };
}

export async function listMyBets(
  deps: Pick<AppDeps, 'db' | 'log'>,
  me: { user_id: string },
  q: MeBetsQuery,
): Promise<MeBetsResponse> {
  const active = notInArray(bets.state, [...TERMINAL_BET_STATES]);
  const party = or(eq(bets.party_a_id, me.user_id), eq(bets.party_b_id, me.user_id))!;
  const where: SQL[] = [party];
  if (q.status === 'active') where.push(active);
  if (q.status === 'settled') where.push(inArray(bets.state, [...SETTLED_STATES]));
  if (q.cursor) {
    // Row comparison against the cursor bet's own (created_at, id): exact at microsecond precision.
    where.push(
      sql`(${bets.created_at}, ${bets.id}) < (SELECT b.created_at, b.id FROM bets b WHERE b.id = ${q.cursor})`,
    );
  }
  const rows = await deps.db
    .select()
    .from(bets)
    .where(and(...where))
    .orderBy(desc(bets.created_at), desc(bets.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);

  const items: MeBetItem[] = [];
  for (const row of page) {
    const item = await toItem(deps, row, me.user_id);
    if (item) items.push(item);
  }
  return {
    items,
    next_cursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}

async function toItem(
  deps: Pick<AppDeps, 'db' | 'log'>,
  row: BetRow,
  userId: string,
): Promise<MeBetItem | null> {
  let snap;
  try {
    snap = await loadBetSnapshot(deps, row, userId);
  } catch (err) {
    // A party without a wallet (an unclaimed demo account) has no UserRef, so no BetSnapshot.
    deps.log.warn('me.bets_item_skipped', { bet_id: row.id, err });
    return null;
  }
  const mine = partyOf(row, userId);
  if (!mine) return null; // unreachable: the query is party-only
  const stake = mine === 'A' ? row.stake_a : row.stake_b;
  const paid = mine === 'A' ? row.payout_a : row.payout_b;
  return {
    ...snap,
    // The terms' title; else the row's own (a seed-h2h row has no terms: "Demo history: ...").
    title: snap.envelope?.presentation.title ?? row.title ?? 'Challenge',
    opponent: mine === 'A' ? snap.party_b : snap.party_a,
    my_stake: stake?.toString() ?? null,
    my_payout: paid?.toString() ?? null,
    outcome: row.outcome ? FROM_PG[row.outcome] : null,
    settled_at: row.settled_at?.toISOString() ?? null,
    is_seed: row.is_seed,
  };
}
