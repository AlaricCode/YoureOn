// Keeper task `draft-idle`: SCHEMAS §9.3 "Draft idle: 5 min since the last negotiation event
// → EXPIRED" (server-enforced; TASKS D2-J1 "a draft idle for 5 minutes expires").
// A throttled keeper task that expires stale records: a Postgres sweep over `bets`.
//
// Why: a challenge nobody answers would otherwise hold `pair_busy` and a slot of the 3-open-bets
// cap forever (bets/routes.ts PRE_LOCK_STATES).
//
// Scope: the negotiation phase only, DRAFTING and TERMS_PROPOSED (both list "EXPIRED (idle 5 min)"
// as an exit in the SCHEMAS §9.2 state table). Nothing is built or signed
// there (no nonce lease, no chain_txs row), so expiring is a pure offchain write. From
// AWAITING_AUTHORIZATIONS on, expiry is the lock window (`expires_at`, API-CONTRACT §2.8) and
// needs the nonce advance, which belongs to the lock sweeper, not this task.
//
// "Last negotiation event" = the newest bet_events row of the bet (bet.invited,
// bet.invite_answered, terms.draft / terms.proposed …), or bets.created_at if newer. Both are
// written with the injectable clock (deps.now), so tests can move time.
//
// Effects per expired bet, in one transaction (API-CONTRACT §3.4 "State → events on entry",
// row CANCELLED / EXPIRED): state EXPIRED, end_reason `draft_idle`; events `bet.state` and
// `judge.cue EXPIRED`; an audit row. No outbox push (the table has none for EXPIRED). After
// commit the events fan out to bet:<id> and the room's stage.
//
// Concurrency: candidates are read without locks, then each bet is claimed in its own short
// transaction with `FOR UPDATE SKIP LOCKED` (a request path or another keeper holding the row
// means "not this pass"), and the state and idleness are re-read after the lock. Every writer
// of bet_events first updates bets.last_seq, i.e. needs this row lock, so the re-check sees any
// activity that committed before the claim. Two keepers therefore never expire a bet twice and
// never expire one that just saw activity.
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { auditLog, betEvents, bets } from '@youre-on/db';
import type { BetState } from '@youre-on/shared/bet-state';
import type { AppDeps } from '../context';
import { judgeCue, type JudgeCue } from '../bets/cues';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import type { KeeperTask } from './keeper';

/** SCHEMAS §9.3 draft idle (ARCHITECTURE §7 demo config: 5 min). */
export const DRAFT_IDLE_MS = 5 * 60_000;
/** The negotiation states this task expires. */
export const DRAFT_IDLE_STATES = [
  'DRAFTING',
  'TERMS_PROPOSED',
] as const satisfies readonly BetState[];
/** Bets claimed per pass; the rest wait for the next pass (5 s later). */
export const DRAFT_IDLE_BATCH = 25;

export type SweepDeps = Pick<AppDeps, 'db' | 'hub' | 'log' | 'now'>;

export interface DraftIdleOptions {
  /** Default deps.now(). */
  now?: number;
  /** Default DRAFT_IDLE_MS. */
  idleMs?: number;
  /** Default DRAFT_IDLE_BATCH. */
  limit?: number;
  /** Only sweep bets in these rooms (test isolation on a shared database). */
  roomIds?: readonly string[];
}

export interface DraftIdleResult {
  /** Bets moved to EXPIRED by this call. */
  expired: string[];
  /** Candidates left alone: locked elsewhere, moved on, or active again after the lock. */
  skipped: number;
}

/** §4.5 `[EVENT] EXPIRED …` for a draft that went quiet. */
export function draftIdleCue(): JudgeCue {
  return judgeCue(
    'EXPIRED',
    { reason: 'draft_idle' },
    'Say the bet timed out before anyone agreed. Nothing moved.',
  );
}

/** GREATEST(bets.created_at, newest bet_events.created_at): the last negotiation activity. */
const lastActivity = sql`GREATEST(${bets.created_at}, COALESCE(
  (SELECT max(e.created_at) FROM ${betEvents} e WHERE e.bet_id = ${bets.id}), ${bets.created_at}))`;

