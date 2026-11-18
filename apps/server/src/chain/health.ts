// Chain health for the pitch (GET /v1/demo/health, the keeper's 'chain-health' log line, the boot
// line, scripts/demo-check.ts): balances, the nonce pool, RPC latency and errors, the keeper,
// transactions and bets that are stuck, orphan escrow, the Stream and the Gemini relay, plus a
// list of warnings with one fix hint each. `ok` is false when any warning is critical.
//
// Read-only. RPC reads run in parallel and each is time-boxed by the transport (src/chain/tx.ts),
// so the report answers within a few seconds even when the RPC is in trouble (that is a warning).
import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { address, type Address } from '@solana/kit';
import { bets, chainEvents, chainTxs, noncePool } from '@youre-on/db';
import type { BetState } from '@youre-on/shared/bet-state';
import { formatUsd } from '@youre-on/shared/money';
import type { AppDeps } from '../context';
import type { KeeperStatus } from '../keeper/keeper';
import { lifecycleOf } from '../lock/runtime';
import { APPEAL_FAMILY, LOCKED_FAMILY, type OrphanSummary } from '../payout/refund';
import { ataOf, rpcErrorText, tokenAmount, type ChainRuntime, type RpcStatsSnapshot } from './tx';

export const HEALTH = {
  /** Below this the fee payer cannot pay for a rehearsal day (fees + ATA / Bet rent). */
  feePayerWarnLamports: 1_000_000_000n,
  /** Below this a few transactions may already fail. */
  feePayerCriticalLamports: 100_000_000n,
  /** Fewer free nonces than this and a second concurrent lock can fail (NONCE_POOL_EXHAUSTED). */
  minFreeNonces: 2,
  /** The treasury tops the demo wallets up (scripts/fund.ts). */
  treasuryWarnMicro: 20_000_000n,
  /** Per demo wallet: several $1 rehearsals. */
  demoWalletWarnMicro: 5_000_000n,
  /** One $1 stake (the demo bet). */
  demoWalletCriticalMicro: 1_000_000n,
  rpcP95WarnMs: 2_000,
  /** Error share of the RPC window above which the RPC is flagged. */
  rpcErrorRateWarn: 0.1,
  /** A 'sent' tx older than this is stuck (confirms take ~1 s; the reconcilers retry every 5 s). */
  stuckTxMs: 2 * 60_000,
  /** A leased / advancing nonce older than this is stuck. */
  stuckNonceMs: 15 * 60_000,
  /** Keeper errors newer than this count. */
  keeperErrorWindowMs: 10 * 60_000,
} as const;

export type HealthLevel = 'warn' | 'critical';
export interface HealthWarning {
  code: string;
  level: HealthLevel;
  message: string;
}

export interface WalletHealth {
  address: string;
  usdc: string | null;
  usdc_display: string | null;
}

export interface ChainHealthReport {
  ok: boolean;
  warnings: HealthWarning[];
  server_time: string;
  chain_configured: boolean;
  lock_signer: 'phones' | 'server';
  rpc: string | null;
  fee_payer: string | null;
  fee_payer_pinned: boolean | null;
  fee_payer_sol: number | null;
  judge: string | null;
  custodial: { a: string | null; b: string | null };
  nonce_pool: { size: number; free: number; leased: number; advancing: number; retired: number };
  last_tx: Record<string, unknown> | null;
  rpc_ms: number | null;
  rpc_error: string | null;
  db_ms: number;
  balances: {
    treasury: WalletHealth | null;
    demo_a: WalletHealth | null;
    demo_b: WalletHealth | null;
  };
  rpc_stats: RpcStatsSnapshot | null;
  keeper: KeeperStatus | null;
  inflight: { sent_txs: number; oldest_sent_at: string | null; stuck: StuckTx[] };
  stuck_bets: StuckBet[];
  escrow: OrphanSummary | null;
  stream: { last_delivery_at: string | null; events_last_hour: number };
  markets: { last_ok_at: string | null; last_error: string | null } | null;
}

export interface StuckTx {
  bet_id: string;
  kind: string;
  signature: string | null;
  sent_at: string | null;
}
export interface StuckBet {
  bet_id: string;
  state: BetState;
  why: string;
}

const iso = (d: Date | number | null | undefined) =>
  d === null || d === undefined ? null : new Date(d).toISOString();

async function settle<T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; err: string }> {
  try {
    return { ok: true, v: await p };
  } catch (e) {
    return { ok: false, err: rpcErrorText(e) };
  }
}

async function walletOf(rt: ChainRuntime, owner: Address): Promise<WalletHealth> {
  const amount = await tokenAmount(rt.client, await ataOf(owner, rt.mint)).catch(() => undefined);
  if (amount === undefined) return { address: owner, usdc: null, usdc_display: null };
  const v = amount ?? 0n;
  return { address: owner, usdc: v.toString(), usdc_display: formatUsd(v.toString()) };
}

