// The spoken review request (types: packages/shared/src/gg.ts). Someone in the room says "check
// that again": the voice agent calls request_review (./tool.ts), or the operator POSTs
// /v1/demo/bets/:id/review. The court then asks the LOSER's phone to confirm the appeal (tap +
// Face ID, device policy 'appeal'). A spoken request never files anything: the mic can't tell
// who spoke.
// Spec: docs/planning/API-CONTRACT.md §2.12a.
//
// confirm_by = appeal_deadline − APPEAL_UI_MARGIN_MS: the appeal POST's own cutoff. The hold can't
// be longer: the program refuses an appeal at or after appeal_deadline, so the review holds the
// ruling open exactly until the appeal cutoff and never moves it (once per ruling).
// Finalize can't race it: a request is accepted only before confirm_by − REVIEW_MIN_LEAD_MS, and
// finalize runs at or after appeal_deadline (chain clock; the server re-arms on AppealWindowOpen),
// so they are at least 2.5 s apart. A confirmed review is the normal appeal (appeal/service.ts:
// filed RULED-under-lock, finalize skips while it is out). A GG closes it (bet.gg on clients).
//
// Persistent state is the bet's own log (bet_events). The timers are in memory: a timer lost to
// a restart only means no review.closed (clients close at confirm_by; the PAID cue reads the log).
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { appeals, auditLog, betEvents, bets, chainTxs, users } from '@youre-on/db';
import { BetState } from '@youre-on/shared/bet-state';
import {
  REVIEW_HEARD_MAX,
  REVIEW_MIN_LEAD_MS,
  ReviewRequestedPayload,
  type ReviewClosedReason,
  type ReviewFix,
  type ReviewSource,
} from '@youre-on/shared/gg';
import type { Party } from '@youre-on/shared/primitives';
import { APPEAL_UI_MARGIN_MS } from '../appeal/service';
import { judgeCue, type JudgeCue } from '../bets/cues';
import { partyOf, type BetRow } from '../bets/snapshot';
import { HttpError } from '../errors';
import { isDanceOffBet } from '../judge/dance-bet';
import { fanout, iso, lockBet, type LifecycleDeps, type Tx } from '../lock/common';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';

const ORDER = BetState.options;
const before = (s: BetState, t: BetState) => ORDER.indexOf(s) < ORDER.indexOf(t);

export interface ReviewServiceOptions {
  deps: LifecycleDeps;
  /** Arm the lapse setTimeout (default true; tests call lapse() themselves). */
  timers?: boolean;
}

export interface ReviewRequestOptions {
  source: ReviewSource;
  /** What the judge heard (audit only, never broadcast; cut to REVIEW_HEARD_MAX). */
  heard?: string;
  conversationId?: string | null;
  requestId?: string;
  /**
   * The loser's appeal tokens left (the 3/h bucket, read-only). < 1 -> NO_APPEALS_LEFT. Absent:
   * not checked (the phone then answers RATE_LIMITED on the tap). Never takes a token.
   */
  appealsLeft?: (userId: string) => number;
}

export type ReviewResult =
  | {
      ok: true;
      /** The review was already open (a retry, a second phrase): no new event. */
      already: boolean;
      review: ReviewRequestedPayload;
      /** The loser's display name (who is asked). */
      loser_name: string;
    }
  | { ok: false; fix: ReviewFix; loser_name: string | null };

/** `[EVENT] REVIEW_CLOSED by=Jake reason=declined :: Do not speak. Jake kept the ruling.` */
export function reviewClosedCue(loserName: string, reason: ReviewClosedReason): JudgeCue {
  return judgeCue(
    'REVIEW_CLOSED',
    { by: loserName, reason },
    reason === 'declined'
      ? `Do not speak. ${loserName} kept the ruling.`
      : 'Do not speak. The review was not confirmed; the ruling stands.',
    false,
  );
}

/** confirm_by of a RULED bet: the appeal cutoff (appeal_deadline − 1 s). */
export const confirmByOf = (appealDeadline: Date): number =>
  appealDeadline.getTime() - APPEAL_UI_MARGIN_MS;

interface ReviewLog {
  open: ReviewRequestedPayload | null;
  /** Any review.closed on this bet (once per ruling). */
  closed: boolean;
  requested: boolean;
}

