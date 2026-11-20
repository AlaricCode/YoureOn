// Chain health for the pitch (GET /v1/demo/health, the keeper's 'chain-health' log line, the boot
// line, scripts/demo-check.ts): balances, the nonce pool, RPC latency and errors, the keeper,
// transactions and bets that are stuck, orphan escrow, the Stream and the Gemini relay, the demo
// toggles and the judge (LLM) health (judge/stats.ts: last success / failure, p50 / p95, in
// memory since boot), plus a list of warnings with one fix hint each. `ok` is false when any
// warning is critical.
//
// Read-only. RPC reads run in parallel and each is time-boxed by the transport (src/chain/tx.ts),
// so the report answers within a few seconds even when the RPC is in trouble (that is a warning).
//
// Spec: docs/planning/API-CONTRACT.md §2.17.
import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { address, type Address } from '@solana/kit';
import { bets, chainEvents, chainTxs, noncePool } from '@youre-on/db';
import type { BetState } from '@youre-on/shared/bet-state';
import { findConfigPda, getConfigDecoder, type Config } from '@youre-on/shared/escrow-client';
import { PANEL_SEATS } from '@youre-on/shared/appeal';
import { formatUsd } from '@youre-on/shared/money';
import type { AppDeps } from '../context';
import type { Env } from '../env';
import type { Logger } from '../log';
import type { KeeperStatus } from '../keeper/keeper';
import { lifecycleOf } from '../lock/runtime';
import { APPEAL_FAMILY, LOCKED_FAMILY, type OrphanSummary } from '../payout/refund';
import { togglesOf, type DemoTogglesView } from '../demo/toggles';
import { judgeHealth, type JudgeHealth } from '../judge/stats';
import { checksHealth, type ChecksHealth } from '../judge/camera-checks';
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
  /** stream_silent: no Stream delivery for this long while server txs were sent in it. */
  streamSilentMs: 10 * 60_000,
  /** A send newer than this may simply not be delivered yet (the Stream lands in ~1-5 s). */
  streamGraceMs: 60_000,
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
  /** APPEAL_AUTHORITY_SECRET_KEY's address (null: unset; appeals are then never paid out). */
  appeal_key: string | null;
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
  /** The escrow Config account (null: chain off or unreadable). */
  config: {
    address: string;
    paused: boolean;
    judge_authority: string;
    appeal_authority: string;
    appeal_window_secs: number;
    resolve_deadline_secs: number;
    max_stake: string;
    mint_allowed: boolean;
  } | null;
  rpc_stats: RpcStatsSnapshot | null;
  keeper: KeeperStatus | null;
  inflight: { sent_txs: number; oldest_sent_at: string | null; stuck: StuckTx[] };
  stuck_bets: StuckBet[];
  escrow: OrphanSummary | null;
  /**
   * The Stream's own deliveries only (source = 'stream'): rpc_poll copies never make it look
   * alive. last_delivery_at = the newest Stream-source row or chain_txs.stream_seen_at (a Stream
   * copy of a tx rpc_poll stored first); null = the Stream never delivered. events_last_hour
   * counts Stream-source rows; rpc_poll_last_hour (additive) the rpc_poll ones.
   */
  stream: { last_delivery_at: string | null; events_last_hour: number; rpc_poll_last_hour: number };
  markets: { last_ok_at: string | null; last_error: string | null } | null;
  /** The demo runtime toggles (demo/toggles.ts; POST /v1/demo/toggles). */
  toggles: DemoTogglesView;
  /** The judge's vision calls since boot (judge/stats.ts; the warm-up counts). */
  judge_llm: JudgeHealth;
  /** = judge_llm.last_ok_at, under the field name the API contract gives it. */
  llm_last_ok: string | null;
  /** Camera checks (judge/camera-checks.ts): kill switch, SAM config, last SAM ok / fail + ms. */
  checks: ChecksHealth;
  /** Which build answers (Fly sets these at runtime; null locally). */
  build: { image: string | null; machine: string | null; region: string | null };
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