/** The full report (see the header). Never throws for chain trouble: that becomes a warning. */
export async function chainHealth(
  deps: Pick<AppDeps, 'db' | 'env' | 'now' | 'hub' | 'log' | 'keeper' | 'markets'>,
): Promise<ChainHealthReport> {
  const nowMs = deps.now();
  const warnings: HealthWarning[] = [];
  const warn = (code: string, level: HealthLevel, message: string) =>
    warnings.push({ code, level, message });

  // ---- Postgres ----
  const t0 = performance.now();
  const pool = await deps.db
    .select({ status: noncePool.status, n: sql<number>`count(*)::int` })
    .from(noncePool)
    .groupBy(noncePool.status);
  const dbMs = Math.round(performance.now() - t0);
  const [last] = await deps.db
    .select({
      kind: chainTxs.kind,
      status: chainTxs.status,
      signature: chainTxs.signature,
      bet_id: chainTxs.bet_id,
      built_at: chainTxs.built_at,
      rpc_confirmed_at: chainTxs.rpc_confirmed_at,
      err: chainTxs.err,
    })
    .from(chainTxs)
    .orderBy(desc(chainTxs.built_at))
    .limit(1);
  const counts = Object.fromEntries(pool.map((p) => [p.status, p.n])) as Record<string, number>;
  const nonce_pool = {
    size: Object.values(counts).reduce((a, b) => a + b, 0),
    free: counts.free ?? 0,
    leased: counts.leased ?? 0,
    advancing: counts.advancing ?? 0,
    retired: counts.retired ?? 0,
  };
  const staleNonces = await deps.db
    .select({ k: noncePool.seed_index })
    .from(noncePool)
    .where(
      and(
        inArray(noncePool.status, ['leased', 'advancing']),
        lt(
          sql`COALESCE(${noncePool.leased_at}, ${noncePool.value_read_at}, ${noncePool.created_at})`,
          new Date(nowMs - HEALTH.stuckNonceMs).toISOString(),
        ),
      ),
    );

  const sentRows = await deps.db
    .select({
      bet_id: chainTxs.bet_id,
      kind: chainTxs.kind,
      signature: chainTxs.signature,
      sent_at: chainTxs.sent_at,
    })
    .from(chainTxs)
    .where(eq(chainTxs.status, 'sent'))
    .orderBy(asc(chainTxs.sent_at))
    .limit(50);
  const stuckTx = sentRows.filter(
    (r) => !r.sent_at || nowMs - r.sent_at.getTime() > HEALTH.stuckTxMs,
  );

  const due = new Date(nowMs);
  const stuck_bets: StuckBet[] = [];
  const pastResolve = await deps.db
    .select({ id: bets.id, state: bets.state })
    .from(bets)
    .where(and(inArray(bets.state, [...LOCKED_FAMILY]), lte(bets.resolve_deadline, due)))
    .limit(10);
  for (const b of pastResolve)
    stuck_bets.push({ bet_id: b.id, state: b.state, why: 'past resolve_deadline (refund due)' });
  const pastAppeal = await deps.db
    .select({ id: bets.id, state: bets.state })
    .from(bets)
    .where(and(eq(bets.state, 'RULED'), lte(bets.appeal_deadline, new Date(nowMs - 60_000))))
    .limit(10);
  for (const b of pastAppeal)
    stuck_bets.push({ bet_id: b.id, state: b.state, why: 'RULED > 60 s past appeal_deadline' });
  const pastAppealResolve = await deps.db
    .select({ id: bets.id, state: bets.state })
    .from(bets)
    .where(and(inArray(bets.state, [...APPEAL_FAMILY]), lte(bets.appeal_resolve_deadline, due)))
    .limit(10);
  for (const b of pastAppealResolve)
    if (b.state !== 'RULED')
      stuck_bets.push({ bet_id: b.id, state: b.state, why: 'past appeal_resolve_deadline' });
  const pendingPayout = await deps.db
    .select({ id: bets.id, state: bets.state, at: bets.updated_at })
    .from(bets)
    .where(
      and(
        inArray(bets.state, ['CONCEDED', 'FINALIZED', 'AWAITING_LOCK']),
        lt(bets.updated_at, new Date(nowMs - HEALTH.stuckTxMs)),
      ),
    )
    .limit(10);
  for (const b of pendingPayout)
    stuck_bets.push({ bet_id: b.id, state: b.state, why: `in ${b.state} for > 2 min` });

  const [stream] = await deps.db
    .select({
      last: sql<Date | null>`max(${chainEvents.received_at})`,
      hour: sql<number>`count(*) FILTER (WHERE ${chainEvents.received_at} > ${new Date(nowMs - 3_600_000).toISOString()}::timestamptz)::int`,
    })
    .from(chainEvents);

  // ---- chain ----
  const lc = lifecycleOf(deps);
  const rt = await lc.runtime();
  let feePayerSol: number | null = null;
  let rpcMs: number | null = null;
  let rpcError: string | null = null;
  let balances: ChainHealthReport['balances'] = { treasury: null, demo_a: null, demo_b: null };
  if (!rt) {
    warn(
      'chain_not_configured',
      'critical',
      'SOLANA_DEVNET_RPC or FEE_PAYER_SECRET_KEY is not set: no lock or payout can run.',
    );
  } else {
    const t1 = performance.now();
    const treasuryAddr =
      rt.keys.treasury?.address ??
      (deps.env.TREASURY_PUBKEY ? address(deps.env.TREASURY_PUBKEY) : null);
    const [fee, treasury, a, b] = await Promise.all([
      settle(rt.client.lamports(rt.keys.feePayer.address)),
      treasuryAddr ? walletOf(rt, treasuryAddr) : Promise.resolve(null),
      rt.keys.demoA ? walletOf(rt, rt.keys.demoA.address) : Promise.resolve(null),
      rt.keys.demoB ? walletOf(rt, rt.keys.demoB.address) : Promise.resolve(null),
    ]);
    rpcMs = Math.round(performance.now() - t1);
    balances = { treasury, demo_a: a, demo_b: b };
    if (fee.ok) {
      feePayerSol = Number(fee.v) / 1e9;
      if (fee.v < HEALTH.feePayerCriticalLamports)
        warn(
          'fee_payer_low',
          'critical',
          `Fee payer has ${feePayerSol} SOL. Airdrop / transfer devnet SOL now.`,
        );
      else if (fee.v < HEALTH.feePayerWarnLamports)
        warn(
          'fee_payer_low',
          'warn',
          `Fee payer has ${feePayerSol} SOL (< 1). Top it up before the pitch.`,
        );
    } else {
      rpcError = fee.err;
      warn('rpc_unreachable', 'critical', `RPC ${rt.client.label} failed: ${fee.err}`);
    }
    if (rt.feePayerPinned === false && deps.env.LOCK_SIGNER === 'phones')
      warn(
        'fee_payer_not_pinned',
        'critical',
        'The fee payer is not packages/shared FEE_PAYER_PUBKEY: phones refuse every lock.',
      );
    if (!rt.keys.judge)
      warn(
        'judge_key_missing',
        'critical',
        'JUDGE_AUTHORITY_SECRET_KEY is not set: no ruling can go onchain.',
      );
    if (treasury?.usdc != null && BigInt(treasury.usdc) < HEALTH.treasuryWarnMicro)
      warn(
        'treasury_usdc_low',
        'warn',
        `Treasury holds ${treasury.usdc_display}: refill from faucet.circle.com.`,
      );
    for (const [name, w] of [
      ['demo-a', a],
      ['demo-b', b],
    ] as const) {
      if (!w || w.usdc === null) continue;
      const v = BigInt(w.usdc);
      if (v < HEALTH.demoWalletCriticalMicro)
        warn(
          'demo_wallet_low',
          'critical',
          `${name} holds ${w.usdc_display}: it cannot stake $1. POST /v1/demo/rebalance or npm run fund.`,
        );
      else if (v < HEALTH.demoWalletWarnMicro)
        warn(
          'demo_wallet_low',
          'warn',
          `${name} holds ${w.usdc_display}. POST /v1/demo/rebalance or npm run fund.`,
        );
    }
    if (a?.usdc && b?.usdc) {
      const [x, y] = [BigInt(a.usdc), BigInt(b.usdc)];
      const hi = x > y ? x : y;
      const lo = x > y ? y : x;
      if (hi > 0n && lo * 2n < hi)
        warn(
          'demo_wallets_unbalanced',
          'warn',
          `demo-a ${a.usdc_display} vs demo-b ${b.usdc_display}: POST /v1/demo/rebalance.`,
        );
    }
  }

  if (nonce_pool.size === 0)
    warn(
      'nonce_pool_empty',
      'critical',
      'No nonce accounts: run npm run nonce-pool, then POST /v1/demo/reset.',
    );
  else if (nonce_pool.free < HEALTH.minFreeNonces)
    warn(
      'nonce_pool_low',
      nonce_pool.free === 0 ? 'critical' : 'warn',
      `${nonce_pool.free} free nonce(s) of ${nonce_pool.size}: POST /v1/demo/reset frees leased ones.`,
    );
  if (staleNonces.length)
    warn('nonces_stuck', 'warn', `${staleNonces.length} nonce(s) leased / advancing for > 15 min.`);

  const rpcStats = rt?.client.rpcStats?.() ?? null;
  if (rpcStats && rpcStats.calls >= 10) {
    if ((rpcStats.p95_ms ?? 0) > HEALTH.rpcP95WarnMs)
      warn(
        'rpc_slow',
        'warn',
        `RPC p95 ${rpcStats.p95_ms} ms over the last ${rpcStats.calls} calls.`,
      );
    if (rpcStats.errors / rpcStats.calls > HEALTH.rpcErrorRateWarn)
      warn(
        'rpc_errors',
        'warn',
        `${rpcStats.errors} of the last ${rpcStats.calls} RPC calls failed (last: ${rpcStats.last_error?.error}).`,
      );
  }

  const keeper = deps.keeper?.status() ?? null;
  if (!keeper)
    warn('keeper_off', 'warn', 'No keeper in this process: no sweep, refund or finalize backstop.');
  else {
    if (!keeper.started) warn('keeper_off', 'warn', 'The keeper is not running.');
    const stuckTasks = keeper.tasks.filter((t) => t.running_stuck).map((t) => t.name);
    if (stuckTasks.length)
      warn('keeper_task_stuck', 'critical', `Keeper task(s) stuck: ${stuckTasks.join(', ')}.`);
    const recent = keeper.recent_errors.filter(
      (e) => nowMs - Date.parse(e.at) < HEALTH.keeperErrorWindowMs,
    );
    if (recent.length)
      warn(
        'keeper_errors',
        'warn',
        `${recent.length} keeper error(s) in 10 min (last: ${recent[0]!.task}: ${recent[0]!.error}).`,
      );
  }
  if (stuckTx.length)
    warn(
      'txs_stuck',
      'warn',
      `${stuckTx.length} tx(s) 'sent' for > 2 min (the reconcilers retry; check the RPC).`,
    );
  if (stuck_bets.length)
    warn(
      'bets_stuck',
      'warn',
      `${stuck_bets.length} bet(s) past a deadline or pending for > 2 min.`,
    );
  const escrow = lc.refund.lastOrphanScan;
  if (escrow?.orphans.length)
    warn(
      'orphan_escrow',
      'warn',
      `${escrow.orphans.length} escrow bet(s) with no live row; the orphan sweep returns them when due.`,
    );

  return {
    ok: !warnings.some((w) => w.level === 'critical'),
    warnings,
    server_time: iso(nowMs)!,
    chain_configured: !!rt,
    lock_signer: deps.env.LOCK_SIGNER,
    rpc: rt?.client.label ?? null,
    fee_payer: rt?.keys.feePayer.address ?? null,
    fee_payer_pinned: rt?.feePayerPinned ?? null,
    fee_payer_sol: feePayerSol,
    judge: rt?.keys.judge?.address ?? null,
    custodial: { a: rt?.keys.demoA?.address ?? null, b: rt?.keys.demoB?.address ?? null },
    nonce_pool,
    last_tx: last ?? null,
    rpc_ms: rpcMs,
    rpc_error: rpcError,
    db_ms: dbMs,
    balances,
    rpc_stats: rpcStats,
    keeper,
    inflight: {
      sent_txs: sentRows.length,
      oldest_sent_at: iso(sentRows[0]?.sent_at),
      stuck: stuckTx.slice(0, 10).map((r) => ({
        bet_id: r.bet_id,
        kind: r.kind,
        signature: r.signature,
        sent_at: iso(r.sent_at),
      })),
    },
    stuck_bets,
    escrow,
    stream: {
      last_delivery_at: iso(stream?.last ? new Date(stream.last) : null),
      events_last_hour: stream?.hour ?? 0,
    },
    markets: deps.markets
      ? { last_ok_at: iso(deps.markets.lastOkAt), last_error: deps.markets.lastError }
      : null,
  };
}

/** One line for the logs: every warning code with its level. */
export function healthLine(r: ChainHealthReport): Record<string, unknown> {
  return {
    ok: r.ok,
    warnings: r.warnings.map((w) => `${w.level}:${w.code}`),
    fee_payer_sol: r.fee_payer_sol,
    nonces_free: r.nonce_pool.free,
    rpc_p95_ms: r.rpc_stats?.p95_ms ?? null,
    demo_a: r.balances.demo_a?.usdc_display ?? null,
    demo_b: r.balances.demo_b?.usdc_display ?? null,
  };
}

/** Every 10 min: log only when something is wrong (the boot line is always logged). */
export const HEALTH_LOG_MS = 10 * 60_000;

export async function logChainHealth(
  deps: Parameters<typeof chainHealth>[0],
  o: { always?: boolean } = {},
): Promise<ChainHealthReport> {
  const r = await chainHealth(deps);
  if (r.warnings.length) deps.log.warn('chain.unhealthy', healthLine(r));
  else if (o.always) deps.log.info('chain.healthy', healthLine(r));
  return r;
}
