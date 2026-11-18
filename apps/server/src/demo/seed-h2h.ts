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
// Category records (odds, API-CONTRACT §2.4 `records`): {player, category, made, missed} rows make
// that player the performer of `made + missed` bets of that kind (a bottle flip, a paper-ball
// throw), so the judge's suggested odds can quote "Jake is 10 for 12 on bottle flips". Every seed
// row now carries a real composed Terms row (bet_terms_versions, is_final, drafted_by 'judge',
// source_tool 'seed'; bets.terms_hash = its hash), which is where the stats read the claim,
// performer and yes_party from. Record rows count toward the head-to-head: a's made + b's missed
// <= a_wins, b's made + a's missed <= b_wins (422 otherwise); the remaining wins are the rotating
// titles (their performer is the row's party B, the yes party). Still "Demo history: …", is_seed.
//
// Idempotent: each seeding first deletes every is_seed bet between the pair (either direction),
// in the same transaction, so re-seeding replaces the old rows (and {0, 0} just clears them).
// demo-a / demo-b are the users holding the demo wallets (demo/players.ts demoPartyWallets):
// claim the phones (or sign the wallets up with cp1-drive) first.
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import { auditLog, bets, betTermsVersions, users } from '@youre-on/db';
import type { PerformerStats } from '@youre-on/shared/odds';
import { USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import type { HeadToHead } from '@youre-on/shared/api';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { headToHead } from '../face/service';
import { composeTerms } from '../lock/terms';
import { performerStats } from '../odds/stats';
import { demoPartyWallets } from './players';

export const SEED_H2H_DEFAULT = { a_wins: 4, b_wins: 7 } as const;
/** Per side; the rows are one a day, so this also bounds how far back they go. */
export const SEED_H2H_MAX = 30;

export const SeedH2hRequest = z.object({
  /** demo-a's wins (the face-match line on A's phone reads `a_wins-b_wins`). */
  a_wins: z.number().int().min(0).max(SEED_H2H_MAX).optional(),
  b_wins: z.number().int().min(0).max(SEED_H2H_MAX).optional(),
  /** Odds rehearsal: a player's record on one kind of challenge (labelled demo history). */
  records: z
    .array(
      z.object({
        player: z.enum(['a', 'b']),
        category: z.enum(['bottle_flip', 'throw']),
        made: z.number().int().min(0).max(SEED_H2H_MAX),
        missed: z.number().int().min(0).max(SEED_H2H_MAX),
      }),
    )
    .max(3)
    .optional(),
});
export type SeedRecord = NonNullable<z.infer<typeof SeedH2hRequest>['records']>[number];

/** Stakes in USD, cycled (DATA-MODEL §11). */
const STAKES_USD = [1, 2, 5, 3, 5, 1, 2, 5, 4, 5, 2] as const;
const TITLES = ['Bottle flip', 'Free throw', 'Coin catch', 'Paper ball in the bin'] as const;
type Title = (typeof TITLES)[number];
/** Each title's claim (performer's name first) and challenge category. */
const CLAIMS: Record<Title, { claim: (p: string) => string; category: string }> = {
  'Bottle flip': {
    claim: (p) => `${p} lands a water bottle flip upright on the table.`,
    category: 'bottle_flip',
  },
  'Free throw': { claim: (p) => `${p} sinks a free throw.`, category: 'throw' },
  'Coin catch': {
    claim: (p) => `${p} catches a spun coin on the back of the hand.`,
    category: 'other',
  },
  'Paper ball in the bin': {
    claim: (p) => `${p} throws a paper ball into the bin.`,
    category: 'throw',
  },
};
const RECORD_TITLE = { bottle_flip: 'Bottle flip', throw: 'Paper ball in the bin' } as const;
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
  /** One per requested record: the stats the judge's odds read for that player and category. */
  performer_stats: PerformerStats[];
}

/** One seeded bet, before it becomes rows: who challenged, who performed, who won. */
interface SeedBet {
  challenger: 'a' | 'b';
  /** The performer is the row's party B; it is also the yes party. */
  title: Title;
  /** The performer (party B) won. */
  made: boolean;
}

