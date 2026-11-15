/**
 * `GET /leaderboard ?huddle_id=` (§12.3): net result per user, backfilled
 * from terminal bets (`Settled` / `Refunded`; the chain account is read so a
 * missed event cannot leave the board stale). Net = received − stake − bond.
 *
 * With `huddle_id` the board covers that huddle's members (net 0 included)
 * and the bets among them: bets compiled in the huddle and World bets whose
 * participants are all members. The caller must be a member.
 */
import { BET_STATE, type BetAccount, type Program } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { WORLD_BETS_COLLECTION } from '../integration/sources.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import { betMirror } from './records.js';
import { netUnits, settlementFacts } from './settlement.js';

export interface LeaderboardRow {
  user_id: string;
  display_name: string;
  net_units: number;
}

interface HuddleLike {
  id: string;
  members: { user_id: string; joined_at_ms?: number }[];
}

interface BetRef {
  id: string;
  program: Program;
  huddle_id: string | null;
}

function allBetRefs(ctx: AppContext): BetRef[] {
  const out: BetRef[] = betMirror(ctx)
    .values()
    .map((r) => ({ id: r.id, program: r.program, huddle_id: r.huddle_id }));
  for (const r of ctx.store.collection<{ bet: string; program: Program }>(WORLD_BETS_COLLECTION).values()) {
    if (!out.some((x) => x.id === r.bet)) out.push({ id: r.bet, program: r.program, huddle_id: null });
  }
  return out;
}

export async function leaderboard(ctx: AppContext, user: UserRecord, huddleId: string | null): Promise<{ rows: LeaderboardRow[] }> {
  const users = ctx.store.collection<UserRecord>(COLLECTIONS.users);
  const byWallet = new Map(users.values().map((u) => [u.wallet, u]));
  let scope: Set<string> | null = null;
  if (huddleId) {
    const h = ctx.store.collection<HuddleLike>(COLLECTIONS.huddles).get(huddleId);
    if (!h || !h.members.some((m) => m.user_id === user.id)) throw new ApiError('NOT_FOUND', `huddle ${huddleId}`);
    scope = new Set(h.members.map((m) => m.user_id));
  }
  const net = new Map<string, number>();
  if (scope) for (const id of scope) net.set(id, 0);

  for (const ref of allBetRefs(ctx)) {
    const uids = ref.program.participants.map((w) => byWallet.get(w)?.id ?? null);
    if (scope) {
      const inHuddle = ref.huddle_id === huddleId || (ref.huddle_id === null && uids.every((u) => u !== null && scope!.has(u)));
      if (!inHuddle) continue;
    }
    let bet: BetAccount | null;
    try {
      bet = await ctx.chain.getBet(ref.id);
    } catch {
      bet = null;
    }
    if (!bet || (bet.state !== BET_STATE.Settled && bet.state !== BET_STATE.Refunded)) continue;
    const facts = settlementFacts(ctx, bet, ref.id);
    if (!facts) continue;
    uids.forEach((uid, i) => {
      if (!uid || (scope && !scope.has(uid))) return;
      net.set(uid, (net.get(uid) ?? 0) + netUnits(bet, facts, i));
    });
  }

  const rows = [...net.entries()].map(([user_id, net_units]) => ({
    user_id,
    display_name: users.get(user_id)?.display_name ?? 'Player',
    net_units,
  }));
  rows.sort((a, b) => b.net_units - a.net_units || a.display_name.localeCompare(b.display_name));
  return { rows };
}