/** The bet's review state from its log (latest request, and whether it was closed). */
async function reviewLog(db: Pick<Tx, 'select'>, betId: string): Promise<ReviewLog> {
  const rows = await db
    .select({ type: betEvents.type, envelope: betEvents.envelope })
    .from(betEvents)
    .where(
      and(
        eq(betEvents.bet_id, betId),
        inArray(betEvents.type, ['review.requested', 'review.closed']),
      ),
    )
    .orderBy(betEvents.seq);
  let latest: ReviewRequestedPayload | null = null;
  const closedIds = new Set<string>();
  for (const r of rows) {
    const p = (r.envelope as { payload?: { review_id?: string } }).payload ?? {};
    if (r.type === 'review.closed') closedIds.add(String(p.review_id));
    else {
      const parsed = ReviewRequestedPayload.safeParse(p);
      if (parsed.success) latest = parsed.data;
    }
  }
  return {
    open: latest && !closedIds.has(latest.review_id) ? latest : null,
    closed: closedIds.size > 0,
    requested: latest !== null,
  };
}

/** The loser's `appeal` signed / out, or a filing on record: the ruling is with the panel. */
async function appealFiled(db: Pick<Tx, 'select'>, betId: string): Promise<boolean> {
  const [tx] = await db
    .select({ id: chainTxs.id })
    .from(chainTxs)
    .where(
      and(
        eq(chainTxs.bet_id, betId),
        eq(chainTxs.kind, 'appeal'),
        inArray(chainTxs.status, ['signed', 'sent']),
      ),
    )
    .limit(1);
  if (tx) return true;
  const [ap] = await db
    .select({ id: appeals.id })
    .from(appeals)
    .where(and(eq(appeals.bet_id, betId), ne(appeals.status, 'failed')))
    .limit(1);
  return ap !== undefined;
}