/** The Stream row of the health query (chainHealth); timestamps come back as Date or string. */
export interface StreamCounts extends Record<string, unknown> {
  stream_last: Date | string | null;
  seen_last: Date | string | null;
  stream_hour: number | string | null;
  rpc_poll_hour: number | string | null;
  /**
   * Server escrow txs (signature set, sent / confirmed, not nonce_advance: a System-program tx the
   * Stream filter never delivers) sent in (now - 10 min, now - 60 s].
   */
  sent_window: number | string | null;
}

const msOf = (d: Date | string | null | undefined): number | null =>
  d === null || d === undefined ? null : new Date(d).getTime();

/**
 * The report's `stream` block and the stream_silent warning, no DB. stream_silent (warn): a
 * Stream is expected (QN_STREAM_SECURITY_TOKEN set) but none delivered for > 10 min although
 * server txs were sent in that window (an idle server never warns): events then arrive only
 * through rpc_poll, 30 s late (reconciler.ts rpcPollFallbackMs). Known false positive: a send that
 * never landed (dropped, blockhash expired) still counts while 'sent'; it shows in inflight.stuck.
 */
export function streamHealth(
  row: StreamCounts | undefined,
  o: { nowMs: number; streamExpected: boolean },
): { stream: ChainHealthReport['stream']; warning: HealthWarning | null } {
  const at = [msOf(row?.stream_last), msOf(row?.seen_last)].filter((x): x is number => x !== null);
  const last = at.length ? Math.max(...at) : null;
  const sent = Number(row?.sent_window ?? 0);
  const silent =
    o.streamExpected && sent > 0 && (last === null || o.nowMs - last > HEALTH.streamSilentMs);
  return {
    stream: {
      last_delivery_at: iso(last),
      events_last_hour: Number(row?.stream_hour ?? 0),
      rpc_poll_last_hour: Number(row?.rpc_poll_hour ?? 0),
    },
    warning: silent
      ? {
          code: 'stream_silent',
          level: 'warn',
          message: `QN_STREAM_SECURITY_TOKEN is set but no Stream delivery ${
            last === null ? 'ever' : `since ${iso(last)}`
          } while ${sent} escrow tx(s) were sent in the last 10 min: chain events arrive only by rpc_poll (30 s late). A dropped send can also cause this: check inflight.stuck. npm run qn-stream -- list (paused: reset-start <id>, then resume <id>).`,
        }
      : null,
  };
}

/** The escrow Config account, or null when it does not exist. */
async function readConfig(rt: ChainRuntime): Promise<(Config & { address: Address }) | null> {
  const [pda] = await findConfigPda({ programAddress: rt.programId });
  const acc = await rt.client.getAccount(pda);
  if (!acc || acc.owner !== rt.programId) return null;
  return { ...getConfigDecoder().decode(acc.data), address: pda };
}

async function walletOf(rt: ChainRuntime, owner: Address): Promise<WalletHealth> {
  const amount = await tokenAmount(rt.client, await ataOf(owner, rt.mint)).catch(() => undefined);
  if (amount === undefined) return { address: owner, usdc: null, usdc_display: null };
  const v = amount ?? 0n;
  return { address: owner, usdc: v.toString(), usdc_display: formatUsd(v.toString()) };
}

