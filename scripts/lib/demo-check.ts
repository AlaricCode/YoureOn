// Pure GO / NO-GO evaluation for scripts/demo-check.ts (pitch-morning check). The script does the
// I/O (server, RPC, QuickNode) and feeds the answers here, so the rules are unit-tested
// (apps/server/test/demo-check.test.ts) without a network.

export type Verdict = 'GO' | 'WARN' | 'NO-GO' | 'SKIP';

export interface Check {
  /** Short id, e.g. "server.health". */
  id: string;
  verdict: Verdict;
  detail: string;
  /** What to do about it (NO-GO / WARN only). */
  fix?: string;
}

export const THRESHOLDS = {
  /** /health round trip. */
  healthGoMs: 1_500,
  healthWarnMs: 4_000,
  /** |server clock - this clock|: request signing allows 60 s, the app corrects the offset. */
  skewWarnMs: 10_000,
  skewNoGoMs: 45_000,
  feePayerGoSol: 1,
  feePayerWarnSol: 0.1,
  noncesGo: 2,
  demoWalletGoMicro: 5_000_000n,
  demoWalletWarnMicro: 1_000_000n,
  rpcP95GoMs: 1_500,
  rpcP95WarnMs: 4_000,
  /** The Gemini relay's last good poll (beat 6). */
  marketsFreshMs: 120_000,
} as const;

const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;

/** GET /health: reachable, ok, fast, clock in sync. */
export function evaluateBasicHealth(
  r: { status: number; ms: number; body: unknown } | { error: string },
  localNowMs: number,
): Check[] {
  if ('error' in r)
    return [
      {
        id: 'server.health',
        verdict: 'NO-GO',
        detail: `unreachable: ${r.error}`,
        fix: 'fly status -a youre-on; fly logs -a youre-on',
      },
    ];
  const body = r.body as { ok?: boolean; server_time?: string } | null;
  const out: Check[] = [];
  if (r.status !== 200 || body?.ok !== true)
    out.push({
      id: 'server.health',
      verdict: 'NO-GO',
      detail: `HTTP ${r.status}`,
      fix: 'fly logs -a youre-on',
    });
  else
    out.push({
      id: 'server.health',
      verdict:
        r.ms <= THRESHOLDS.healthGoMs ? 'GO' : r.ms <= THRESHOLDS.healthWarnMs ? 'WARN' : 'NO-GO',
      detail: `ok in ${r.ms} ms`,
      ...(r.ms > THRESHOLDS.healthGoMs
        ? { fix: 'slow venue network or a cold machine: fly machine list -a youre-on' }
        : {}),
    });
  const t = body?.server_time ? Date.parse(body.server_time) : NaN;
  if (Number.isFinite(t)) {
    // The response took r.ms: the server stamped it somewhere in that window.
    const skew = Math.max(0, Math.abs(t - (localNowMs - r.ms / 2)) - r.ms / 2);
    out.push({
      id: 'server.clock',
      verdict:
        skew <= THRESHOLDS.skewWarnMs ? 'GO' : skew <= THRESHOLDS.skewNoGoMs ? 'WARN' : 'NO-GO',
      detail: `skew ${Math.round(skew)} ms`,
      ...(skew > THRESHOLDS.skewWarnMs
        ? { fix: 'check this laptop / the phones: Set Automatically' }
        : {}),
    });
  }
  return out;
}

/** The subset of GET /v1/demo/health this check reads (see apps/server/src/chain/health.ts). */
export interface DemoHealth {
  ok?: boolean;
  warnings?: Array<{ code: string; level: 'warn' | 'critical'; message: string }>;
  chain_configured?: boolean;
  lock_signer?: string;
  rpc?: string | null;
  fee_payer?: string | null;
  fee_payer_pinned?: boolean | null;
  fee_payer_sol?: number | null;
  judge?: string | null;
  custodial?: { a: string | null; b: string | null };
  nonce_pool?: { size: number; free: number; leased: number; advancing: number; retired: number };
  balances?: {
    treasury: { address: string; usdc: string | null } | null;
    demo_a: { address: string; usdc: string | null } | null;
    demo_b: { address: string; usdc: string | null } | null;
  };
  rpc_stats?: {
    calls: number;
    p50_ms: number | null;
    p95_ms: number | null;
    errors: number;
  } | null;
  keeper?: { started: boolean; tasks: Array<{ name: string; running_stuck: boolean }> } | null;
  escrow?: { live: number | null; orphans: unknown[] } | null;
  stream?: { last_delivery_at: string | null; events_last_hour: number };
  markets?: { last_ok_at: string | null; last_error: string | null } | null;
  build?: { image: string | null; machine: string | null; region: string | null };
  config?: {
    address: string;
    paused: boolean;
    judge_authority: string;
    appeal_window_secs: number;
    mint_allowed: boolean;
  } | null;
}

