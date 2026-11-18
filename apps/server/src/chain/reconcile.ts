// Boot reconcile (DATA-MODEL §5.20 "Boot reconcile and sweep", ARCHITECTURE §1 "every timer is a
// DB row first"): the first keeper pass after a (re)start, before the regular sweeps, re-checks
// everything a restart can leave half-done against the chain and fixes it, then logs one summary
// line and the boot health line:
//
//   - 'sent' atomic locks (landed -> LOCKED; unseen -> re-broadcast; dead at expires_at ->
//     EXPIRED + revoke) and 'advancing' nonces                      LockService.sweep
//   - 'sent' resolve / concede / finalize rows; RULED bets past the appeal window; CONCEDED /
//     FINALIZED bets with no payout in flight                        PayoutService.finalizeDue
//   - JUDGING bets whose decisive ruling never reached the chain   resolveDue (deps.onRuling)
//   - 'sent' appeal / resolve_appeal rows; APPEALED bets whose panel died with the restart
//                                                                    AppealService.sweep
//   - 'sent' timeout_refund rows; bets past resolve_deadline        RefundService.sweep
//   - and an audit: every post-lock, non-terminal bet against its Bet account; a mismatch the
//     sweeps cannot explain is logged as chain.boot_anomaly (and listed in the summary).
//
// Every step is the same idempotent sweep the keeper runs every few seconds, so running this
// again (or concurrently with another machine during a deploy) is harmless.
import { inArray, sql } from 'drizzle-orm';
import { bets, chainTxs } from '@youre-on/db';
import type { BetState } from '@youre-on/shared/bet-state';
import { BetStatus } from '@youre-on/shared/escrow-client';
import type { AppDeps } from '../context';
import { readBetAccount } from '../lock/common';
import { lifecycleOf } from '../lock/runtime';
import { resolveDue } from '../payout/resolve-due';
import { chainHealth, healthLine } from './health';

/** Post-lock, non-terminal states and the onchain statuses each may legitimately show. */
const EXPECTED: Partial<Record<BetState, ReadonlyArray<BetStatus | null>>> = {
  AWAITING_LOCK: [null, BetStatus.Locked],
  LOCKED: [BetStatus.Locked],
  ATTEMPT: [BetStatus.Locked],
  JUDGING: [BetStatus.Locked, BetStatus.Resolved],
  HEARING: [BetStatus.Locked],
  AWAITING_MARKET: [BetStatus.Locked],
  RULED: [BetStatus.Resolved, BetStatus.Appealed, null],
  CONCEDED: [BetStatus.Resolved, null],
  FINALIZED: [BetStatus.Resolved, null],
  APPEALED: [BetStatus.Appealed, null],
  APPEAL_RESOLVED: [null],
};

export interface BootReconcileReport {
  chain_configured: boolean;
  before: { sent_txs: Record<string, number>; live_bets: Record<string, number> };
  lock: { expired: string[]; landed: string[] } | null;
  payouts_settled: string[];
  resolves_retried: number;
  refunds: { refunded: string[]; pending: string[] } | null;
  anomalies: Array<{ bet_id: string; state: BetState; onchain: string }>;
  errors: string[];
}

type Deps = Pick<AppDeps, 'db' | 'env' | 'now' | 'hub' | 'log' | 'keeper' | 'markets' | 'onRuling'>;

export async function bootReconcile(deps: Deps, nowMs: number): Promise<BootReconcileReport> {
  const report: BootReconcileReport = {
    chain_configured: false,
    before: { sent_txs: {}, live_bets: {} },
    lock: null,
    payouts_settled: [],
    resolves_retried: 0,
    refunds: null,
    anomalies: [],
    errors: [],
  };
  const lc = lifecycleOf(deps);
  const rt = await lc.runtime();
  report.chain_configured = !!rt;

  const sent = await deps.db
    .select({ kind: chainTxs.kind, n: sql<number>`count(*)::int` })
    .from(chainTxs)
    .where(inArray(chainTxs.status, ['sent']))
    .groupBy(chainTxs.kind);
  report.before.sent_txs = Object.fromEntries(sent.map((r) => [r.kind, r.n]));
  const live = await deps.db
    .select({ state: bets.state, n: sql<number>`count(*)::int` })
    .from(bets)
    .where(inArray(bets.state, Object.keys(EXPECTED) as BetState[]))
    .groupBy(bets.state);
  report.before.live_bets = Object.fromEntries(live.map((r) => [r.state, r.n]));

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      report.errors.push(`${name}: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      deps.log.warn('chain.boot_step_failed', { step: name, err });
      return null;
    }
  };

  if (rt) {
    report.lock = await step('lock-sweep', () => lc.lock.sweep(nowMs));
    report.payouts_settled = (await step('finalize-due', () => lc.payout.finalizeDue(nowMs))) ?? [];
    report.resolves_retried = (await step('resolve-due', () => resolveDue(deps, nowMs))) ?? 0;
    await step('appeal-sweep', () => lc.appeal.sweep(nowMs));
    const r = await step('timeout-refund', () => lc.refund.sweep(nowMs));
    report.refunds = r ? { refunded: r.refunded, pending: r.pending } : null;
    await lc.idle();

    // The audit, after the sweeps had their chance.
    const rows = await deps.db
      .select({ id: bets.id, state: bets.state })
      .from(bets)
      .where(inArray(bets.state, Object.keys(EXPECTED) as BetState[]))
      .limit(50);
    for (const b of rows) {
      let status: BetStatus | null;
      try {
        status = (await readBetAccount(rt, b.id))?.status ?? null;
      } catch (err) {
        report.errors.push(
          `audit ${b.id}: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
        );
        continue;
      }
      if ((EXPECTED[b.state] ?? []).includes(status)) continue;
      const a = {
        bet_id: b.id,
        state: b.state,
        onchain: status === null ? 'missing' : BetStatus[status],
      };
      report.anomalies.push(a);
      deps.log.warn('chain.boot_anomaly', a);
    }
  }

  deps.log.info('chain.boot_reconcile', {
    chain: report.chain_configured,
    sent_before: report.before.sent_txs,
    live_before: report.before.live_bets,
    locks_landed: report.lock?.landed.length ?? 0,
    locks_expired: report.lock?.expired.length ?? 0,
    payouts_settled: report.payouts_settled.length,
    resolves_retried: report.resolves_retried,
    refunds: report.refunds?.refunded.length ?? 0,
    anomalies: report.anomalies.length,
    errors: report.errors.length,
  });
  const health = await step('health', () => chainHealth(deps));
  if (health)
    deps.log[health.warnings.length ? 'warn' : 'info']('chain.boot_health', healthLine(health));
  return report;
}
