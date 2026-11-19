// "Call it off" (API-CONTRACT §2.9a, packages/shared/src/call-off.ts): a mutual stop of a locked
// bet whose round can't happen, so neither phone sits on the attempt screens until
// resolve_deadline (lock + 3600 s, then the keeper's timeout_refund).
//
//   POST /v1/bets/:bet_id/call-off {agree, answer?}   (S, party) -> 200 CallOffResponse
//     agree:true, nothing open        opens a request (bet.call_off requested, expires in 60 s)
//     agree:true, mine open           idempotent: the same open request
//     agree:true, theirs open         both agreed: the VOID ruling (below)
//     agree:true, answer:true         the prompt's Agree: theirs open (or lapsed less than
//                                     CALL_OFF_ANSWER_GRACE_MS ago) -> the VOID ruling; else
//                                     'none', and never a new request in this party's name
//     agree:false, open (either side) clears it (bet.call_off cleared); nothing open: 'none'
//   POST /v1/demo/bets/:bet_id/void          (demo key, DEMO_MODE) -> 200 CallOffResponse
//     the operator's fallback: the same VOID ruling at once, no player asked.
//
// Allowed only while no ruling is in flight or issued for the bet's current attempt: LOCKED (no
// attempt yet), ATTEMPT with its attempt still 'recording' (nothing uploaded), or JUDGING right
// after a REDO (the next attempt not started; a REDO never goes onchain). Anything else is
// 409 INVALID_STATE {reason: 'ruling_in_flight' | 'too_late'}: a call-off can never escape a
// decisive ruling or one being made. The check and the write happen under the bet's row lock,
// as every attempt / upload transaction takes it, so whichever commits first wins.
//
// The VOID goes through the existing ruling machinery: one commit with the `rulings` row
// (stage 'attempt', model CALLED_OFF_MODEL, VOID 'safety_stop', no frames, evidence_hash =
// hashJcs(CallOffRecord) with the record in evidence_canonical), the attempt 'ruled' (the
// recording one, or, from LOCKED / after a REDO, a new attempt row that never recorded: the
// rulings_attempt_stage CHECK wants one), bet -> JUDGING, bet.call_off agreed + ruling.issued +
// judge.cue VOIDED, an audit row; then deps.onRuling (resolve(Refund)), and the keeper's
// resolve-due retries it if that fails. RULED, the appeal window, finalize and VOIDED follow as
// for any VOID. A repeat after the VOID answers 'agreed' with the same ruling_hash.
//
// The request is not a table: it is the latest 'bet.call_off' row of bet_events (append-only).
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { attempts, auditLog, betEvents, bets, rulings } from '@youre-on/db';
import {
  CALL_OFF_ANSWER_GRACE_MS,
  CALL_OFF_TTL_MS,
  CALLED_OFF_REASON,
  CallOffPayload,
  CallOffRecord,
  CallOffRequest,
  OPERATOR_VOID_REASON,
  type CallOffActor,
  type CallOffResponse,
} from '@youre-on/shared/call-off';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import type { Party } from '@youre-on/shared/primitives';
import { CALLED_OFF_MODEL, Ruling } from '@youre-on/shared/ruling';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { judgeCue, type JudgeCue } from '../bets/cues';
import { chainAckOf, partyOf, toOnchainStatus, type BetRow } from '../bets/snapshot';
import { requireDemo } from '../demo/routes';
import { betIdParam } from '../lock/routes';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';

/** Per (bet, user): a request, a decline and an agree are three; a mashed button is not ten. */
export const CALL_OFF_BUCKET = { limit: 6, windowMs: 60_000 } as const;

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];
type AttemptRow = typeof attempts.$inferSelect;

/** Where the bet's current attempt stands, for a call-off: one to rule, or the number of a new one. */
type Callable = { kind: 'open'; attempt: AttemptRow } | { kind: 'new'; attempt_no: number };