/** a's made + b's missed <= a_wins (and the mirror): record rows are head-to-head rows too. */
export function seedPlan(
  aWins: number,
  bWins: number,
  records: readonly SeedRecord[],
): { ok: true; bets: SeedBet[] } | { ok: false; message: string } {
  const sum = (p: 'a' | 'b', k: 'made' | 'missed') =>
    records.filter((r) => r.player === p).reduce((n, r) => n + r[k], 0);
  const aUsed = sum('a', 'made') + sum('b', 'missed');
  const bUsed = sum('b', 'made') + sum('a', 'missed');
  if (aUsed > aWins || bUsed > bWins)
    return {
      ok: false,
      message: `records need ${aUsed}-${bUsed} of the ${aWins}-${bWins} head-to-head`,
    };
  // Each record: the player performs (party B of the row), misses spread evenly (seedWinners).
  const lanes: SeedBet[][] = records.map((r) =>
    seedWinners(r.made, r.missed).map((made) => ({
      challenger: r.player === 'a' ? 'b' : 'a',
      title: RECORD_TITLE[r.category],
      made,
    })),
  );
  // The rest of the head-to-head: rotating titles, skipping categories a record defines.
  const taken = new Set(records.map((r) => r.category as string));
  const titles = TITLES.filter((t) => !taken.has(CLAIMS[t].category));
  const fill = records.length
    ? seedWinners(aWins - aUsed, bWins - bUsed)
    : seedWinners(aWins, bWins);
  const filler: SeedBet[] = fill.map((aWon, i) => {
    const k = i + 1;
    const challenger = k % 2 === 1 ? 'a' : 'b';
    // party B performs; a won iff (a is party B and made) or (a is party A and B missed).
    const made = challenger === 'a' ? !aWon : aWon;
    const pool = titles.length ? titles : (['Coin catch'] as Title[]);
    return {
      challenger,
      title: records.length ? pool[k % pool.length]! : TITLES[k % TITLES.length]!,
      made,
    };
  });
  // Interleave the lanes and the filler, oldest first.
  const all = [...lanes, filler].filter((l) => l.length);
  const out: SeedBet[] = [];
  const total = all.reduce((n, l) => n + l.length, 0);
  const idx = all.map(() => 0);
  while (out.length < total) {
    // the lane furthest behind its even share goes next
    let best = 0;
    let bestScore = Infinity;
    all.forEach((l, j) => {
      if (idx[j]! >= l.length) return;
      const score = (idx[j]! + 1) / l.length;
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    });
    out.push(all[best]![idx[best]!]!);
    idx[best]!++;
  }
  return { ok: true, bets: out };
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

  const records = req.records ?? [];
  const plan = seedPlan(aWins, bWins, records);
  if (!plan.ok)
    throw new HttpError('VALIDATION_FAILED', `The records don't fit: ${plan.message}.`, {
      issues: [{ path: 'records', message: plan.message }],
    });
  const n = plan.bets.length;
  const now = deps.now();
  const mint = deps.env.USDC_MINT ?? USDC_MINT_DEVNET;
  const built = plan.bets.map((sb, i) => {
    const k = i + 1;
    const [pa, pb] = sb.challenger === 'a' ? [A, B] : [B, A];
    const winnerIsPa = !sb.made;
    const stake = BigInt(STAKES_USD[i % STAKES_USD.length]!) * 1_000_000n;
    const t0 = now - (n + 1 - k) * DAY_MS - 3 * 3_600_000;
    const at = (s: number) => new Date(t0 + s * 1000);
    const id = randomUUID();
    const claim = CLAIMS[sb.title].claim(pb.display_name);
    // A real composed card: the claim, performer B (the yes party) and the stakes the stats read.
    const composed = composeTerms({
      bet: { id, mint },
      a: { pubkey: pa.wallet, display_name: pa.display_name },
      b: { pubkey: pb.wallet, display_name: pb.display_name },
      proposal: {
        type: 'skill',
        claim,
        performer: 'B',
        yes_party: 'B',
        attempts: { count: 1, rule: 'single' },
        success_criteria: [claim],
        failure_criteria: [],
        edge_cases: [],
        evidence_source: 'camera',
        amount: stake.toString(),
        amount_b: null,
        market_query: null,
        deadline_minutes: null,
      },
      cluster: deps.env.SOLANA_CLUSTER,
      nowMs: t0,
    });
    const bet = {
      id,
      room_id: null,
      party_a_id: pa.user_id,
      party_b_id: pb.user_id,
      party_a_wallet: pa.wallet,
      party_b_wallet: pb.wallet,
      challenge_method: 'face' as const,
      title: `Demo history: ${sb.title}`,
      evidence_source: 'camera' as const,
      state: 'PAID' as const,
      onchain_status: 'settled' as const,
      mint,
      stake_a: stake,
      stake_b: stake,
      terms_hash: composed.terms_hash,
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
    const version = {
      bet_id: id,
      version: 1,
      schema_version: 1,
      drafted_by: 'judge' as const,
      source_tool: 'seed',
      canonical_json: composed.canonical,
      terms_hash: composed.terms_hash,
      is_final: true,
    };
    return { bet, version };
  });
  const rows = built.map((x) => x.bet);

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
    if (rows.length) {
      await tx.insert(bets).values(rows);
      await tx.insert(betTermsVersions).values(built.map((x) => x.version));
    }
    await tx.insert(auditLog).values({
      actor_kind: 'system',
      action: 'demo.seed_h2h',
      request_id: o.requestId ?? null,
      details: {
        a_user_id: A.user_id,
        b_user_id: B.user_id,
        a_wins: aWins,
        b_wins: bWins,
        records,
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
    performer_stats: await Promise.all(
      records.map((r) => {
        const [me, them] = r.player === 'a' ? [A, B] : [B, A];
        return performerStats(deps.db, {
          performerId: me.user_id,
          opponentId: them.user_id,
          category: r.category,
          performerParty: 'B',
          displayName: me.display_name,
        });
      }),
    ),
  };
}
