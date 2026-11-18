// POST /v1/demo/seed-h2h {a_wins?, b_wins?} (default 4-7): the head-to-head history between the
// two demo players, so the face-match reply says "You're 4-7 against Jake" (API-CONTRACT §2.4,
// BRIEF Extra beat). This is the DATA-MODEL §11 SQL fallback, as a route the operator can run
// against the live database (no psql to Neon on pitch day).
//
// The rows are labelled the only way the server knows: `is_seed = true`, the marker demo reset
// (demo/reset.ts) keeps (it deletes `NOT is_seed` bets and never voids a seed bet's escrow) and
// head-to-head flags (`includes_seed`, face/service.ts). Titles start with "Demo history:".
// Each row is a terminal, settled bet with no chain footprint: state PAID, onchain_status
// 'settled', outcome party_a / party_b with the winner paid both stakes (bets_payout_rule),
// terms_hash / stakes / evidence_source set (bets_binding_set), no signatures and no
// authorizations (bets_terminal_sig and bets_locked_authorized exempt seeds), no chain_txs, no
// events, no room (the projector never shows them), one a day in the past, challenger
// alternating. Inserts only, so bets_guard (BEFORE UPDATE) never runs; bets_parties_attested
// exempts seeds.
//
// Idempotent: each seeding first deletes every is_seed bet between the pair (either direction),
// in the same transaction, so re-seeding replaces the old rows (and {0, 0} just clears them).
// demo-a / demo-b are the users holding the demo wallets (demo/players.ts demoPartyWallets):
// claim the phones (or sign the wallets up with cp1-drive) first.
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import { auditLog, bets, users } from '@youre-on/db';
import { USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import type { HeadToHead } from '@youre-on/shared/api';
import { sha256Hex } from '@youre-on/shared/primitives';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { headToHead } from '../face/service';
import { demoPartyWallets } from './players';

export const SEED_H2H_DEFAULT = { a_wins: 4, b_wins: 7 } as const;
/** Per side; the rows are one a day, so this also bounds how far back they go. */
export const SEED_H2H_MAX = 30;

export const SeedH2hRequest = z.object({
  /** demo-a's wins (the face-match line on A's phone reads `a_wins-b_wins`). */
  a_wins: z.number().int().min(0).max(SEED_H2H_MAX).optional(),
  b_wins: z.number().int().min(0).max(SEED_H2H_MAX).optional(),
});

/** Stakes in USD, cycled (DATA-MODEL §11). */
const STAKES_USD = [1, 2, 5, 3, 5, 1, 2, 5, 4, 5, 2] as const;
const TITLES = ['Bottle flip', 'Free throw', 'Coin catch', 'Paper ball in the bin'] as const;
/** DATA-MODEL §11: in the default 4-7, demo-a wins bets 2, 5, 7 and 10 (net −$7.00). */
const DEFAULT_A_WINS_AT = new Set([2, 5, 7, 10]);
const DAY_MS = 86_400_000;

export interface SeedPlayer {
  user_id: string;
  display_name: string;
  wallet: string;
}

export interface SeedH2hResult {
  a: SeedPlayer;
  b: SeedPlayer;
  a_wins: number;
  b_wins: number;
  /** Seed rows of this pair deleted first. */
  replaced: number;
  inserted: number;
  head_to_head: { a_vs_b: HeadToHead; b_vs_a: HeadToHead };
}

/** Which of bets 1..n demo-a wins: the §11 pattern for 4-7, else spread evenly. */
export function seedWinners(aWins: number, bWins: number): boolean[] {
  const n = aWins + bWins;
  if (aWins === SEED_H2H_DEFAULT.a_wins && bWins === SEED_H2H_DEFAULT.b_wins)
    return Array.from({ length: n }, (_, i) => DEFAULT_A_WINS_AT.has(i + 1));
  return Array.from(
    { length: n },
    (_, i) => Math.floor(((i + 1) * aWins) / n) > Math.floor((i * aWins) / n),
  );
}

async function demoPlayer(deps: AppDeps, party: 'a' | 'b', wallet: string | null) {
  const missing = (why: string) =>
    new HttpError('INVALID_STATE', `demo-${party} ${why}.`, {
      reason: 'demo_player_missing',
      party,
    });
  if (!wallet) throw missing('has no key on this server (DEMO_A / DEMO_B_SECRET_KEY)');
  const [u] = await deps.db
    .select({ id: users.id, display_name: users.display_name, wallet: users.wallet_pubkey })
    .from(users)
    .where(and(eq(users.wallet_pubkey, wallet), isNull(users.deleted_at)))
    .limit(1);
  if (!u)
    throw missing(
      `has no account yet: claim it on its phone (npm run demo-claim-qr -- --party ${party}) or sign it up (cp1-drive)`,
    );
  return { user_id: u.id, display_name: u.display_name, wallet };
}

export async function seedHeadToHead(
  deps: AppDeps,
  req: z.infer<typeof SeedH2hRequest>,
  o: { requestId?: string } = {},
): Promise<SeedH2hResult> {
  const aWins = req.a_wins ?? SEED_H2H_DEFAULT.a_wins;
  const bWins = req.b_wins ?? SEED_H2H_DEFAULT.b_wins;
  const wallets = await demoPartyWallets(deps);
  const A = await demoPlayer(deps, 'a', wallets.a);
  const B = await demoPlayer(deps, 'b', wallets.b);
  if (A.user_id === B.user_id)
    throw new HttpError('INVALID_STATE', 'demo-a and demo-b are the same account.', {
      reason: 'demo_player_missing',
    });

  const winners = seedWinners(aWins, bWins);
  const n = winners.length;
  const now = deps.now();
  const mint = deps.env.USDC_MINT ?? USDC_MINT_DEVNET;
  const rows = winners.map((aWon, i) => {
    const k = i + 1;
    // Alternate the challenger (party A of the row), as the §11 SQL does.
    const [pa, pb] = k % 2 === 1 ? [A, B] : [B, A];
    const winnerIsPa = aWon === (pa === A);
    const stake = BigInt(STAKES_USD[i % STAKES_USD.length]!) * 1_000_000n;
    const t0 = now - (n + 1 - k) * DAY_MS - 3 * 3_600_000;
    const at = (s: number) => new Date(t0 + s * 1000);
    return {
      id: randomUUID(),
      room_id: null,
      party_a_id: pa.user_id,
      party_b_id: pb.user_id,
      party_a_wallet: pa.wallet,
      party_b_wallet: pb.wallet,
      challenge_method: 'face' as const,
      title: `Demo history: ${TITLES[k % TITLES.length]}`,
      evidence_source: 'camera' as const,
      state: 'PAID' as const,
      onchain_status: 'settled' as const,
      mint,
      stake_a: stake,
      stake_b: stake,
      terms_hash: sha256Hex(`seed-h2h:${pa.user_id}:${pb.user_id}:${k}`),
      outcome: winnerIsPa ? ('party_a' as const) : ('party_b' as const),
      payout_a: winnerIsPa ? 2n * stake : 0n,
      payout_b: winnerIsPa ? 0n : 2n * stake,
      payout_via: 'concede' as const,
      created_at: at(0),
      terms_final_at: at(30),
      locked_at: at(45),
      resolved_at: at(90),
      settled_at: at(92),
      updated_at: at(92),
      is_seed: true,
    };
  });

  const pair = or(
    and(eq(bets.party_a_id, A.user_id), eq(bets.party_b_id, B.user_id)),
    and(eq(bets.party_a_id, B.user_id), eq(bets.party_b_id, A.user_id)),
  );
  const { replaced } = await deps.db.transaction(async (tx) => {
    // One seeding at a time (a double-click must not leave two sets).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('demo.seed_h2h'))`);
    const gone = await tx
      .delete(bets)
      .where(and(eq(bets.is_seed, true), pair))
      .returning({ id: bets.id });
    if (rows.length) await tx.insert(bets).values(rows);
    await tx.insert(auditLog).values({
      actor_kind: 'system',
      action: 'demo.seed_h2h',
      request_id: o.requestId ?? null,
      details: {
        a_user_id: A.user_id,
        b_user_id: B.user_id,
        a_wins: aWins,
        b_wins: bWins,
        replaced: gone.length,
        inserted: rows.length,
      },
    });
    return { replaced: gone.length };
  });
  deps.log.info('demo.seed_h2h', { a_wins: aWins, b_wins: bWins, replaced, inserted: n });
  return {
    a: A,
    b: B,
    a_wins: aWins,
    b_wins: bWins,
    replaced,
    inserted: n,
    head_to_head: {
      a_vs_b: await headToHead(deps.db, A.user_id, B.user_id),
      b_vs_a: await headToHead(deps.db, B.user_id, A.user_id),
    },
  };
}