/** The VOIDED cue a call-off sends (A's phone hands it to the voice judge; the stage reads it). */
export function calledOffCue(by: CallOffActor): JudgeCue {
  return judgeCue(
    'VOIDED',
    { reason: 'safety_stop', why: by === 'operator' ? 'operator' : 'called_off' },
    by === 'operator'
      ? 'Say the round is called off, so nobody wins and both stakes go back.'
      : 'Say both players called it off, so nobody wins and both stakes go back.',
  );
}

async function lockBet(tx: Tx, betId: string): Promise<BetRow> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update').limit(1);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  return bet;
}

/** The bet's newest ruling, if any (rulings_bet_idx). */
async function latestRuling(tx: Pick<Tx, 'select'>, betId: string) {
  const [r] = await tx
    .select({ model: rulings.model, ruling_hash: rulings.ruling_hash })
    .from(rulings)
    .where(eq(rulings.bet_id, betId))
    .orderBy(desc(rulings.created_at))
    .limit(1);
  return r ?? null;
}

/** The latest bet.call_off payload (the open request, if it is still open). */
async function latestCallOff(
  tx: Pick<Tx, 'select'>,
  betId: string,
): Promise<CallOffPayload | null> {
  const [row] = await tx
    .select({ envelope: betEvents.envelope })
    .from(betEvents)
    .where(and(eq(betEvents.bet_id, betId), eq(betEvents.type, 'bet.call_off')))
    .orderBy(desc(betEvents.seq))
    .limit(1);
  if (!row) return null;
  const p = CallOffPayload.safeParse((row.envelope as { payload?: unknown }).payload);
  return p.success ? p.data : null;
}

/**
 * Is the bet in a state a call-off may stop (under the row lock)? Throws 409 otherwise:
 * `ruling_in_flight` while frames / a round are being judged, `too_late` once a ruling is out.
 */
async function callableAttempt(tx: Tx, bet: BetRow): Promise<Callable> {
  const [latest] = await tx
    .select()
    .from(attempts)
    .where(eq(attempts.bet_id, bet.id))
    .orderBy(desc(attempts.attempt_no))
    .limit(1);
  if (bet.state === 'LOCKED' && !latest) return { kind: 'new', attempt_no: 1 };
  if (bet.state === 'ATTEMPT' && latest?.status === 'recording')
    return { kind: 'open', attempt: latest };
  if (bet.state === 'JUDGING' && latest?.status === 'redo')
    return { kind: 'new', attempt_no: latest.attempt_no + 1 };
  const inFlight = bet.state === 'ATTEMPT' || bet.state === 'JUDGING' || bet.state === 'HEARING';
  throw new HttpError('INVALID_STATE', "It can't be called off now.", {
    state: bet.state,
    reason: inFlight ? 'ruling_in_flight' : 'too_late',
  });
}

interface Voided {
  ruling: Ruling;
  ruling_hash: string;
  events: BetEventEnvelope[];
  room_id: string | null;
}

/**
 * The VOID ruling of a call-off, in the caller's transaction (the bet row already locked and
 * checked callable). `requested` is who asked first (and when); `agreedBy` completes it now.
 */