/** The full report (see the header). Never throws for chain trouble: that becomes a warning. */
export async function chainHealth(
  deps: Pick<AppDeps, 'db' | 'env' | 'now' | 'hub' | 'log' | 'keeper' | 'markets'> &
    Partial<Pick<AppDeps, 'providers' | 'sam'>>,
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

  // One round trip, each subquery on an indexed column (chain_events_recent; chain_txs is small).
  const [streamRow] = await deps.db.execute<StreamCounts>(sql`
    SELECT
      (SELECT max(${chainEvents.received_at}) FROM ${chainEvents}
        WHERE ${chainEvents.source} = 'stream') AS stream_last,
      (SELECT max(${chainTxs.stream_seen_at}) FROM ${chainTxs}) AS seen_last,
      (SELECT count(*)::int FROM ${chainEvents}
        WHERE ${chainEvents.received_at} > ${iso(nowMs - 3_600_000)}::timestamptz
          AND ${chainEvents.source} = 'stream') AS stream_hour,
      (SELECT count(*)::int FROM ${chainEvents}
        WHERE ${chainEvents.received_at} > ${iso(nowMs - 3_600_000)}::timestamptz
          AND ${chainEvents.source} = 'rpc_poll') AS rpc_poll_hour,
      (SELECT count(*)::int FROM ${chainTxs}
        WHERE ${chainTxs.signature} IS NOT NULL
          AND ${chainTxs.status} IN ('sent', 'confirmed')
          AND ${chainTxs.kind} <> 'nonce_advance'
          AND ${chainTxs.sent_at} > ${iso(nowMs - HEALTH.streamSilentMs)}::timestamptz
          AND ${chainTxs.sent_at} <= ${iso(nowMs - HEALTH.streamGraceMs)}::timestamptz) AS sent_window
  `);
  const streamReport = streamHealth(streamRow, {
    nowMs,
    streamExpected: !!deps.env.QN_STREAM_SECURITY_TOKEN,
  });
  if (streamReport.warning) warnings.push(streamReport.warning);

  // ---- chain ----
  const lc = lifecycleOf(deps);
  const rt = await lc.runtime();
  let feePayerSol: number | null = null;
  let rpcMs: number | null = null;
  let rpcError: string | null = null;
  let balances: ChainHealthReport['balances'] = { treasury: null, demo_a: null, demo_b: null };
  let config: ChainHealthReport['config'] = null;
  if (!rt) {
    warn(
      'chain_not_configured',
      'critical',
      'SOLANA_DEVNET_RPC or FEE_PAYER_SECRET_KEY is not set: no lock or payout can run.',
    );
  } else {
    const treasuryAddr =
      rt.keys.treasury?.address ??
      (deps.env.TREASURY_PUBKEY ? address(deps.env.TREASURY_PUBKEY) : null);
    const [fee, treasury, a, b, cfg] = await Promise.all([
      (async () => {
        // rpc_ms: the fee payer balance probe alone (one getBalance round trip).
        const t1 = performance.now();
        const r = await settle(rt.client.lamports(rt.keys.feePayer.address));
        rpcMs = Math.round(performance.now() - t1);
        return r;
      })(),
      treasuryAddr ? walletOf(rt, treasuryAddr) : Promise.resolve(null),
      rt.keys.demoA ? walletOf(rt, rt.keys.demoA.address) : Promise.resolve(null),
      rt.keys.demoB ? walletOf(rt, rt.keys.demoB.address) : Promise.resolve(null),
      settle(readConfig(rt)),
    ]);
    balances = { treasury, demo_a: a, demo_b: b };
    // The escrow Config: each of these makes every lock (or every ruling) fail onchain.
    if (cfg.ok && cfg.v) {
      const c = cfg.v;
      config = {
        address: c.address,
        paused: c.paused,
        judge_authority: c.judgeAuthority,
        appeal_authority: c.appealAuthority,
        appeal_window_secs: c.appealWindowSecs,
        resolve_deadline_secs: c.resolveDeadlineSecs,
        max_stake: c.maxStake.toString(),
        mint_allowed: c.allowedMints.includes(rt.mint),
      };
      if (c.paused)
        warn('escrow_paused', 'critical', 'The escrow Config is paused: every lock is refused.');
      if (!config.mint_allowed)
        warn(
          'mint_not_allowed',
          'critical',
          `USDC mint ${rt.mint} is not in Config.allowed_mints.`,
        );
      if (rt.keys.judge && rt.keys.judge.address !== c.judgeAuthority)
        warn(
          'judge_key_mismatch',
          'critical',
          `JUDGE_AUTHORITY_SECRET_KEY is ${rt.keys.judge.address}, Config.judge_authority is ${c.judgeAuthority}: every resolve fails (NotJudge).`,
        );
      // Appeals only: an appeal without the key is decided but never paid by resolve_appeal;
      // timeout_refund returns both stakes after appeal_resolve_secs (300 s).
      if (!rt.keys.appeal)
        warn(
          'appeal_key_missing',
          'warn',
          'APPEAL_AUTHORITY_SECRET_KEY is not set: an appealed bet is refunded after 300 s instead of paid.',
        );
      else if (rt.keys.appeal.address !== c.appealAuthority)
        warn(
          'appeal_key_mismatch',
          'warn',
          `APPEAL_AUTHORITY_SECRET_KEY is ${rt.keys.appeal.address}, Config.appeal_authority is ${c.appealAuthority}: every resolve_appeal fails (NotAppealAuthority).`,
        );
    } else if (cfg.ok) {
      warn('config_missing', 'critical', 'No escrow Config account: run npm run init-config.');
    } else {
      warn('config_unreadable', 'warn', `Could not read the escrow Config: ${cfg.err}`);
    }
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
  // ---- the judge (LLM) and the toggles ----
  const toggles = togglesOf(deps).view(deps.env);
  const judgeLlm = judgeHealth(deps);
  const warmupHint = 'POST /v1/demo/warmup (npm run demo-check -- --warmup)';
  if (!judgeLlm.last_ok_at)
    warn(
      'judge_no_success',
      'warn',
      `No judge (LLM) success since boot${
        judgeLlm.last_error ? ` (last failure: ${judgeLlm.last_error})` : ''
      }: ${warmupHint}.`,
    );
  else if (judgeLlm.last_error_at && judgeLlm.last_error_at > judgeLlm.last_ok_at)
    warn(
      'judge_failing',
      'warn',
      `The judge's last call failed (${judgeLlm.last_error}, ${judgeLlm.last_error_source}): ${warmupHint}, or POST /v1/demo/toggles {"cached_ruling": true}.`,
    );
  const checks = checksHealth(deps);
  if (
    checks.active &&
    checks.last_error_at &&
    (!checks.last_ok_at || checks.last_error_at > checks.last_ok_at)
  )
    warn(
      'checks_sam_failing',
      'warn',
      `The camera checks' last SAM call failed (${checks.last_error}): rulings stand on the judge alone (no veto). POST /v1/demo/toggles {"checks": false} to stop calling it.`,
    );
  const panel = appealPanelKeysWarning(deps.env);
  if (panel) warnings.push(panel);
  if (toggles.cached_ruling)
    warn(
      'cached_ruling_on',
      'warn',
      `cached_ruling is on (${toggles.cached_ruling_source}): every ruling is the stored verdict (model cache/demo-bottle@1). POST /v1/demo/toggles {"cached_ruling": false} for the live judge.`,
    );

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
  if (escrow?.errors.length)
    warn(
      'orphan_scan_errors',
      'warn',
      `Orphan escrow sweep: ${escrow.errors[0]} (getProgramAccounts on this RPC?).`,
    );
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
    appeal_key: rt?.keys.appeal?.address ?? null,
    custodial: { a: rt?.keys.demoA?.address ?? null, b: rt?.keys.demoB?.address ?? null },
    nonce_pool,
    last_tx: last ?? null,
    rpc_ms: rpcMs,
    rpc_error: rpcError,
    db_ms: dbMs,
    balances,
    config,
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
    stream: streamReport.stream,
    markets: deps.markets
      ? { last_ok_at: iso(deps.markets.lastOkAt), last_error: deps.markets.lastError }
      : null,
    toggles,
    judge_llm: judgeLlm,
    llm_last_ok: judgeLlm.last_ok_at,
    checks,
    build: {
      image: process.env['FLY_IMAGE_REF'] ?? null,
      machine: process.env['FLY_MACHINE_ID'] ?? null,
      region: process.env['FLY_REGION'] ?? null,
    },
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

/** Each appeal panel seat's key (providers/live/llm KEY_NAMES): a seat without one abstains. */
export const PANEL_KEY_NAMES = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
} as const satisfies Record<(typeof PANEL_SEATS)[number], keyof Env>;

/**
 * The appeal panel: with the live LLM, a seat whose vendor has no key abstains on every appeal. Two
 * agreeing votes decide, so with two seats keyless no appeal can ever flip a ruling ("upheld, no
 * majority" every time). Warn-level (the first ruling does not need the panel). The mock LLM
 * answers every seat, so it is not flagged.
 */
export function appealPanelKeysWarning(
  env: Pick<Env, 'LLM_PROVIDER' | (typeof PANEL_KEY_NAMES)[keyof typeof PANEL_KEY_NAMES]>,
): HealthWarning | null {
  if (env.LLM_PROVIDER !== 'live') return null;
  const missing = PANEL_SEATS.filter((v) => !env[PANEL_KEY_NAMES[v]]?.trim());
  if (!missing.length) return null;
  const names = missing.map((v) => PANEL_KEY_NAMES[v]);
  const left = PANEL_SEATS.length - missing.length;
  return {
    code: 'appeal_panel_keys_missing',
    level: 'warn',
    message: `${names.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set: ${missing.length} of ${PANEL_SEATS.length} appeal panel seats abstain on every appeal, so ${
      left >= 2
        ? `a flip needs both remaining seats to agree`
        : 'no appeal can reach the 2 votes a flip needs (every appeal upholds the ruling)'
    }. fly secrets set ${names.map((n) => `${n}=...`).join(' ')} -a youre-on.`,
  };
}

/** Every 10 min: log only when something is wrong (the boot line is always logged). */
export const HEALTH_LOG_MS = 10 * 60_000;

/**
 * The judge (LLM) and toggle codes. They stay in the report (GET /v1/demo/health `warnings`,
 * demo-check) and in every log line's warning list, but alone they never make a log line a WARN:
 * judge_no_success shows on every boot until the first judge call and cached_ruling_on the whole
 * time the fallback is on, while `chain.unhealthy` means a chain or money-path problem.
 */
export const JUDGE_WARNING_CODES: ReadonlySet<string> = new Set([
  'judge_no_success',
  'judge_failing',
  'cached_ruling_on',
  'checks_sam_failing',
  'appeal_panel_keys_missing',
]);

/** Does the chain / money path need a human? Any warning but a warn-level judge one. */
export function chainNeedsAttention(r: Pick<ChainHealthReport, 'warnings'>): boolean {
  return r.warnings.some((w) => w.level === 'critical' || !JUDGE_WARNING_CODES.has(w.code));
}

/**
 * Logs one report: the boot line (`chain.boot_health`, always; WARN only when the chain needs
 * attention), else the periodic one (`chain.unhealthy` when it does; `chain.healthy` only with
 * `always`). Every line lists every warning code, the judge's included.
 */
export function logHealthReport(
  log: Logger,
  r: ChainHealthReport,
  o: { boot?: boolean; always?: boolean } = {},
): void {
  const bad = chainNeedsAttention(r);
  if (o.boot) log[bad ? 'warn' : 'info']('chain.boot_health', healthLine(r));
  else if (bad) log.warn('chain.unhealthy', healthLine(r));
  else if (o.always) log.info('chain.healthy', healthLine(r));
}

export async function logChainHealth(
  deps: Parameters<typeof chainHealth>[0],
  o: { always?: boolean } = {},
): Promise<ChainHealthReport> {
  const r = await chainHealth(deps);
  logHealthReport(deps.log, r, o);
  return r;
}