/** GET /v1/demo/health -> one check per money-path item, plus the server's own warnings. */
export function evaluateDemoHealth(
  r: { status: number; body: unknown } | { error: string } | null,
  localNowMs: number,
): Check[] {
  if (r === null)
    return [
      {
        id: 'demo.health',
        verdict: 'SKIP',
        detail: 'no admin key (pass --demo-key or set DEMO_ADMIN_TOKEN)',
      },
    ];
  if ('error' in r)
    return [{ id: 'demo.health', verdict: 'NO-GO', detail: `unreachable: ${r.error}` }];
  if (r.status === 404)
    return [
      {
        id: 'demo.health',
        verdict: 'NO-GO',
        detail: 'HTTP 404: DEMO_MODE off or a wrong admin key',
        fix: 'fly secrets list -a youre-on (DEMO_MODE=true, DEMO_ADMIN_TOKEN)',
      },
    ];
  if (r.status !== 200)
    return [{ id: 'demo.health', verdict: 'NO-GO', detail: `HTTP ${r.status}` }];
  const h = r.body as DemoHealth;
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  add(
    h.chain_configured
      ? {
          id: 'chain.configured',
          verdict: 'GO',
          detail: `rpc ${h.rpc}, lock signer ${h.lock_signer}`,
        }
      : {
          id: 'chain.configured',
          verdict: 'NO-GO',
          detail: 'SOLANA_DEVNET_RPC / FEE_PAYER_SECRET_KEY missing',
          fix: 'fly secrets set SOLANA_DEVNET_RPC=... FEE_PAYER_SECRET_KEY=...',
        },
  );
  if (h.build?.image)
    add({
      id: 'server.build',
      verdict: 'GO',
      detail: `${h.build.image} on ${h.build.machine ?? '?'} (${h.build.region ?? '?'})`,
    });
  if (!h.chain_configured) return out;

  if (h.lock_signer === 'phones' && h.fee_payer_pinned === false)
    add({
      id: 'chain.fee_payer_pinned',
      verdict: 'NO-GO',
      detail: `fee payer ${h.fee_payer} is not the pinned FEE_PAYER_PUBKEY: phones refuse every lock`,
    });

  // Paused / wrong judge / mint not allowed come through as critical server warnings below.
  if (h.config)
    add({
      id: 'chain.config',
      verdict:
        h.config.paused ||
        !h.config.mint_allowed ||
        (h.judge && h.judge !== h.config.judge_authority)
          ? 'NO-GO'
          : 'GO',
      detail: `${h.config.paused ? 'PAUSED' : 'live'}, appeal window ${h.config.appeal_window_secs} s, judge ${
        !h.judge ? 'key missing' : h.judge === h.config.judge_authority ? 'matches' : 'MISMATCH'
      }, mint ${h.config.mint_allowed ? 'allowed' : 'NOT allowed'}`,
    });
  else if (h.config === null)
    add({ id: 'chain.config', verdict: 'WARN', detail: 'Config unreadable from the server' });

  const sol = h.fee_payer_sol;
  add(
    sol === null || sol === undefined
      ? {
          id: 'chain.fee_payer_sol',
          verdict: 'NO-GO',
          detail: 'could not read the fee payer balance',
        }
      : {
          id: 'chain.fee_payer_sol',
          verdict:
            sol >= THRESHOLDS.feePayerGoSol
              ? 'GO'
              : sol >= THRESHOLDS.feePayerWarnSol
                ? 'WARN'
                : 'NO-GO',
          detail: `${sol} SOL (${h.fee_payer})`,
          ...(sol < THRESHOLDS.feePayerGoSol
            ? { fix: `solana airdrop 2 ${h.fee_payer} --url devnet (or faucet.solana.com)` }
            : {}),
        },
  );

  const pool = h.nonce_pool;
  if (pool)
    add({
      id: 'chain.nonce_pool',
      verdict: pool.free >= THRESHOLDS.noncesGo ? 'GO' : pool.free === 1 ? 'WARN' : 'NO-GO',
      detail: `${pool.free} free / ${pool.size} (leased ${pool.leased}, advancing ${pool.advancing}, retired ${pool.retired})`,
      ...(pool.free < THRESHOLDS.noncesGo
        ? {
            fix:
              pool.size === 0
                ? 'npm run nonce-pool -- --url <rpc>, then POST /v1/demo/reset'
                : 'POST /v1/demo/reset (revokes leased nonces, re-syncs the pool)',
          }
        : {}),
    });

  for (const [id, w] of [
    ['wallet.demo_a', h.balances?.demo_a],
    ['wallet.demo_b', h.balances?.demo_b],
  ] as const) {
    if (!w) {
      add({
        id,
        verdict: h.lock_signer === 'server' ? 'NO-GO' : 'SKIP',
        detail: 'no custodial key on the server',
      });
      continue;
    }
    if (w.usdc === null) {
      add({ id, verdict: 'WARN', detail: `could not read ${w.address}` });
      continue;
    }
    const v = BigInt(w.usdc);
    add({
      id,
      verdict:
        v >= THRESHOLDS.demoWalletGoMicro
          ? 'GO'
          : v >= THRESHOLDS.demoWalletWarnMicro
            ? 'WARN'
            : 'NO-GO',
      detail: `${usd(v)} USDC (${w.address})`,
      ...(v < THRESHOLDS.demoWalletGoMicro
        ? { fix: 'POST /v1/demo/rebalance, or npm run fund -- --url <rpc> --target 40' }
        : {}),
    });
  }
  const t = h.balances?.treasury;
  if (t?.usdc != null)
    add({
      id: 'wallet.treasury',
      verdict: BigInt(t.usdc) >= 20_000_000n ? 'GO' : 'WARN',
      detail: `${usd(BigInt(t.usdc))} USDC (${t.address})`,
      ...(BigInt(t.usdc) < 20_000_000n
        ? { fix: 'faucet.circle.com (Solana Devnet) -> treasury' }
        : {}),
    });

  const s = h.rpc_stats;
  if (s && s.calls > 0 && s.p95_ms !== null)
    add({
      id: 'chain.rpc_latency',
      verdict:
        s.p95_ms <= THRESHOLDS.rpcP95GoMs
          ? 'GO'
          : s.p95_ms <= THRESHOLDS.rpcP95WarnMs
            ? 'WARN'
            : 'NO-GO',
      detail: `p50 ${s.p50_ms} ms, p95 ${s.p95_ms} ms, ${s.errors} error(s) in ${s.calls} calls`,
      ...(s.p95_ms > THRESHOLDS.rpcP95GoMs
        ? {
            fix: 'public devnet RPC is slow / rate-limited: set SOLANA_DEVNET_RPC to the QuickNode URL',
          }
        : {}),
    });

  const k = h.keeper;
  if (k) {
    const stuck = k.tasks.filter((x) => x.running_stuck).map((x) => x.name);
    add({
      id: 'server.keeper',
      verdict: !k.started || stuck.length ? 'NO-GO' : 'GO',
      detail: !k.started
        ? 'not running'
        : stuck.length
          ? `stuck: ${stuck.join(', ')}`
          : `${k.tasks.length} tasks running`,
      ...(!k.started || stuck.length ? { fix: 'fly machine restart -a youre-on' } : {}),
    });
  } else add({ id: 'server.keeper', verdict: 'WARN', detail: 'no keeper in this process' });

  const orphans = h.escrow?.orphans.length ?? 0;
  add({
    id: 'chain.escrow',
    verdict: orphans ? 'WARN' : 'GO',
    detail:
      h.escrow?.live === null || h.escrow === null || h.escrow === undefined
        ? 'not scanned yet'
        : `${h.escrow.live} live bet(s), ${orphans} orphan(s)`,
    ...(orphans
      ? { fix: 'the orphan sweep returns them when due (see /v1/demo/health escrow)' }
      : {}),
  });

  if (h.markets) {
    const okAt = h.markets.last_ok_at ? Date.parse(h.markets.last_ok_at) : NaN;
    const fresh = Number.isFinite(okAt) && localNowMs - okAt <= THRESHOLDS.marketsFreshMs;
    add({
      id: 'server.gemini_relay',
      verdict: fresh ? 'GO' : 'WARN',
      detail: fresh
        ? `last poll ${Math.round((localNowMs - okAt) / 1000)} s ago`
        : `stale (last ok ${h.markets.last_ok_at ?? 'never'}, error ${h.markets.last_error ?? '-'})`,
      ...(fresh ? {} : { fix: 'beat 6 falls back to the recorded market (stage fallback)' }),
    });
  }

  // The server's own warnings not already covered above.
  const covered = new Set([
    'fee_payer_low',
    'nonce_pool_low',
    'nonce_pool_empty',
    'demo_wallet_low',
    'treasury_usdc_low',
    'rpc_slow',
    'keeper_off',
    'keeper_task_stuck',
    'orphan_escrow',
    'chain_not_configured',
    'fee_payer_not_pinned',
    // shown as chain.config
    'escrow_paused',
    'mint_not_allowed',
    'judge_key_mismatch',
  ]);
  for (const w of h.warnings ?? [])
    if (!covered.has(w.code))
      add({
        id: `server.${w.code}`,
        verdict: w.level === 'critical' ? 'NO-GO' : 'WARN',
        detail: w.message,
      });
  return out;
}