async function commitVoid(
  deps: AppDeps,
  tx: Tx,
  bet: BetRow,
  at: Callable,
  o: {
    requested_by: CallOffActor;
    requested_at: number;
    agreed_by: CallOffActor;
    /** The user who completed it (a new attempt row's recorded_by_user_id). */
    user_id: string | null;
    request_id: string | undefined;
  },
): Promise<Voided> {
  if (!bet.terms_hash) throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
  const now = deps.now();
  const attemptNo = at.kind === 'open' ? at.attempt.attempt_no : at.attempt_no;
  const record = CallOffRecord.parse({
    schema_version: 1,
    kind: 'call_off',
    bet_id: bet.id,
    terms_hash: bet.terms_hash,
    attempt_no: attemptNo,
    requested_by: o.requested_by,
    requested_at: new Date(o.requested_at).toISOString(),
    agreed_by: o.agreed_by,
    agreed_at: new Date(now).toISOString(),
  });
  const evidenceCanonical = jcs(record);
  const ruling = Ruling.parse({
    schema_version: 1,
    ruling_id: randomUUID(),
    bet_id: bet.id,
    stage: 'attempt',
    attempt_no: attemptNo,
    outcome: 'VOID',
    claim_result: 'UNCLEAR',
    redo_reason: null,
    void_reason: 'safety_stop',
    confidence: 1,
    reason: o.agreed_by === 'operator' ? OPERATOR_VOID_REASON : CALLED_OFF_REASON,
    cited_frames: [],
    frame_hashes: [],
    model: CALLED_OFF_MODEL,
    evidence_hash: hashJcs(record),
    terms_hash: bet.terms_hash,
    created_at: new Date(now).toISOString(),
  });
  const canonical = jcs(ruling);
  const hash = hashJcs(ruling);

  // The attempt the ruling belongs to (rulings_attempt_stage): the one still recording, or a new
  // row that never recorded (no device, nothing uploaded), 'ruled' at once.
  let attemptId: string;
  if (at.kind === 'open') {
    attemptId = at.attempt.id;
    await tx.update(attempts).set({ status: 'ruled' }).where(eq(attempts.id, attemptId));
  } else {
    const [a] = await tx
      .insert(attempts)
      .values({
        bet_id: bet.id,
        attempt_no: attemptNo,
        recorded_by_user_id: o.user_id ?? bet.party_a_id,
        recorded_by_device_id: null,
        recorder: 'self',
        status: 'ruled',
        max_ms: 1,
        go_at: new Date(now),
        started_at: new Date(now),
      })
      .returning({ id: attempts.id });
    attemptId = a!.id;
  }
  await tx.insert(rulings).values({
    id: ruling.ruling_id,
    bet_id: bet.id,
    stage: 'attempt',
    attempt_id: attemptId,
    model: ruling.model,
    outcome: ruling.outcome,
    claim_result: ruling.claim_result,
    redo_reason: null,
    void_reason: ruling.void_reason,
    confidence: ruling.confidence.toFixed(2),
    reason: ruling.reason,
    cited_frames: [],
    frame_hashes: [],
    // no pg enum change (as a dance round): the record is the CallOffRecord JCS, and
    // sha256(evidence_canonical) = evidence_hash (rulings_evidence_canonical CHECK)
    evidence_kind: 'camera',
    evidence_hash: ruling.evidence_hash,
    evidence_canonical: evidenceCanonical,
    record_canonical: canonical,
    ruling_hash: hash,
    latency_ms: 0,
    created_at: new Date(ruling.created_at),
  });
  // JUDGING, as after any upload: the payout stream resolves from there (and the keeper's
  // resolve-due finds a JUDGING bet whose latest ruling is VOID if that send fails).
  const prev = bet.state;
  if (prev !== 'JUDGING') {
    const updated = await tx
      .update(bets)
      .set({ state: 'JUDGING' })
      .where(and(eq(bets.id, bet.id), eq(bets.version, bet.version)))
      .returning({ id: bets.id });
    if (updated.length !== 1) throw new HttpError('INVALID_STATE', undefined, { reason: 'raced' });
  }
  const events: BetEventEnvelope[] = [];
  if (prev !== 'JUDGING') {
    events.push(
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'bet.state',
        payload: {
          state: 'JUDGING',
          prev,
          onchain_status: toOnchainStatus(bet.onchain_status),
          chain_ack: chainAckOf(bet),
          pending_tx: null,
          reason: 'called_off',
        },
        now,
      }),
    );
  }
  events.push(
    await appendBetEvent(tx, {
      bet_id: bet.id,
      type: 'bet.call_off',
      payload: { status: 'agreed', by: o.agreed_by, expires_at: null },
      now,
    }),
    await appendBetEvent(tx, {
      bet_id: bet.id,
      type: 'ruling.issued',
      payload: { ruling, ruling_hash: hash },
      now,
    }),
    await appendBetEvent(tx, {
      bet_id: bet.id,
      type: 'judge.cue',
      payload: calledOffCue(o.agreed_by),
      now,
    }),
  );
  await tx.insert(auditLog).values({
    actor_kind: o.agreed_by === 'operator' ? 'system' : 'user',
    actor_user_id: o.user_id,
    action: 'ruling.issued',
    bet_id: bet.id,
    request_id: o.request_id,
    details: {
      ruling_id: ruling.ruling_id,
      ruling_hash: hash,
      outcome: ruling.outcome,
      attempt_no: attemptNo,
      model: ruling.model,
      called_off: { requested_by: o.requested_by, agreed_by: o.agreed_by, from: prev },
    },
  });
  return { ruling, ruling_hash: hash, events, room_id: bet.room_id };
}

