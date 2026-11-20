// Challenges: create one, answer the invite, ask for a rematch.
// Spec: docs/planning/API-CONTRACT.md §2.5.
//
//   POST /v1/bets                         (S)      -> 201 {bet: BetSnapshot (DRAFTING), voice}
//   POST /v1/bets/:bet_id/invite/accept   (S, B)   -> 200 {bet}
//       bet.invite_answered accepted, state unchanged (+ judge.cue INVITE_ACCEPTED if the voice
//       judge was told to wait for it: ./invite.ts)
//   POST /v1/bets/:bet_id/invite/decline  (S, B)   -> 200 {bet}
//       CANCELLED (declined); judge.cue DECLINED
//   POST /v1/bets/:bet_id/rematch         (S, A|B) -> 201 {bet_id, suggested_stake_usd, bet, voice}
//       double or nothing: a new DRAFTING bet, caller = A, supersedes_bet_id = this bet
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { auditLog, bets, outbox, users, voiceSessions } from '@youre-on/db';
import {
  BetInviteAnsweredPayload,
  CreateBetRequest,
  RematchRequest,
  rivalryOf,
  suggestedRematchStakeUsd,
  type ChallengeMethod,
  type ChallengeReceivedPush,
  type CreateBetResponse,
  type InviteAnswerResponse,
  type RematchResponse,
} from '@youre-on/shared/api';
import { USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { formatUsd } from '@youre-on/shared/money';
import { Uuid, type UserRef } from '@youre-on/shared/primitives';
import type { BetState } from '@youre-on/shared/bet-state';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { demoRoomError, isDemoRoom, nonDemoPlayers } from '../demo/players';
import { headToHead } from '../face/service';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { assertRoomLive, getRoomOr404, isActiveMember, isLobbyRoom } from '../rooms/service';
import { declinedCue, inviteAcceptedCue } from './cues';
import { judgeAwaitsAccept, priorAnswers } from './invite';
import { verifyMatchTicket } from './match-ticket';
import { betSnapshot, loadUserRefs, partyOf, type BetRow } from './snapshot';

/** Circle devnet USDC (the packages/shared pin), used when USDC_MINT is unset. */
export const DEVNET_USDC_MINT = USDC_MINT_DEVNET;

/** States before the lock lands: a pair may have at most one bet here (`pair_busy`). */
export const PRE_LOCK_STATES = [
  'DRAFTING',
  'TERMS_PROPOSED',
  'AWAITING_AUTHORIZATIONS',
  'AWAITING_LOCK',
] as const satisfies readonly BetState[];

/** POST /v1/bets: 6/min per user, and ≤ 3 pre-lock bets per user. */
export const BETS_BUCKET = { limit: 6, windowMs: 60_000 } as const;
export const MAX_PRE_LOCK_BETS_PER_USER = 3;

/** A rematch (double or nothing) follows a bet that is over. */
export const REMATCH_FROM = [
  'PAID',
  'VOIDED',
  'FINALIZED',
  'EXPIRED',
] as const satisfies readonly BetState[];
/** The rematch stake suggestion when the old bet never had stakes (dollars per side). */
const REMATCH_DEFAULT_STAKE_USD = 5;

/** B may decline through the invite only here; later through lock/decline. */
const INVITE_DECLINABLE: readonly BetState[] = ['DRAFTING', 'TERMS_PROPOSED'];
/** B may accept until the lock is in flight; the terms confirm waits for it (./invite.ts). */
const INVITE_ACCEPTABLE: readonly BetState[] = [
  'DRAFTING',
  'TERMS_PROPOSED',
  'AWAITING_AUTHORIZATIONS',
];

/** "20000000" -> "20" (the voice agent's `max_stake_usd` dynamic variable). */
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

      const { row, refA, refB } = await createChallenge(deps, {
        aId,
        bId,
        deviceId: me.device_id,
        roomId: body.room_id,
        challengeMethod: body.challenge_method,
        voiceConversationId: body.voice_conversation_id ?? null,
        requestId: c.get('requestId'),
        now,
        // a callback, so it runs after the room, membership and age checks
        verify: () => {
          if (body.challenge_method !== 'face') return;
          const v = verifyMatchTicket(
            body.match_ticket,
            { scanner_user_id: aId, candidate_user_id: bId, room_id: body.room_id, now_ms: now },
            deps.env,
          );
          if (!v.ok) {
            throw new HttpError('VALIDATION_FAILED', 'That face match expired. Scan again.', {
              issues: [{ path: 'match_ticket', message: `match_ticket ${v.reason}` }],
              reason: 'match_ticket_invalid',
            });
          }
        },
      });
      const betId = row.id;

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

    // Double or nothing (every bet type): either party of a finished bet challenges the other
    // again in the same room, as A. The new bet is a normal DRAFTING challenge (any bet type on
    // the negotiate screen); bet.invited carries rematch_of and the stake chip's default, 2 x the
    // old per-side stake capped at max_stake. A repeat by the same caller while that rematch is
    // still pre-lock answers it again (201, same bet).
    app.post('/v1/bets/:bet_id/rematch', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      deps.rateLimit?.take('bets', me.user_id, BETS_BUCKET);
      const oldId = betIdOr404(c.req.param('bet_id'));
      await readBody(c, RematchRequest);
      const [old] = await deps.db.select().from(bets).where(eq(bets.id, oldId)).limit(1);
      if (!old) throw new HttpError('NOT_FOUND', 'No such bet.');
      const party = partyOf(old, me.user_id);
      if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
      if (!(REMATCH_FROM as readonly BetState[]).includes(old.state))
        throw new HttpError('INVALID_STATE', 'Finish this bet first.', {
          state: old.state,
          reason: 'not_finished',
        });
      // Seed rows (demo head-to-head history) are replaced wholesale by the seeder.
      if (old.is_seed || !old.room_id)
        throw new HttpError('INVALID_STATE', "This bet can't be rematched.", {
          state: old.state,
          reason: 'no_rematch',
        });
      const opponent = party === 'A' ? old.party_b_id : old.party_a_id;
      const maxStake = deps.env.MAX_STAKE_MICRO ? BigInt(deps.env.MAX_STAKE_MICRO) : MAX_STAKE;
      const suggested =
        old.stake_a !== null && old.stake_b !== null
          ? suggestedRematchStakeUsd(
              { a: old.stake_a.toString(), b: old.stake_b.toString() },
              maxStake,
            )
          : 0;
      const suggestedUsd = suggested > 0 ? suggested : REMATCH_DEFAULT_STAKE_USD;

      const respond = (row: BetRow, refA: UserRef, refB: UserRef) => {
        const out: RematchResponse & CreateBetResponse = {
          bet_id: row.id,
          suggested_stake_usd: suggestedUsd,
          bet: betSnapshot(row, { a: refA, b: refB }, me.user_id),
          voice: {
            dynamic_variables: {
              bet_id: row.id,
              party_a_name: refA.display_name,
              party_b_name: refB.display_name,
              max_stake_usd: maxStakeUsd(deps.env),
            },
          },
        };
        return c.json(out, 201);
      };

      // A repeat of the same rematch (a lost 201): the caller's pre-lock bet that follows this one.
      const [again] = await deps.db
        .select()
        .from(bets)
        .where(
          and(
            eq(bets.supersedes_bet_id, old.id),
            eq(bets.party_a_id, me.user_id),
            inArray(bets.state, [...PRE_LOCK_STATES]),
          ),
        )
        .limit(1);
      if (again) {
        const refs = await loadUserRefs(deps.db, [again.party_a_id, again.party_b_id]);
        return respond(again, refs.get(again.party_a_id)!, refs.get(again.party_b_id)!);
      }

      const { row, refA, refB } = await createChallenge(deps, {
        aId: me.user_id,
        bId: opponent,
        deviceId: me.device_id,
        roomId: old.room_id,
        // the pair already know each other: a pick from the list, no face ticket
        challengeMethod: 'list',
        voiceConversationId: null,
        requestId: c.get('requestId'),
        now: deps.now(),
        rematch: { of: old.id, suggested_stake_usd: suggestedUsd },
      });
      return respond(row, refA, refB);
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
        // The versioned state write first: appendBetEvent's last_seq bump also bumps bets.version.
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

export interface ChallengeInput {
  /** The challenger (A) and the challenged (B). */
  aId: string;
  bId: string;
  /** A's device (the voice session binding). */
  deviceId: string;
  roomId: string;
  challengeMethod: ChallengeMethod;
  voiceConversationId: string | null;
  requestId: string;
  now: number;
  /** Extra checks after the room, membership and age checks (POST /v1/bets: the face ticket). */
  verify?: () => void;
  /** Double or nothing: the finished bet this one follows (supersedes_bet_id). */
  rematch?: { of: string; suggested_stake_usd: number };
}

/**
 * The challenge itself, shared by POST /v1/bets and POST /v1/bets/:id/rematch: the room
 * and both players checked, then ONE transaction (serialized per user: pair_busy and the open-bet
 * cap are race-free) writes the bets row, the voice binding, bet.invited (seq 1) + bet.state
 * DRAFTING (seq 2), the outbox push to B and an audit row; after commit bet.invited goes to B's
 * user channel and the bet channel / room stage, bet.state to the bet channel.
 */
export async function createChallenge(
  deps: AppDeps,
  i: ChallengeInput,
): Promise<{ row: BetRow; refA: UserRef; refB: UserRef }> {
  const { aId, bId, now } = i;
  const room = await getRoomOr404(deps.db, i.roomId);
  assertRoomLive(room, now);
  if (!(await isActiveMember(deps.db, room.id, aId))) {
    throw new HttpError('NOT_IN_ROOM', "You're not in this room.", { party: 'A' });
  }
  if (!(await isActiveMember(deps.db, room.id, bId))) {
    throw new HttpError('NOT_IN_ROOM', "They're not in this room.", { party: 'B' });
  }
  // DEMO_MODE: the demo room (on the projector) is for the demo players, also for a member
  // who joined before the stage opened (demo/players.ts).
  if (await isDemoRoom(deps, room)) {
    const outsider = (await nonDemoPlayers(deps, [aId, bId]))[0];
    if (outsider)
      throw demoRoomError('Only the demo players bet in this room.', {
        party: outsider === aId ? 'A' : 'B',
      });
  }
  // DEMO_MODE, the shared lobby: the demo phones auto-join it too, so a stranger there could
  // challenge demo B (a tap or a face scan) and park B's phone on that bet mid-demo. No bet in
  // the lobby between a demo player and anyone else; strangers still bet with each other.
  if (deps.env.DEMO_MODE && isLobbyRoom(room)) {
    const outsiders = await nonDemoPlayers(deps, [aId, bId]);
    if (outsiders.length === 1)
      throw demoRoomError('The demo players are busy right now.', {
        party: outsiders[0] === aId ? 'A' : 'B',
      });
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
  i.verify?.();

  // The pair's record before this bet, A's view, for the stage's rivalry line (outside the
  // transaction: a bet settling concurrently only shifts a display line).
  const rivalry = rivalryOf(await headToHead(deps.db, aId, bId), i.challengeMethod);
  const refs = await loadUserRefs(deps.db, [aId, bId]);
  const refA = refs.get(aId)!;
  const refB = refs.get(bId)!;
  const betId = randomUUID(); // v4; also the onchain bet_id
  const at = new Date(now);

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
      challenge_method: i.challengeMethod,
      lock_mode: deps.env.LOCK_MODE,
      mint: deps.env.USDC_MINT ?? DEVNET_USDC_MINT,
      supersedes_bet_id: i.rematch?.of ?? null,
      created_at: at,
    });

    if (i.voiceConversationId) {
      await bindVoiceSession(tx, deps, {
        conversation_id: i.voiceConversationId,
        bet_id: betId,
        user_id: aId,
        device_id: i.deviceId,
      });
    }

    const invited = await appendBetEvent(tx, {
      bet_id: betId,
      type: 'bet.invited',
      payload: {
        challenger: refA,
        room_id: room.id,
        rivalry,
        ...(i.rematch
          ? { rematch_of: i.rematch.of, suggested_stake_usd: i.rematch.suggested_stake_usd }
          : {}),
      },
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

    const push: ChallengeReceivedPush = i.rematch
      ? {
          bet_id: betId,
          room_id: room.id,
          challenger: { user_id: aId, display_name: refA.display_name },
          title: `${refA.display_name} wants a rematch`,
          body: 'Double or nothing?',
        }
      : {
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
      request_id: i.requestId,
      details: {
        from: null,
        to: 'DRAFTING',
        challenge_method: i.challengeMethod,
        ...(i.rematch ? { rematch_of: i.rematch.of } : {}),
      },
    });

    const [row] = await tx.select().from(bets).where(eq(bets.id, betId)).limit(1);
    return { row: row!, invited, drafting };
  });

  // After commit (fire-and-forget fan-out; clients resync over REST on a gap).
  deps.hub.publishToUser(bId, invited);
  deps.hub.publishBetEvent(invited, room.id);
  deps.hub.publishBetEvent(drafting, room.id);
  return { row, refA, refB };
}

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
 * Binds the voice session to the bet: voice_sessions(el_conversation_id → bet_id). The
 * conversation must be A's own, active and not bound to another bet. POST /v1/voice/tokens
 * stores the row at mint time, but minting needs the ElevenLabs key, so until the key exists an
 * unknown id still creates a bound row here. Once tokens mint for real, make an unknown id a 422
 * (it lets a caller squat a conversation id).
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
        // The real agent id comes with the token mint (POST /v1/voice/tokens).
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
  // The post-call webhook (voice/post-call.ts) sets ended_at; an unbound pre-mint row keeps
  // status 'active' (voice_sessions_bet_bound), so the end shows only here.
  if (s.ended_at !== null) refuse('session has ended');
  if (s.bet_id !== null && s.bet_id !== v.bet_id) refuse('already bound to another bet');
  await tx
    .update(voiceSessions)
    .set({ bet_id: v.bet_id, device_id: s.device_id ?? v.device_id })
    .where(eq(voiceSessions.id, s.id));
}