/** One sweep: expires every DRAFTING / TERMS_PROPOSED bet idle for ≥ idleMs (up to `limit`). */
export async function expireIdleDrafts(
  deps: SweepDeps,
  opts: DraftIdleOptions = {},
): Promise<DraftIdleResult> {
  const now = opts.now ?? deps.now();
  const idleMs = opts.idleMs ?? DRAFT_IDLE_MS;
  const cutoff = new Date(now - idleMs);
  const cutoffSql = sql`${cutoff.toISOString()}::timestamptz`;

  const where: SQL[] = [
    inArray(bets.state, [...DRAFT_IDLE_STATES]),
    sql`${lastActivity} <= ${cutoffSql}`,
  ];
  if (opts.roomIds) {
    if (opts.roomIds.length === 0) return { expired: [], skipped: 0 };
    where.push(inArray(bets.room_id, [...opts.roomIds]));
  }
  const candidates = await deps.db
    .select({ id: bets.id })
    .from(bets)
    .where(and(...where))
    .orderBy(asc(bets.created_at))
    .limit(opts.limit ?? DRAFT_IDLE_BATCH);

  const out: DraftIdleResult = { expired: [], skipped: 0 };
  for (const { id } of candidates) {
    try {
      const done = await expireOne(deps, id, now, cutoffSql);
      if (!done) {
        out.skipped++;
        continue;
      }
      for (const e of done.events) deps.hub.publishBetEvent(e, done.room_id);
      out.expired.push(id);
    } catch (err) {
      out.skipped++;
      deps.log.warn('keeper.draft_idle_failed', { bet_id: id, err });
    }
  }
  return out;
}

async function expireOne(
  deps: SweepDeps,
  betId: string,
  now: number,
  cutoffSql: SQL,
): Promise<{ events: BetEventEnvelope[]; room_id: string | null } | null> {
  return deps.db.transaction(async (tx) => {
    const [bet] = await tx
      .select()
      .from(bets)
      .where(eq(bets.id, betId))
      .for('update', { skipLocked: true })
      .limit(1);
    if (!bet) return null; // locked by a request or another keeper: next pass
    if (!(DRAFT_IDLE_STATES as readonly BetState[]).includes(bet.state)) return null;

    // Re-check under the lock with a fresh statement (READ COMMITTED: new snapshot).
    const [fresh] = await tx
      .select({
        idle: sql<boolean>`${lastActivity} <= ${cutoffSql}`,
        last_ms: sql<number>`(extract(epoch FROM ${lastActivity}) * 1000)::float8`,
      })
      .from(bets)
      .where(eq(bets.id, betId));
    if (!fresh?.idle) return null;

    // The versioned state write first; appendBetEvent's last_seq bump comes after.
    const updated = await tx
      .update(bets)
      .set({ state: 'EXPIRED', end_reason: 'draft_idle' })
      .where(and(eq(bets.id, betId), eq(bets.version, bet.version)))
      .returning({ id: bets.id });
    if (updated.length !== 1) return null;

    const events: BetEventEnvelope[] = [
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.state',
        payload: {
          state: 'EXPIRED',
          prev: bet.state,
          onchain_status: null,
          chain_ack: 'none',
          pending_tx: null,
          reason: 'draft_idle',
        },
        now,
      }),
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'judge.cue',
        payload: draftIdleCue(),
        now,
      }),
    ];
    await tx.insert(auditLog).values({
      actor_kind: 'server',
      action: 'bet.state_changed',
      bet_id: betId,
      subject_user_id: bet.party_b_id,
      details: {
        from: bet.state,
        to: 'EXPIRED',
        end_reason: 'draft_idle',
        by: 'keeper',
        last_activity_at: new Date(Number(fresh.last_ms)).toISOString(),
      },
    });
    return { events, room_id: bet.room_id };
  });
}

/** The keeper task: one sweep per pass, a log line when something expired. */
export function draftIdleTask(
  deps: SweepDeps,
  opts: Omit<DraftIdleOptions, 'now'> = {},
): KeeperTask {
  return {
    name: 'draft-idle',
    async run(now) {
      const r = await expireIdleDrafts(deps, { ...opts, now });
      if (r.expired.length > 0) {
        deps.log.info('keeper.draft_idle_expired', { count: r.expired.length, bet_ids: r.expired });
      }
      return r;
    },
  };
}
