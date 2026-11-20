// B's invite answer as the consent gate for freezing terms: a confirm (voice or typed) is refused
// INVITE_PENDING until B has accepted. If the voice judge's confirm_terms was refused for THESE
// terms, B's accept hands it an [EVENT] INVITE_ACCEPTED line to re-confirm, since nothing else
// would tell it (the judge only hears the room).
// Spec: docs/planning/API-CONTRACT.md §2.5.
//
// The deciding checks run inside the caller's transaction, under the bet row lock, so a confirm
// and an accept serialize: either the refusal is recorded first (and the accept sees it) or the
// accept is (and the confirm goes through).
import { and, asc, eq, sql } from 'drizzle-orm';
import { auditLog, betEvents } from '@youre-on/db';
import { BetInviteAnsweredPayload } from '@youre-on/shared/api';
import type { AppDeps } from '../context';
import type { Tx } from '../lock/common';

export const CONFIRM_REFUSED_ACTION = 'terms.confirm_refused';

/** B's invite answers so far (accepted / declined), from the bet's bet_events log. */
export async function priorAnswers(
  tx: Tx | AppDeps['db'],
  betId: string,
): Promise<Set<'accepted' | 'declined'>> {
  const rows = await tx
    .select({ envelope: betEvents.envelope })
    .from(betEvents)
    .where(and(eq(betEvents.bet_id, betId), eq(betEvents.type, 'bet.invite_answered')))
    .orderBy(asc(betEvents.seq));
  const out = new Set<'accepted' | 'declined'>();
  for (const r of rows) {
    const p = BetInviteAnsweredPayload.safeParse((r.envelope as { payload?: unknown }).payload);
    if (p.success) out.add(p.data.answer);
  }
  return out;
}

/** The audit row for a confirm refused because B has not accepted yet. */
export async function recordInvitePending(
  tx: Tx,
  o: {
    betId: string;
    termsHash: string | null;
    actor: 'judge' | 'system' | 'user';
    actorUserId?: string;
    requestId?: string;
    heard?: string;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actor_kind: o.actor,
    actor_user_id: o.actorUserId ?? null,
    action: CONFIRM_REFUSED_ACTION,
    bet_id: o.betId,
    request_id: o.requestId ?? null,
    details: { reason: 'invite_pending', terms_hash: o.termsHash, heard: o.heard ?? null },
  });
}

/** True when the voice judge's confirm_terms was refused INVITE_PENDING for these exact terms. */
export async function judgeAwaitsAccept(
  tx: Tx,
  betId: string,
  termsHash: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.bet_id, betId),
        eq(auditLog.action, CONFIRM_REFUSED_ACTION),
        eq(auditLog.actor_kind, 'judge'),
        sql`${auditLog.details}->>'reason' = 'invite_pending'`,
        sql`${auditLog.details}->>'terms_hash' = ${termsHash}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
