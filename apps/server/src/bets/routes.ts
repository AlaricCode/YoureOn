// Challenge, API-CONTRACT §2.5 (TASKS D0-J4):
//   POST /v1/bets                          (S)     -> 201 {bet: BetSnapshot (DRAFTING), voice: {dynamic_variables}}
//   POST /v1/bets/:bet_id/invite/accept    (S, B)  -> 200 {bet}   bet.invite_answered accepted; state unchanged
//                                                     (+ judge.cue INVITE_ACCEPTED if the voice judge
//                                                     was told to wait for it: ./invite.ts)
//   POST /v1/bets/:bet_id/invite/decline   (S, B)  -> 200 {bet}   -> CANCELLED (declined); judge.cue DECLINED
//
// POST /v1/bets effects, in ONE transaction: the bets row (bet_id = new UUIDv4 = the onchain
// bet_id), the voice_sessions binding, bet.invited (seq 1) + bet.state DRAFTING (seq 2) in
// bet_events, outbox `challenge_received` to B, an audit row. After commit: bet.invited to
// B's user channel (and the bet channel / room stage), bet.state to the bet channel.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { auditLog, bets, outbox, users, voiceSessions } from '@youre-on/db';
import {
  BetInviteAnsweredPayload,
  CreateBetRequest,
  type ChallengeReceivedPush,
  type CreateBetResponse,
  type InviteAnswerResponse,
} from '@youre-on/shared/api';
import { USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { formatUsd } from '@youre-on/shared/money';
import { Uuid } from '@youre-on/shared/primitives';
import type { BetState } from '@youre-on/shared/bet-state';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { assertRoomLive, getRoomOr404, isActiveMember } from '../rooms/service';
import { declinedCue, inviteAcceptedCue } from './cues';
import { judgeAwaitsAccept, priorAnswers } from './invite';
import { verifyMatchTicket } from './match-ticket';
import { betSnapshot, loadUserRefs, partyOf, type BetRow } from './snapshot';

/** Circle devnet USDC (the packages/shared pin, ESCROW §2), used when USDC_MINT is unset. */
export const DEVNET_USDC_MINT = USDC_MINT_DEVNET;

/** States before the lock lands: a pair may have at most one bet here (`pair_busy`). */
export const PRE_LOCK_STATES = [
  'DRAFTING',
  'TERMS_PROPOSED',
  'AWAITING_AUTHORIZATIONS',
  'AWAITING_LOCK',
] as const satisfies readonly BetState[];

/** §1.7: POST /v1/bets 6/min per user, and ≤ 3 pre-lock bets per user. */
export const BETS_BUCKET = { limit: 6, windowMs: 60_000 } as const;
export const MAX_PRE_LOCK_BETS_PER_USER = 3;

/** §2.5: B may decline through the invite only here; later through §2.8 lock/decline. */
const INVITE_DECLINABLE: readonly BetState[] = ['DRAFTING', 'TERMS_PROPOSED'];
/** Accept is informational; it makes sense until the lock is in flight. */
const INVITE_ACCEPTABLE: readonly BetState[] = [
  'DRAFTING',
  'TERMS_PROPOSED',
  'AWAITING_AUTHORIZATIONS',
];

/** "20000000" -> "20" (the agent's `max_stake_usd` dynamic variable, §4.1). */
export function maxStakeUsd(env: AppDeps['env']): string {
  const micro = env.MAX_STAKE_MICRO ?? MAX_STAKE.toString();
  return formatUsd(micro).replace(/^\$/, '');
}

const lockKey = (userId: string) => sql`hashtextextended(${`yo:bets:user:${userId}`}, 0)`;

function betIdOr404(raw: string): string {
  if (!Uuid.safeParse(raw).success) throw new HttpError('NOT_FOUND', 'No such bet.');
  return raw;
}

export const betsRoutes: RouteModule = {
  name: 'bets',
  register(app, deps) {
    app.post('/v1/bets', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      deps.rateLimit?.take('bets', me.user_id, BETS_BUCKET);
      const body = await readBody(c, CreateBetRequest);
      const aId = me.user_id;
      const bId = body.opponent_user_id;
      const now = deps.now();

      if (bId === aId) {
        throw new HttpError('VALIDATION_FAILED', "You can't challenge yourself.", {
          issues: [{ path: 'opponent_user_id', message: 'must not be the caller' }],
          reason: 'self_challenge',
        });
      }

      const room = await getRoomOr404(deps.db, body.room_id);
      assertRoomLive(room, now);
      if (!(await isActiveMember(deps.db, room.id, aId))) {
        throw new HttpError('NOT_IN_ROOM', "You're not in this room.", { party: 'A' });
      }
      if (!(await isActiveMember(deps.db, room.id, bId))) {
        throw new HttpError('NOT_IN_ROOM', "They're not in this room.", { party: 'B' });
      }

      const people = await deps.db
        .select({
          id: users.id,
          age: users.age_attested_18plus,
          deleted_at: users.deleted_at,
        })
        .from(users)
        .where(inArray(users.id, [aId, bId]));
      for (const [id, party] of [
        [aId, 'A'],
        [bId, 'B'],
      ] as const) {
        const u = people.find((p) => p.id === id);
        if (!u || !u.age || u.deleted_at !== null) {
          throw new HttpError('AGE_REQUIRED', undefined, { party });
        }
      }

      if (body.challenge_method === 'face') {
        const v = verifyMatchTicket(body.match_ticket, {
          scanner_user_id: aId,
          candidate_user_id: bId,
          room_id: room.id,
          now_ms: now,
        });
        if (!v.ok) {
          throw new HttpError('VALIDATION_FAILED', 'That face match expired. Scan again.', {
            issues: [{ path: 'match_ticket', message: `match_ticket ${v.reason}` }],
            reason: 'match_ticket_invalid',
          });
        }
      }

      const refs = await loadUserRefs(deps.db, [aId, bId]);
      const refA = refs.get(aId)!;
      const refB = refs.get(bId)!;
      const betId = randomUUID(); // v4; = the onchain bet_id (SCHEMAS §1.2)
      const at = new Date(now);
      const requestId = c.get('requestId');

      const { row, invited, drafting } = await deps.db.transaction(async (tx) => {
        // Serialize per user (sorted, so two crossing challenges cannot deadlock): the
        // pair_busy and open-bet checks below are then race-free.
        for (const id of [aId, bId].sort()) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey(id)})`);
        }
        const [busy] = await tx
          .select({ id: bets.id, state: bets.state })
          .from(bets)
          .where(
            and(
              or(
                and(eq(bets.party_a_id, aId), eq(bets.party_b_id, bId)),
                and(eq(bets.party_a_id, bId), eq(bets.party_b_id, aId)),
              ),
              inArray(bets.state, [...PRE_LOCK_STATES]),
            ),
          )
          .limit(1);
        if (busy) {
          throw new HttpError('INVALID_STATE', 'You two already have a bet in progress.', {
            reason: 'pair_busy',
            bet_id: busy.id,
            state: busy.state,
          });
        }
        const [open] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(bets)
          .where(
            and(
              or(eq(bets.party_a_id, aId), eq(bets.party_b_id, aId)),
              inArray(bets.state, [...PRE_LOCK_STATES]),
            ),
          );
        if ((open?.n ?? 0) >= MAX_PRE_LOCK_BETS_PER_USER) {
          throw new HttpError(
            'RATE_LIMITED',
            'Finish one of your open bets first.',
            {
              bucket: 'bets/open',
              reason: 'too_many_open_bets',
              limit: MAX_PRE_LOCK_BETS_PER_USER,
            },
            { headers: { 'Retry-After': '60' } },
          );
        }

        await tx.insert(bets).values({
          id: betId,
          room_id: room.id,
          party_a_id: aId,
          party_b_id: bId,
          challenge_method: body.challenge_method,
          lock_mode: deps.env.LOCK_MODE,
          mint: deps.env.USDC_MINT ?? DEVNET_USDC_MINT,
          created_at: at,
        });

        if (body.voice_conversation_id) {
          await bindVoiceSession(tx, deps, {
            conversation_id: body.voice_conversation_id,
            bet_id: betId,
            user_id: aId,
            device_id: me.device_id,
          });
        }

        const invited = await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.invited',
          payload: { challenger: refA, room_id: room.id },
          now,
        });
        const drafting = await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: {
            state: 'DRAFTING',
            prev: null,
            onchain_status: null,
            chain_ack: 'none',
            pending_tx: null,
            reason: null,
          },
          now,
        });

        const push: ChallengeReceivedPush = {
          bet_id: betId,
          room_id: room.id,
          challenger: { user_id: aId, display_name: refA.display_name },
          title: `${refA.display_name} challenged you`,
          body: 'Tap to hear the terms.',
        };
        await tx.insert(outbox).values({
          recipient_user_id: bId,
          bet_id: betId,
          kind: 'challenge_received',
          payload: push,
          dedupe_key: `${betId}:challenge_received:${betId}:${bId}`,
          next_attempt_at: at,
        });

        await tx.insert(auditLog).values({
          actor_kind: 'user',
          actor_user_id: aId,
          action: 'bet.state_changed',
          bet_id: betId,
          subject_user_id: bId,
          request_id: requestId,
          details: { from: null, to: 'DRAFTING', challenge_method: body.challenge_method },
        });

        const [row] = await tx.select().from(bets).where(eq(bets.id, betId)).limit(1);
        return { row: row!, invited, drafting };
      });

      // After commit (fire-and-forget fan-out; clients resync over REST on a gap).
      deps.hub.publishToUser(bId, invited);
      deps.hub.publishBetEvent(invited, room.id);
      deps.hub.publishBetEvent(drafting, room.id);

      const out: CreateBetResponse = {
        bet: betSnapshot(row, { a: refA, b: refB }, aId),
        voice: {
          dynamic_variables: {
            bet_id: betId,
            party_a_name: refA.display_name,
            party_b_name: refB.display_name,
            max_stake_usd: maxStakeUsd(deps.env),
          },
        },
      };
      return c.json(out, 201);
    });

    app.post('/v1/bets/:bet_id/invite/accept', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const betId = betIdOr404(c.req.param('bet_id'));
      const { row, events } = await deps.db.transaction(async (tx) => {
        const bet = await lockBetAsB(tx, betId, me.user_id);
        // Idem: (bet_id, 'B') — one `accepted` per bet. A decline (which may follow an
        // accept) wins: accepting a declined bet is refused, never a no-op 200.
        const answers = await priorAnswers(tx, betId);
        if (answers.has('declined')) {
          throw new HttpError('INVALID_STATE', 'You already declined this challenge.', {
            state: bet.state,
            reason: 'already_declined',
          });
        }
        if (answers.has('accepted')) return { row: bet, events: [] };
        if (!INVITE_ACCEPTABLE.includes(bet.state)) {
          throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
        }
        const now = deps.now();
        const events = [
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'bet.invite_answered',
            payload: BetInviteAnsweredPayload.parse({ party: 'B', answer: 'accepted' }),
            now,
          }),
        ];
        // The voice judge already heard both say yes and was told to wait for this tap: tell it
        // B is in, or it stays silent until a human speaks (it only hears the room).
        if (
          bet.state === 'TERMS_PROPOSED' &&
          bet.terms_hash &&
          (await judgeAwaitsAccept(tx, betId, bet.terms_hash))
        ) {
          const nameB = (await loadUserRefs(tx, [bet.party_b_id])).get(bet.party_b_id)!;
          events.push(
            await appendBetEvent(tx, {
              bet_id: betId,
              type: 'judge.cue',
              payload: inviteAcceptedCue(nameB.display_name),
              now,
            }),
          );
        }
        const [row] = await tx.select().from(bets).where(eq(bets.id, betId)).limit(1);
        return { row: row!, events };
      });
      for (const e of events) deps.hub.publishBetEvent(e, row.room_id);
      const out: InviteAnswerResponse = { bet: await snapshotFor(deps, row, me.user_id) };
      return c.json(out, 200);
    });

    app.post('/v1/bets/:bet_id/invite/decline', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const betId = betIdOr404(c.req.param('bet_id'));
      const requestId = c.get('requestId');
      const { row, events, prev } = await deps.db.transaction(async (tx) => {
        const bet = await lockBetAsB(tx, betId, me.user_id);
        // Idempotent repeat: only when THIS route already declined it (B's answer is in the
        // log), not for a bet cancelled some other way.
        if (bet.state === 'CANCELLED' && (await priorAnswers(tx, betId)).has('declined')) {
          return { row: bet, events: [] as BetEventEnvelope[], prev: null };
        }
        if (!INVITE_DECLINABLE.includes(bet.state)) {
          throw new HttpError('INVALID_STATE', undefined, {
            state: bet.state,
            ...(bet.state === 'AWAITING_AUTHORIZATIONS' ? { reason: 'use_lock_decline' } : {}),
          });
        }
        const now = deps.now();
        // The versioned state write first; appendBetEvent's last_seq bump comes after.
        const updated = await tx
          .update(bets)
          .set({ state: 'CANCELLED', end_reason: 'declined' })
          .where(and(eq(bets.id, betId), eq(bets.version, bet.version)))
          .returning({ id: bets.id });
        if (updated.length !== 1)
          throw new HttpError('INVALID_STATE', undefined, { reason: 'raced' });

        const refs = await loadUserRefs(tx, [bet.party_b_id]);
        const nameB = refs.get(bet.party_b_id)!.display_name;
        const events: BetEventEnvelope[] = [];
        events.push(
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'bet.invite_answered',
            payload: BetInviteAnsweredPayload.parse({ party: 'B', answer: 'declined' }),
            now,
          }),
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'terms.declined',
            payload: { party: 'B' },
            now,
          }),
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'bet.state',
            payload: {
              state: 'CANCELLED',
              prev: bet.state,
              onchain_status: null,
              chain_ack: 'none',
              pending_tx: null,
              reason: 'declined',
            },
            now,
          }),
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'judge.cue',
            payload: declinedCue(nameB),
            now,
          }),
        );
        await tx.insert(auditLog).values({
          actor_kind: 'user',
          actor_user_id: me.user_id,
          action: 'bet.state_changed',
          bet_id: betId,
          subject_user_id: bet.party_a_id,
          request_id: requestId,
          details: { from: bet.state, to: 'CANCELLED', end_reason: 'declined' },
        });
        const [row] = await tx.select().from(bets).where(eq(bets.id, betId)).limit(1);
        return { row: row!, events, prev: bet.state };
      });
      for (const e of events) deps.hub.publishBetEvent(e, row.room_id);
      const out: InviteAnswerResponse = {
        bet: await snapshotFor(deps, row, me.user_id, prev),
      };
      return c.json(out, 200);
    });
  },
};

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];

/** Moved to ./invite (the lock's confirm step uses it too); re-exported for existing callers. */
export { priorAnswers } from './invite';

/** SELECT … FOR UPDATE the bet; 404 if unknown, 403 NOT_A_PARTY unless the caller is B. */
async function lockBetAsB(tx: Tx, betId: string, userId: string): Promise<BetRow> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update').limit(1);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  const party = partyOf(bet, userId);
  if (party !== 'B') {
    throw new HttpError(
      'NOT_A_PARTY',
      party === 'A' ? 'Only the challenged player can answer.' : "You're not in this bet.",
      { required: 'B', you: party },
    );
  }
  return bet;
}

async function snapshotFor(
  deps: AppDeps,
  row: BetRow,
  viewer: string,
  prev: BetState | null = null,
) {
  const refs = await loadUserRefs(deps.db, [row.party_a_id, row.party_b_id]);
  return betSnapshot(row, { a: refs.get(row.party_a_id)!, b: refs.get(row.party_b_id)! }, viewer, {
    prev_state: prev,
  });
}

/**
 * §2.5 "The voice session is bound: voice_sessions(el_conversation_id → bet_id)".
 * The conversation must be A's own, active and not bound to another bet. POST /v1/voice/tokens
 * (§2.6) now stores the row at mint time, but minting needs the ElevenLabs key (PENDING-KEY), so
 * until the key exists an unknown id still creates a bound row here. Once tokens mint for real,
 * make an unknown id a 422 (it lets a caller squat a conversation id).
 */
async function bindVoiceSession(
  tx: Tx,
  deps: AppDeps,
  v: { conversation_id: string; bet_id: string; user_id: string; device_id: string },
): Promise<void> {
  const [s] = await tx
    .select()
    .from(voiceSessions)
    .where(eq(voiceSessions.el_conversation_id, v.conversation_id))
    .for('update')
    .limit(1);
  const refuse = (why: string): never => {
    throw new HttpError('VALIDATION_FAILED', "That voice session can't be used for this bet.", {
      issues: [{ path: 'voice_conversation_id', message: why }],
      reason: 'voice_session_unavailable',
    });
  };
  if (!s) {
    // FOR UPDATE cannot lock a row that does not exist yet: two concurrent challenges with
    // the same new id both get here. ON CONFLICT turns the loser into a 422, not a 500.
    const inserted = await tx
      .insert(voiceSessions)
      .values({
        bet_id: v.bet_id,
        user_id: v.user_id,
        device_id: v.device_id,
        purpose: 'terms',
        // PENDING-KEY: the real agent id comes with the token mint (§2.6).
        el_agent_id: deps.env.ELEVENLABS_AGENT_ID ?? 'unconfigured',
        el_conversation_id: v.conversation_id,
      })
      .onConflictDoNothing({ target: voiceSessions.el_conversation_id })
      .returning({ id: voiceSessions.id });
    if (inserted.length === 0) refuse('already bound to another bet');
    return;
  }
  if (s.user_id !== v.user_id) refuse('belongs to another user');
  if (s.status !== 'active') refuse(`session is ${s.status}`);
  if (s.bet_id !== null && s.bet_id !== v.bet_id) refuse('already bound to another bet');
  await tx
    .update(voiceSessions)
    .set({ bet_id: v.bet_id, device_id: s.device_id ?? v.device_id })
    .where(eq(voiceSessions.id, s.id));
}