async function nameOf(db: Pick<Tx, 'select'>, userId: string): Promise<string> {
  const [u] = await db
    .select({ name: users.display_name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.name ?? 'The loser';
}

const loserOf = (b: Pick<BetRow, 'outcome'>): Party | null =>
  b.outcome === 'party_a' ? 'B' : b.outcome === 'party_b' ? 'A' : null;
const userOf = (b: Pick<BetRow, 'party_a_id' | 'party_b_id'>, p: Party) =>
  p === 'A' ? b.party_a_id : b.party_b_id;

export class ReviewService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly o: ReviewServiceOptions) {}

  private get deps() {
    return this.o.deps;
  }

  /**
   * The state checks, in order; null when the bet is RULED (request() then checks the appeal, the
   * market, the dance off, the loser, one review per ruling, the window and the appeals left).
   */
  private stateFix(b: BetRow): ReviewFix | null {
    if (b.state === 'RULED') return null;
    if (before(b.state, 'RULED')) return 'NO_RULING';
    if (b.state === 'CONCEDED' || (b.state === 'PAID' && b.payout_via === 'concede'))
      return 'GG_CALLED';
    if (b.state === 'APPEALED' || b.state === 'APPEAL_RESOLVED') return 'WITH_PANEL';
    // Cancelled or expired: the bet ended with no winner (nothing moved, or both stakes came
    // back), so there is nobody to review for. Both sort after RULED in the enum, so the order
    // check above misses them.
    if (b.state === 'CANCELLED' || b.state === 'EXPIRED') return 'NO_LOSER';
    return 'FINAL';
  }

  /**
   * Asks the loser's phone to confirm a review of the ruling. Never files an appeal, never takes
   * an appeal token. `{ok:false, fix}` for every refusal (the judge says why).
   */
  async request(betId: string, o: ReviewRequestOptions): Promise<ReviewResult> {
    const now = this.deps.now();
    type Out = { r: ReviewResult; b?: BetRow; env?: BetEventEnvelope };
    const out = await this.deps.db.transaction(async (tx): Promise<Out> => {
      const b = await lockBet(tx, betId);
      if (!b) return { r: { ok: false, fix: 'WRONG_BET', loser_name: null } };
      const loser = loserOf(b);
      const loserName = loser ? await nameOf(tx, userOf(b, loser)) : null;
      const no = (fix: ReviewFix): Out => ({ r: { ok: false, fix, loser_name: loserName } });
      const stateFix = this.stateFix(b);
      if (stateFix) return no(stateFix);
      if (await appealFiled(tx, betId)) return no('WITH_PANEL');
      if (b.evidence_source === 'gemini') return no('MARKET');
      // The score decides a dance off; there is no review ("The ruling is final.").
      if (await isDanceOffBet(tx, betId)) return no('FINAL');
      if (!loser || !loserName) return no('NO_LOSER');
      if (!b.appeal_deadline) return no('NO_RULING');
      const confirmBy = confirmByOf(b.appeal_deadline);
      const log = await reviewLog(tx, betId);
      if (log.open && now < Date.parse(log.open.confirm_by))
        return { r: { ok: true, already: true, review: log.open, loser_name: loserName } };
      if (log.closed || log.requested) return no('ONE_REVIEW');
      if (now >= confirmBy - REVIEW_MIN_LEAD_MS) return no('WINDOW_CLOSED');
      if (o.appealsLeft && o.appealsLeft(userOf(b, loser)) < 1) return no('NO_APPEALS_LEFT');
      const review = ReviewRequestedPayload.parse({
        review_id: randomUUID(),
        for_party: loser,
        source: o.source,
        requested_at: iso(now),
        confirm_by: iso(confirmBy),
      });
      const env = await appendBetEvent(tx, {
        bet_id: betId,
        type: 'review.requested',
        payload: review,
        now,
      });
      await tx.insert(auditLog).values({
        actor_kind: o.source === 'voice' ? 'judge' : 'system',
        action: 'review.requested',
        bet_id: betId,
        subject_user_id: userOf(b, loser),
        request_id: o.requestId ?? null,
        details: {
          review_id: review.review_id,
          source: o.source,
          for_party: loser,
          heard: (o.heard ?? '').slice(0, REVIEW_HEARD_MAX),
          conversation_id: o.conversationId ?? null,
          confirm_by: review.confirm_by,
        },
      });
      return { r: { ok: true, already: false, review, loser_name: loserName }, b, env };
    });
    if (out.env && out.b && out.r.ok) {
      fanout(this.deps, out.b, [out.env]);
      const review = out.r.review;
      this.deps.log.info('review.requested', {
        bet_id: betId,
        review_id: review.review_id,
        for_party: review.for_party,
        source: o.source,
        confirm_by: review.confirm_by,
      });
      this.armLapse(betId, review.review_id, Date.parse(review.confirm_by));
    }
    return out.r;
  }

  /** At confirm_by: closes a review nobody confirmed (no-op once moved on / closed / appealed). */
  async lapse(betId: string, reviewId: string): Promise<boolean> {
    return this.close(betId, reviewId, 'lapsed');
  }

  /**
   * POST /v1/bets/:id/review/decline: the loser keeps the ruling. Idempotent: an already closed
   * review answers {status:'closed'} again. After confirm_by it closes as 'lapsed'.
   */
  async decline(betId: string, userId: string): Promise<{ status: 'closed' }> {
    const now = this.deps.now();
    const [b] = await this.deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
    if (!b) throw new HttpError('NOT_FOUND', 'No such bet.');
    const party = partyOf(b, userId);
    if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
    const log = await reviewLog(this.deps.db, betId);
    const latest = log.open;
    if (!latest) {
      if (log.closed) return { status: 'closed' };
      throw new HttpError('INVALID_STATE', 'No review to answer.', { reason: 'no_review' });
    }
    if (latest.for_party !== party) throw new HttpError('NOT_LOSER', 'Only the loser answers.');
    const reason: ReviewClosedReason = now < Date.parse(latest.confirm_by) ? 'declined' : 'lapsed';
    const closed = await this.close(betId, latest.review_id, reason);
    if (!closed) {
      const fresh = await reviewLog(this.deps.db, betId);
      if (fresh.open?.review_id === latest.review_id)
        throw new HttpError('STATE_MOVED_ON', undefined, { reason: 'ruling_moved_on' });
    }
    return { status: 'closed' };
  }

  private async close(betId: string, reviewId: string, reason: ReviewClosedReason) {
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const b = await lockBet(tx, betId);
      if (!b || b.state !== 'RULED') return null;
      if (await appealFiled(tx, betId)) return null;
      const log = await reviewLog(tx, betId);
      if (log.open?.review_id !== reviewId) return null;
      const loserName = await nameOf(tx, userOf(b, log.open.for_party));
      const envs: BetEventEnvelope[] = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'review.closed',
          payload: { review_id: reviewId, reason },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: reviewClosedCue(loserName, reason),
          now,
        }),
      ];
      return { b, envs };
    });
    if (!out) return false;
    fanout(this.deps, out.b, out.envs);
    const t = this.timers.get(betId);
    if (t) clearTimeout(t);
    this.timers.delete(betId);
    this.deps.log.info('review.closed', { bet_id: betId, review_id: reviewId, reason });
    return true;
  }

  private armLapse(betId: string, reviewId: string, atMs: number): void {
    if (this.o.timers === false) return;
    const prev = this.timers.get(betId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(
      () => {
        this.timers.delete(betId);
        this.lapse(betId, reviewId).catch((err: unknown) =>
          this.deps.log.warn('review.lapse_failed', { bet_id: betId, err: String(err) }),
        );
      },
      Math.max(0, atMs - this.deps.now()),
    );
    t.unref?.();
    this.timers.set(betId, t);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Drops the lapse timers of bets that no longer exist (POST /v1/demo/reset). */
  forget(betIds: readonly string[]): void {
    for (const id of betIds) {
      const t = this.timers.get(id);
      if (t) clearTimeout(t);
      this.timers.delete(id);
    }
  }
}