/** QuickNode Streams REST: the Stream's status (SKIP when not configured). */
export function evaluateStream(
  r: { status: number; body: unknown } | { error: string } | null,
  lastDeliveryAt: string | null | undefined,
): Check {
  const seen = lastDeliveryAt ? `, last delivery ${lastDeliveryAt}` : ', no delivery recorded';
  if (r === null)
    return {
      id: 'stream.status',
      verdict: 'SKIP',
      detail: `QN_API_KEY / QN_STREAM_ID not set${seen}`,
    };
  if ('error' in r)
    return { id: 'stream.status', verdict: 'WARN', detail: `unreachable: ${r.error}` };
  const status =
    (r.body as { status?: string; data?: { status?: string } } | null)?.status ??
    (r.body as { data?: { status?: string } } | null)?.data?.status;
  if (r.status !== 200 || !status)
    return { id: 'stream.status', verdict: 'WARN', detail: `HTTP ${r.status}${seen}` };
  return {
    id: 'stream.status',
    verdict: status === 'active' ? 'GO' : 'NO-GO',
    detail: `${status}${seen}`,
    ...(status === 'active'
      ? {}
      : { fix: 'POST /v1/demo/stream/reset-start then activate (QuickNode dashboard)' }),
  };
}

/** Overall: NO-GO if any item is NO-GO. */
export function overall(checks: readonly Check[]): 'GO' | 'NO-GO' {
  return checks.some((c) => c.verdict === 'NO-GO') ? 'NO-GO' : 'GO';
}

/** A fixed-width table for the terminal. */
export function formatChecks(checks: readonly Check[]): string {
  const w = Math.max(...checks.map((c) => c.id.length), 10);
  const lines = checks.map((c) => {
    const head = `${c.verdict.padEnd(5)}  ${c.id.padEnd(w)}  ${c.detail}`;
    return c.fix && c.verdict !== 'GO' ? `${head}\n${' '.repeat(w + 9)}fix: ${c.fix}` : head;
  });
  const verdict = overall(checks);
  const n = (v: Verdict) => checks.filter((c) => c.verdict === v).length;
  lines.push(
    '',
    `${verdict}: ${n('GO')} go, ${n('WARN')} warn, ${n('NO-GO')} no-go, ${n('SKIP')} skipped`,
  );
  return lines.join('\n');
}
