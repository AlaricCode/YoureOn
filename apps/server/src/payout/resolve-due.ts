// Keeper sweep "resolve-due": the durable backstop of the judge -> payout seam.
//
// The judge commits a decisive or VOID ruling, then calls deps.onRuling in-process. If that call
// fails (an RPC 429 / timeout, a restart between commit and send), nothing else would ever send
// `resolve` and the bet would sit in JUDGING for good. This sweep finds bets whose latest ruling
// is decisive / VOID but that never reached RULED (bets.ruling_hash still NULL), and re-runs
// onRuling, which is idempotent (it adopts a resolve that already landed onchain).
import { sql } from 'drizzle-orm';
import { Ruling } from '@youre-on/shared/ruling';
import type { AppDeps } from '../context';
import type { KeeperTask } from '../keeper/keeper';

/** A ruling younger than this is still being handled by the in-process call. */
export const RESOLVE_GRACE_MS = 15_000;
/** At most this many bets per sweep (one resolve tx each). */
export const RESOLVE_BATCH = 5;

export type ResolveDueDeps = Pick<AppDeps, 'db' | 'log'> & Partial<Pick<AppDeps, 'onRuling'>>;

export async function resolveDue(deps: ResolveDueDeps, now: number): Promise<number> {
  if (!deps.onRuling) return 0;
  const cutoff = new Date(now - RESOLVE_GRACE_MS);
  const rows = await deps.db.execute<{ bet_id: string; record_canonical: string }>(sql`
    SELECT r.bet_id, r.record_canonical
      FROM bets b
      JOIN LATERAL (
        SELECT bet_id, outcome, record_canonical, created_at
          FROM rulings
         WHERE rulings.bet_id = b.id
         ORDER BY created_at DESC
         LIMIT 1
      ) r ON true
     WHERE b.state = 'JUDGING'
       AND b.ruling_hash IS NULL
       AND r.outcome IN ('A_WINS', 'B_WINS', 'VOID')
       AND r.created_at < ${cutoff}
     ORDER BY r.created_at
     LIMIT ${RESOLVE_BATCH}`);
  let sent = 0;
  for (const row of rows) {
    try {
      const ruling = Ruling.parse(JSON.parse(row.record_canonical));
      await deps.onRuling(row.bet_id, ruling);
      sent++;
      deps.log.info('payout.resolve_retried', { bet_id: row.bet_id, outcome: ruling.outcome });
    } catch (e) {
      deps.log.warn('payout.resolve_retry_failed', { bet_id: row.bet_id, err: String(e) });
    }
  }
  return sent;
}

export function resolveDueTask(deps: ResolveDueDeps): KeeperTask {
  return { name: 'resolve-due', run: (now) => resolveDue(deps, now) };
}