/** After the commit: fan out, then resolve (Refund) like any ruling. Never throws. */
async function afterVoid(deps: AppDeps, betId: string, v: Voided): Promise<void> {
  for (const e of v.events) deps.hub.publishBetEvent(e, v.room_id);
  deps.log.info('judge.called_off', { bet_id: betId, ruling_hash: v.ruling_hash });
  if (!deps.onRuling) return;
  try {
    await deps.onRuling(betId, v.ruling);
  } catch (e) {
    // The keeper's resolve-due retries a JUDGING bet whose latest ruling is VOID.
    deps.log.error('judge.on_ruling_failed', { bet_id: betId, err: String(e) });
  }
}

const agreedResponse = (ruling_hash: string): CallOffResponse => ({
  status: 'agreed',
  expires_at: null,
  ruling_hash,
});

/** A party's call-off step (the route's body). */
export async function callOff(
  deps: AppDeps,
  betId: string,
  me: { user_id: string },
  body: { agree: boolean; answer?: boolean | undefined },
  requestId?: string,
): Promise<CallOffResponse> {
  const { agree } = body;
  const answer = agree && body.answer === true;
  const [bet0] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
  if (!bet0) throw new HttpError('NOT_FOUND', 'No such bet.');
  const party: Party | null = partyOf(bet0, me.user_id);
  if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
  // Taken only for a party: a stranger's 403 spends nothing.
  deps.rateLimit?.take('call-off', `${betId}:${me.user_id}`, CALL_OFF_BUCKET);

  // Set inside the transaction (a holder: TS does not track assignments made in a callback).
  const done: { voided: Voided | null } = { voided: null };
  const out = await deps.db.transaction(
    async (
      tx,
    ): Promise<{
      res: CallOffResponse;
      events: BetEventEnvelope[];
      room_id: string | null;
    }> => {
      const bet = await lockBet(tx, betId);
      // Idempotent after the fact: the call-off already ruled -> the same answer.
      const last = await latestRuling(tx, bet.id);
      if (last?.model === CALLED_OFF_MODEL)
        return { res: agreedResponse(last.ruling_hash), events: [], room_id: null };
      const now = deps.now();
      const open = await openRequest(tx, bet.id, now);
      if (!agree) {
        // Declining (the other party) or withdrawing (mine) is always allowed while one is open.
        if (!open)
          return {
            res: { status: 'none', expires_at: null, ruling_hash: null },
            events: [],
            room_id: null,
          };
        const e = await appendBetEvent(tx, {
          bet_id: bet.id,
          type: 'bet.call_off',
          payload: { status: 'cleared', by: party, expires_at: null },
          now,
        });
        return {
          res: { status: 'cleared', expires_at: null, ruling_hash: null },
          events: [e],
          room_id: bet.room_id,
        };
      }
      const at = await callableAttempt(tx, bet);
      // The prompt's Agree (`answer`) only ever completes the other party's request. Tapped in
      // the prompt's last second it can land just past expires_at, so it is taken for a short
      // grace; later (or withdrawn, or never asked) it is 'none', not a request of its own.
      const theirs = answer ? await openRequest(tx, bet.id, now - CALL_OFF_ANSWER_GRACE_MS) : open;
      if (answer && (!theirs || theirs.payload.by === party))
        return {
          res: { status: 'none', expires_at: null, ruling_hash: null },
          events: [],
          room_id: null,
        };
      if (theirs && theirs.payload.by === party)
        return {
          res: { status: 'requested', expires_at: theirs.payload.expires_at, ruling_hash: null },
          events: [],
          room_id: null,
        };
      if (theirs) {
        const voided = await commitVoid(deps, tx, bet, at, {
          requested_by: theirs.payload.by,
          requested_at: theirs.at,
          agreed_by: party,
          user_id: me.user_id,
          request_id: requestId,
        });
        done.voided = voided;
        return { res: agreedResponse(voided.ruling_hash), events: [], room_id: null };
      }
      const expires = new Date(now + CALL_OFF_TTL_MS).toISOString();
      const e = await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'bet.call_off',
        payload: { status: 'requested', by: party, expires_at: expires },
        now,
      });
      await tx.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: me.user_id,
        action: 'bet.call_off_requested',
        bet_id: bet.id,
        request_id: requestId,
        details: { party, state: bet.state, expires_at: expires },
      });
      return {
        res: { status: 'requested', expires_at: expires, ruling_hash: null },
        events: [e],
        room_id: bet.room_id,
      };
    },
  );
  for (const e of out.events) deps.hub.publishBetEvent(e, out.room_id);
  if (done.voided) await afterVoid(deps, betId, done.voided);
  return out.res;
}

