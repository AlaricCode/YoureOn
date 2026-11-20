// The GG moment (packages/shared/src/gg.ts): two hooks the PayoutService calls (lock/runtime.ts
// wires them).
//
//   onConcedeSubmitted  in the commit that moves the bet to CONCEDED: bet.gg {by, winner, to_a,
//                       to_b, record {before, after}, conceded_at}, all the stage and the phones
//                       need to play the GG. A record read that fails gives record null, never a
//                       failed GG.
//   cueContext          in the commit that moves the bet to PAID: how it got there, for the voiced
//                       line. concede -> via gg (+ the record after); finalize -> via timeout
//                       (+ how a spoken review ended: review.closed's reason, or 'lapsed' for a
//                       request that never closed, e.g. its timer was lost to a restart).
//
// A concede that never lands (revertPayout -> RULED, reason concede_failed) sends no new event:
// clients drop the GG when bet.state goes RULED from CONCEDED.
// Spec: docs/planning/API-CONTRACT.md §2.12a.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { betEvents } from '@youre-on/db';
import { BetGgPayload, GgRecord, recordAfter, type PairRecord } from '@youre-on/shared/gg';
import type { Party } from '@youre-on/shared/primitives';
import { payout } from '@youre-on/shared/ruling';
import type { BetRow } from '../bets/snapshot';
import { iso, type LifecycleDeps, type Tx } from '../lock/common';
import type { PayoutCueContext, PayoutServiceOptions } from '../payout/service';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { pairRecord } from './record';

/** The decisive ruling's winner, or null (split / refund: no GG). */
export function winnerOf(bet: Pick<BetRow, 'outcome'>): Party | null {
  return bet.outcome === 'party_a' ? 'A' : bet.outcome === 'party_b' ? 'B' : null;
}

/** The record before / after this bet, or null when it can't be read (never throws). */
export async function ggRecord(
  tx: Tx,
  bet: Pick<BetRow, 'id' | 'party_a_id' | 'party_b_id'>,
  winner: Party,
  log: LifecycleDeps['log'],
): Promise<GgRecord | null> {
  try {
    // A savepoint: a failed read must not abort the CONCEDED commit around it.
    const before = await tx.transaction((sp) => pairRecord(sp, bet.party_a_id, bet.party_b_id));
    const r = GgRecord.safeParse({ before, after: recordAfter(before, winner) });
    return r.success ? r.data : null;
  } catch (err) {
    log.warn('gg.record_failed', { bet_id: bet.id, err: String(err) });
    return null;
  }
}

/** bet.gg for a concede being sent (in the CONCEDED commit). [] when the ruling has no loser. */
export async function ggEvents(
  deps: Pick<LifecycleDeps, 'log'>,
  tx: Tx,
  bet: BetRow,
  now: number,
): Promise<BetEventEnvelope[]> {
  const winner = winnerOf(bet);
  if (!winner) return [];
  const stakeA = bet.stake_a ?? 0n;
  const amounts = payout(
    winner === 'A' ? 'PartyA' : 'PartyB',
    stakeA,
    stakeA + (bet.stake_b ?? 0n),
  );
  const payload = BetGgPayload.safeParse({
    by: winner === 'A' ? 'B' : 'A',
    winner,
    to_a: amounts.to_a.toString(),
    to_b: amounts.to_b.toString(),
    record: await ggRecord(tx, bet, winner, deps.log),
    conceded_at: iso(now),
  });
  if (!payload.success) {
    deps.log.warn('gg.payload_invalid', { bet_id: bet.id, err: payload.error.message });
    return [];
  }
  return [await appendBetEvent(tx, { bet_id: bet.id, type: 'bet.gg', payload: payload.data, now })];
}

/** The PAID cue's context from the bet's own log (concede = GG, finalize = the clock). */
export async function payoutCueContext(
  tx: Pick<Tx, 'select'>,
  bet: Pick<BetRow, 'id' | 'outcome'>,
  kind: 'finalize' | 'concede',
): Promise<PayoutCueContext | undefined> {
  if (!winnerOf(bet)) return undefined;
  const rows = await tx
    .select({ type: betEvents.type, envelope: betEvents.envelope })
    .from(betEvents)
    .where(
      and(
        eq(betEvents.bet_id, bet.id),
        inArray(
          betEvents.type,
          kind === 'concede' ? ['bet.gg'] : ['review.requested', 'review.closed'],
        ),
      ),
    )
    .orderBy(desc(betEvents.seq))
    .limit(10);
  const payloadOf = (r: (typeof rows)[number]) =>
    (r.envelope as { payload?: Record<string, unknown> }).payload ?? {};
  if (kind === 'concede') {
    const gg = rows[0] ? BetGgPayload.safeParse(payloadOf(rows[0])) : null;
    const record: PairRecord | null = gg?.success ? (gg.data.record?.after ?? null) : null;
    return { via: 'gg', record };
  }
  const closed = rows.find((r) => r.type === 'review.closed');
  const reason = closed ? payloadOf(closed).reason : undefined;
  const review =
    reason === 'declined' || reason === 'lapsed'
      ? reason
      : rows.some((r) => r.type === 'review.requested')
        ? 'lapsed'
        : null;
  return { via: 'timeout', review };
}

/** The PayoutService options that make the GG moment (lock/runtime.ts). */
export function ggPayoutHooks(
  deps: Pick<LifecycleDeps, 'log'>,
): Pick<PayoutServiceOptions, 'onConcedeSubmitted' | 'cueContext'> {
  return {
    onConcedeSubmitted: (tx, bet, now) => ggEvents(deps, tx, bet, now),
    cueContext: async (tx, bet, kind) => {
      try {
        return await tx.transaction((sp) => payoutCueContext(sp, bet, kind));
      } catch (err) {
        deps.log.warn('gg.cue_context_failed', { bet_id: bet.id, err: String(err) });
        return undefined;
      }
    },
  };
}
