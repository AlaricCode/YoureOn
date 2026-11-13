/**
 * Hot-collection pruning (keeper task 'housekeeping', at most hourly). The
 * JSON store keeps every collection in memory and rewrites it whole, so
 * unbounded collections must be trimmed:
 *   chain_events_processed  older than PROCESSED_RETENTION_MS (replays of a
 *                           (signature, index) pair only happen within minutes)
 *   txs                     settled (confirmed/failed) older than TX_RETENTION_MS;
 *                           never-submitted ones once their blockhash expired a day ago
 *   challenges              expired more than a day ago
 *   enrollments             pending (never completed) biometric templates idle
 *                           for more than PENDING_ENROLLMENT_TTL_MS
 * Chunk records of terminal bets are archived per bet by the lifecycle
 * close-out (lifecycle/service.ts), not here.
 */
import type { AppContext } from '../context.js';
import { PENDING_ENROLLMENT_TTL_MS } from '../identity/biometrics.js';
import { COLLECTIONS, type TxRecord } from './records.js';

export const PROCESSED_RETENTION_MS = 7 * 24 * 3_600_000;
export const TX_RETENTION_MS = 30 * 24 * 3_600_000;
export const EXPIRED_RETENTION_MS = 24 * 3_600_000;
export const HOUSEKEEPING_EVERY_MS = 3_600_000;

export function pruneHotCollections(
  ctx: AppContext,
  nowMs: number,
): { events: number; txs: number; challenges: number; enrollments: number } {
  const out = { events: 0, txs: 0, challenges: 0, enrollments: 0 };
  const processed = ctx.store.collection<{ at_ms: number }>(COLLECTIONS.chainEvents);
  for (const [k, v] of processed.entries()) {
    if (nowMs - v.at_ms > PROCESSED_RETENTION_MS && processed.delete(k)) out.events++;
  }
  const txs = ctx.store.collection<TxRecord>(COLLECTIONS.txs);
  for (const [k, t] of txs.entries()) {
    const old =
      t.status === 'pending' ? nowMs - t.expires_at_ms > EXPIRED_RETENTION_MS : nowMs - t.updated_at_ms > TX_RETENTION_MS;
    if (old && txs.delete(k)) out.txs++;
  }
  const challenges = ctx.store.collection<{ expires_at_ms: number }>(COLLECTIONS.challenges);
  for (const [k, c] of challenges.entries()) {
    if (nowMs - c.expires_at_ms > EXPIRED_RETENTION_MS && challenges.delete(k)) out.challenges++;
  }
  const enrollments = ctx.store.collection<{ updated_at_ms: number }>(COLLECTIONS.enrollments);
  for (const [k, e] of enrollments.entries()) {
    if (nowMs - e.updated_at_ms > PENDING_ENROLLMENT_TTL_MS && enrollments.delete(k)) out.enrollments++;
  }
  return out;
}

/** Registers the throttled keeper task. */
export function registerHousekeeping(ctx: AppContext): void {
  let last = Number.NEGATIVE_INFINITY;
  ctx.keeper.register({
    name: 'housekeeping',
    run: (now) => {
      if (now - last < HOUSEKEEPING_EVERY_MS) return;
      last = now;
      const n = pruneHotCollections(ctx, now);
      if (n.events + n.txs + n.challenges + n.enrollments > 0) ctx.log.info(n, 'pruned hot collections');
    },
  });
}