/** The open request (latest bet.call_off 'requested', not yet expired) and when it was made. */
async function openRequest(
  tx: Pick<Tx, 'select'>,
  betId: string,
  nowMs: number,
): Promise<{ payload: CallOffPayload & { by: Party }; at: number } | null> {
  const p = await latestCallOff(tx, betId);
  if (!p || p.status !== 'requested' || p.expires_at === null || p.by === 'operator') return null;
  const expires = Date.parse(p.expires_at);
  if (!(expires > nowMs)) return null;
  return { payload: { ...p, by: p.by }, at: expires - CALL_OFF_TTL_MS };
}

/** The operator's demo void: the same VOID ruling at once, for a LOCKED / ATTEMPT bet. */
export async function operatorVoid(
  deps: AppDeps,
  betId: string,
  requestId?: string,
): Promise<CallOffResponse> {
  const done: { voided: Voided | null } = { voided: null };
  const res = await deps.db.transaction(async (tx): Promise<CallOffResponse> => {
    const bet = await lockBet(tx, betId);
    const last = await latestRuling(tx, bet.id);
    if (last?.model === CALLED_OFF_MODEL) return agreedResponse(last.ruling_hash);
    const at = await callableAttempt(tx, bet);
    const now = deps.now();
    done.voided = await commitVoid(deps, tx, bet, at, {
      requested_by: 'operator',
      requested_at: now,
      agreed_by: 'operator',
      user_id: null,
      request_id: requestId,
    });
    return agreedResponse(done.voided.ruling_hash);
  });
  if (done.voided) await afterVoid(deps, betId, done.voided);
  return res;
}

export const callOffRoutes: RouteModule = {
  name: 'call-off',
  register(app, deps) {
    app.post('/v1/bets/:bet_id/call-off', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const betId = betIdParam(c.req.param('bet_id') ?? '');
      const body = await readBody(c, CallOffRequest);
      return c.json(await callOff(deps, betId, me, body, c.get('requestId')), 200);
    });

    app.post('/v1/demo/bets/:bet_id/void', requireDemo, async (c) => {
      const betId = betIdParam(c.req.param('bet_id') ?? '');
      return c.json(await operatorVoid(deps, betId, c.get('requestId')), 200);
    });
  },
};
