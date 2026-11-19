// Face enrollment and room-scoped matching over Postgres (API-CONTRACT §2.2, §2.4; DATA-MODEL
// §5.3, §7.2, §10). The only code that reads or writes face_enrollments.
//
// Privacy rules this file keeps:
//  - Vectors never reach a log, an audit row, an error message or a response. Audit details
//    carry model names, dates and reasons only (audit_log also has a CHECK tripwire).
//  - The probe exists in this request's memory only, and is zero-filled when the match ends.
//    No confident match stores nothing; a match only bumps the matched row's day-truncated
//    last_used_at (retention).
//  - Candidates are the opted-in (status 'active'), current members of the caller's room with
//    the same model, never the caller, never anyone outside the room (DATA-MODEL §7.2). In the
//    shared lobby (rooms/lobby.ts), only the members who are around: online now, or seen within
//    LOBBY_RECENT_MS, most recently seen first, so a day of past visitors is never compared.
//  - Scores stay here. The response is a user + ticket, or null.
//  - Database errors are re-thrown without their message (Drizzle puts query parameters, i.e.
//    ciphertext, in it) so the app's error log never sees face bytes.
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { auditLog, faceEnrollments, roomMembers, users, type Db } from '@youre-on/db';
import {
  LOBBY_RECENT_MS,
  REQUEST_CLOCK_SKEW_MS,
  RIVAL_MIN_SETTLED,
  type HeadToHead,
} from '@youre-on/shared/api';
import {
  bytesToEmbedding,
  cosineSimilarity,
  decideMatch,
  embeddingProblem,
  embeddingToBytes,
  FACE_CONSENT_V1_SHA256,
  FACE_CONSENT_VERSION,
  FACE_MATCH_MAX_CANDIDATES,
  FACE_RETENTION,
  isAcceptedFaceModel,
  type FaceEnrollmentRequest,
  type FaceEnrollmentResponse,
  type FaceEnrollmentStatusResponse,
  type FaceMatchRequest,
  type FaceMatchResponse,
  type FaceModelRef,
  type ScoredCandidate,
} from '@youre-on/shared/face';
import { formatUsd } from '@youre-on/shared/money';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { userRefOf } from '../bets/snapshot';
import { assertRoomLive, getRoomOr404, isActiveMember, isLobbyRoom } from '../rooms/service';
import { faceConfigOf } from './config';
import { issueMatchTicket } from './ticket';
import { atRestAad, kekFor, openAtRest, openRequestEmbedding, sealAtRest } from './vault';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select' | 'execute'>;
type FaceDeps = Pick<AppDeps, 'db' | 'env' | 'log' | 'now'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const userLock = (userId: string) => sql`hashtextextended(${`yo:face:user:${userId}`}, 0)`;

/** Runs `f`; a non-HttpError (a DB error, whose message holds parameters) becomes INTERNAL. */
async function sanitized<T>(deps: Pick<AppDeps, 'log'>, op: string, f: () => Promise<T>) {
  try {
    return await f();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = pgCode(err);
    deps.log.error('face.db_error', { op, pg_code: code });
    throw new HttpError('INTERNAL');
  }
}

function pgCode(err: unknown): string | null {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
}

const modelOf = (r: {
  model_name: string;
  model_version: string;
  embedding_dim: number;
}): FaceModelRef => ({ name: r.model_name, version: r.model_version, dim: r.embedding_dim });

// ---- status -----------------------------------------------------------------------------

/** The caller's own enrollment, without vector data (GET /v1/face/enrollment). */
export async function enrollmentStatus(
  db: Pick<Db, 'select'>,
  userId: string,
): Promise<FaceEnrollmentStatusResponse> {
  const [r] = await db
    .select({
      status: faceEnrollments.status,
      consent_version: faceEnrollments.consent_version,
      model_name: faceEnrollments.model_name,
      model_version: faceEnrollments.model_version,
      embedding_dim: faceEnrollments.embedding_dim,
      created_at: faceEnrollments.created_at,
      disabled_at: faceEnrollments.disabled_at,
    })
    .from(faceEnrollments)
    .where(eq(faceEnrollments.user_id, userId))
    .limit(1);
  if (!r) {
    return {
      status: 'none',
      consent_version: null,
      model: null,
      enrolled_at: null,
      disabled_at: null,
    };
  }
  return {
    status: r.status,
    consent_version: r.consent_version,
    model: modelOf(r),
    enrolled_at: r.created_at.toISOString(),
    disabled_at: r.disabled_at?.toISOString() ?? null,
  };
}

// ---- enroll -----------------------------------------------------------------------------

/**
 * POST /v1/face/enrollment. Checks consent (current version, exact text hash, not in the future),
 * liveness after consent, the model, and the embedding; then, in one transaction: audit
 * `face.consented`, replace any old row with the newly encrypted one, audit `face.enrolled`.
 */
export async function enroll(
  deps: FaceDeps,
  userId: string,
  req: FaceEnrollmentRequest,
  requestId: string,
): Promise<FaceEnrollmentResponse> {
  const cfg = faceConfigOf(deps.env);
  const now = deps.now();
  const consentAt = Date.parse(req.consent.consent_at);
  const passedAt = Date.parse(req.liveness.passed_at);
  if (
    req.consent.consent_version !== FACE_CONSENT_VERSION ||
    req.consent.consent_text_sha256 !== FACE_CONSENT_V1_SHA256
  ) {
    throw new HttpError('FACE_CONSENT_REQUIRED', 'Please review and accept the current consent.', {
      reason: 'unknown_consent',
      consent_version: FACE_CONSENT_VERSION,
    });
  }
  if (consentAt > now + REQUEST_CLOCK_SKEW_MS) {
    throw new HttpError('FACE_CONSENT_REQUIRED', undefined, { reason: 'consent_in_future' });
  }
  if (passedAt < consentAt) {
    // DATA-MODEL §10: consent before capture.
    throw new HttpError('FACE_CONSENT_REQUIRED', undefined, { reason: 'capture_before_consent' });
  }
  if (passedAt > now + REQUEST_CLOCK_SKEW_MS) {
    throw new HttpError('VALIDATION_FAILED', undefined, {
      issues: [{ path: 'liveness.passed_at', message: 'in the future' }],
    });
  }
  if (!isAcceptedFaceModel(req.model)) {
    throw new HttpError('FACE_MODEL_UNSUPPORTED', 'Update the app to use face matching.', {
      model: `${req.model.name}@${req.model.version}`,
      dim: req.model.dim,
    });
  }
  const kek = cfg.activeKeyId ? kekFor(cfg.keyring, cfg.activeKeyId) : null;
  if (!cfg.activeKeyId || !kek) {
    throw new HttpError(
      'INTERNAL',
      "Face matching isn't set up on this server.",
      { reason: 'face_kek_missing' },
      { retryable: false },
    );
  }

  const vec = openRequestEmbedding(req.embedding, req.model, {
    sealRequired: cfg.sealRequired,
    path: 'embedding',
  });
  const plain = embeddingToBytes(vec);
  vec.fill(0);
  const sealed = sealAtRest(kek, atRestAad(userId, req.model), plain);
  plain.fill(0);

  const at = new Date(now);
  // Device clocks run up to the signed-request skew ahead; the row keeps consent <= capture.
  const consentStored = new Date(Math.min(consentAt, now));
  const passedStored = new Date(Math.min(passedAt, now));

  await sanitized(deps, 'enroll', () =>
    deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userLock(userId)})`);
      await tx.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: userId,
        subject_user_id: userId,
        action: 'face.consented',
        request_id: requestId,
        details: {
          consent_version: req.consent.consent_version,
          consent_text_sha256: req.consent.consent_text_sha256,
          consent_at: consentStored.toISOString(),
        },
      });
      const replaced = await tx
        .delete(faceEnrollments)
        .where(eq(faceEnrollments.user_id, userId))
        .returning({ id: faceEnrollments.id });
      await tx.insert(faceEnrollments).values({
        user_id: userId,
        status: 'active',
        embedding_ciphertext: sealed.ciphertext,
        embedding_nonce: sealed.nonce,
        key_id: cfg.activeKeyId!,
        embedding_dim: req.model.dim,
        model_name: req.model.name,
        model_version: req.model.version,
        consent_version: req.consent.consent_version,
        consent_text_sha256: req.consent.consent_text_sha256,
        consent_at: consentStored,
        liveness_method: req.liveness.method,
        liveness_passed_at: passedStored,
        created_at: at,
      });
      await tx.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: userId,
        subject_user_id: userId,
        action: 'face.enrolled',
        request_id: requestId,
        details: {
          model_name: req.model.name,
          model_version: req.model.version,
          dim: req.model.dim,
          key_id: cfg.activeKeyId,
          liveness_method: req.liveness.method,
          shots: req.shots,
          replaced: replaced.length > 0,
        },
      });
    }),
  );
  return { status: 'active', enrolled_at: at.toISOString() };
}

// ---- disable / enable -------------------------------------------------------------------

/** PATCH /v1/face/enrollment. Disabling excludes the user from the very next match. */
export async function setEnrollmentStatus(
  deps: FaceDeps,
  userId: string,
  status: 'active' | 'disabled',
  requestId: string,
): Promise<FaceEnrollmentStatusResponse> {
  const now = new Date(deps.now());
  await sanitized(deps, 'set_status', () =>
    deps.db.transaction(async (tx) => {
      const [r] = await tx
        .select({ status: faceEnrollments.status })
        .from(faceEnrollments)
        .where(eq(faceEnrollments.user_id, userId))
        .for('update')
        .limit(1);
      if (!r) throw new HttpError('FACE_NOT_ENROLLED', 'No face is saved.');
      if (r.status === status) return;
      await tx
        .update(faceEnrollments)
        .set({ status, disabled_at: status === 'disabled' ? now : null })
        .where(eq(faceEnrollments.user_id, userId));
      await tx.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: userId,
        subject_user_id: userId,
        action: status === 'disabled' ? 'face.disabled' : 'face.enabled',
        request_id: requestId,
        details: {},
      });
    }),
  );
  return enrollmentStatus(deps.db, userId);
}

// ---- delete -----------------------------------------------------------------------------

export type FaceDeleteReason =
  'user' | 'account_deleted' | 'retention_unused' | 'retention_disabled' | 'retention_deadline';

/**
 * Hard-deletes the user's enrollment and audits `face.deleted` (no vector, ciphertext or
 * nonce). Returns false when there was nothing to delete. There is no cache to evict: matching
 * decrypts the room's candidates per request.
 */
export async function deleteEnrollment(
  tx: Tx | Db,
  userId: string,
  reason: FaceDeleteReason,
  actor: { kind: 'user' | 'system'; user_id: string | null; request_id: string | null },
): Promise<boolean> {
  const gone = await tx
    .delete(faceEnrollments)
    .where(eq(faceEnrollments.user_id, userId))
    .returning({
      model_name: faceEnrollments.model_name,
      model_version: faceEnrollments.model_version,
      created_at: faceEnrollments.created_at,
    });
  const r = gone[0];
  if (!r) return false;
  await tx.insert(auditLog).values({
    actor_kind: actor.kind,
    actor_user_id: actor.user_id,
    subject_user_id: userId,
    action: 'face.deleted',
    request_id: actor.request_id,
    details: {
      reason,
      model_name: r.model_name,
      model_version: r.model_version,
      enrolled_at: r.created_at.toISOString(),
    },
  });
  return true;
}

/** DELETE /v1/face/enrollment (idempotent: deleting nothing is fine). */
export async function removeEnrollment(
  deps: FaceDeps,
  userId: string,
  requestId: string,
): Promise<boolean> {
  return sanitized(deps, 'delete', () =>
    deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userLock(userId)})`);
      return deleteEnrollment(tx, userId, 'user', {
        kind: 'user',
        user_id: userId,
        request_id: requestId,
      });
    }),
  );
}

// ---- match ------------------------------------------------------------------------------

interface CandidateRow {
  user_id: string;
  display_name: string;
  wallet_pubkey: string | null;
  embedding_ciphertext: Uint8Array;
  embedding_nonce: Uint8Array;
  key_id: string;
}

/** The lobby's candidate rule: who counts as around (see LOBBY_RECENT_MS). */
export interface AroundFilter {
  /** Members seen at or after this instant. */
  seenSince: Date;
  /** Plus these users (online now, whatever their last_seen_at says). */
  onlineIds: readonly string[];
}

/**
 * DATA-MODEL §7.2: opted-in current members of `roomId` with this model, minus the scanner.
 * With `around` (the lobby): only those seen since `seenSince` or online, online first, then the
 * most recently seen, so the FACE_MATCH_MAX_CANDIDATES cap only ever drops the stalest.
 */
async function roomCandidates(
  db: Pick<Db, 'select'>,
  roomId: string,
  scannerId: string,
  model: FaceModelRef,
  around?: AroundFilter,
): Promise<CandidateRow[]> {
  const online = around?.onlineIds.length ? [...around.onlineIds] : null;
  const isOnline = online ? inArray(roomMembers.user_id, online) : sql`false`;
  const base = and(
    eq(roomMembers.room_id, roomId),
    isNull(roomMembers.left_at),
    ne(roomMembers.user_id, scannerId),
  );
  return db
    .select({
      user_id: faceEnrollments.user_id,
      display_name: users.display_name,
      wallet_pubkey: users.wallet_pubkey,
      embedding_ciphertext: faceEnrollments.embedding_ciphertext,
      embedding_nonce: faceEnrollments.embedding_nonce,
      key_id: faceEnrollments.key_id,
    })
    .from(roomMembers)
    .innerJoin(
      faceEnrollments,
      and(
        eq(faceEnrollments.user_id, roomMembers.user_id),
        eq(faceEnrollments.status, 'active'),
        eq(faceEnrollments.model_name, model.name),
        eq(faceEnrollments.model_version, model.version),
        eq(faceEnrollments.embedding_dim, model.dim),
      ),
    )
    .innerJoin(users, and(eq(users.id, roomMembers.user_id), isNull(users.deleted_at)))
    .where(around ? and(base, or(gte(roomMembers.last_seen_at, around.seenSince), isOnline)) : base)
    .orderBy(
      ...(around
        ? [
            // Only with an online list: `ORDER BY false` is a constant, which Postgres refuses.
            ...(online ? [desc(isOnline)] : []),
            desc(roomMembers.last_seen_at),
            asc(roomMembers.user_id),
          ]
        : [asc(roomMembers.joined_at), asc(roomMembers.user_id)]),
    )
    .limit(FACE_MATCH_MAX_CANDIDATES);
}

/**
 * POST /v1/rooms/:room_id/face-match. The caller must be a current member of a live room. The
 * probe is compared with the room's opted-in members only; a confident top-2 match returns that
 * member, a 60 s ticket for POST /v1/bets and the head-to-head record. Anything else is
 * `{match: null}`, and nothing is stored.
 */
export async function matchInRoom(
  deps: FaceDeps,
  scannerId: string,
  roomId: string,
  req: FaceMatchRequest,
  /** Who is online now (the presence tracker); lobby scans use it with LOBBY_RECENT_MS. */
  opts: { onlineUserIds?: () => readonly string[] } = {},
): Promise<FaceMatchResponse> {
  const cfg = faceConfigOf(deps.env);
  const now = deps.now();
  const room = await getRoomOr404(deps.db, roomId);
  if (!(await isActiveMember(deps.db, room.id, scannerId))) {
    throw new HttpError('NOT_IN_ROOM', "You're not in this room.");
  }
  assertRoomLive(room, now);
  if (!isAcceptedFaceModel(req.model)) {
    throw new HttpError('FACE_MODEL_UNSUPPORTED', 'Update the app to use face matching.', {
      model: `${req.model.name}@${req.model.version}`,
      dim: req.model.dim,
    });
  }
  const probe = openRequestEmbedding(req.probe, req.model, {
    sealRequired: cfg.sealRequired,
    path: 'probe',
  });
  try {
    const around: AroundFilter | undefined = isLobbyRoom(room)
      ? {
          seenSince: new Date(now - LOBBY_RECENT_MS),
          onlineIds: opts.onlineUserIds?.() ?? [],
        }
      : undefined;
    const rows = await sanitized(deps, 'candidates', () =>
      roomCandidates(deps.db, room.id, scannerId, req.model, around),
    );
    const scored: ScoredCandidate[] = [];
    let unreadable = 0;
    for (const r of rows) {
      const score = scoreRow(cfg.keyring, r, req.model, probe);
      if (score === null) unreadable++;
      else scored.push({ id: r.user_id, score });
    }
    if (unreadable > 0) {
      const fields = { room_id: room.id, unreadable, candidates: rows.length };
      // Every candidate unreadable is almost always a replaced KEK (FACE_KEK_* set again with a
      // new value): every scan then abstains ("No match") and nothing else shows it, so this is
      // an error, visible in `fly logs | grep face`. Names and counts only, never key material.
      if (unreadable === rows.length)
        deps.log.error('face.candidates_unreadable', {
          ...fields,
          hint: 'no enrollment in this room decrypts: was FACE_KEK_* changed?',
        });
      else deps.log.warn('face.candidates_unreadable', fields);
    }
    const decision = decideMatch(scored);
    scored.length = 0;
    if (decision.kind === 'abstain') return { match: null };

    const hit = rows.find((r) => r.user_id === decision.id)!;
    const user = userRefOf({
      id: hit.user_id,
      display_name: hit.display_name,
      wallet_pubkey: hit.wallet_pubkey,
    });
    if (!user) return { match: null }; // no wallet yet: cannot be challenged, so show nothing

    const dayStart = new Date(Math.floor(now / DAY_MS) * DAY_MS);
    await sanitized(deps, 'touch', () =>
      deps.db
        .update(faceEnrollments)
        .set({ last_used_at: dayStart })
        .where(eq(faceEnrollments.user_id, hit.user_id)),
    );
    const t = issueMatchTicket(
      cfg.ticketKey,
      { room_id: room.id, scanner_user_id: scannerId, candidate_user_id: hit.user_id },
      now,
    );
    return {
      match: {
        user,
        match_ticket: t.ticket,
        ticket_expires_at: new Date(t.expires_at_ms).toISOString(),
        head_to_head: await sanitized(deps, 'h2h', () =>
          headToHead(deps.db, scannerId, hit.user_id),
        ),
      },
    };
  } finally {
    probe.fill(0);
  }
}

/** Decrypts one candidate and scores it against the probe; null when it can't be read. */
function scoreRow(
  keyring: ReadonlyMap<string, Uint8Array>,
  r: CandidateRow,
  model: FaceModelRef,
  probe: Float32Array,
): number | null {
  const kek = kekFor(keyring, r.key_id);
  if (!kek) return null;
  const plain = openAtRest(kek, atRestAad(r.user_id, model), {
    ciphertext: r.embedding_ciphertext,
    nonce: r.embedding_nonce,
  });
  if (!plain || plain.length !== model.dim * 4) {
    plain?.fill(0);
    return null;
  }
  const v = bytesToEmbedding(plain);
  plain.fill(0);
  try {
    return embeddingProblem(v, model.dim) === null ? cosineSimilarity(probe, v) : null;
  } finally {
    v.fill(0);
  }
}

// ---- head-to-head (DATA-MODEL §7.1) ------------------------------------------------------

const signedUsd = (micro: bigint): string =>
  micro === 0n
    ? '$0'
    : `${micro < 0n ? '−' : '+'}${formatUsd((micro < 0n ? -micro : micro).toString())}`;

/**
 * `me` vs `them` over chain-confirmed settlements (onchain_status 'settled') plus labelled
 * is_seed history, per the DATA-MODEL §7.1 view (computed inline; the view itself is not
 * migrated). No rows means 0-0.
 *
 * Rivalry fields (one statement): `total` = wins + losses + pushes; `last_result` is the newest
 * settled bet's result (settled_at DESC NULLS LAST, then id DESC); `streak` is the run of that
 * same result ending there, null when the newest is a push or there is none; `rival` = total >=
 * RIVAL_MIN_SETTLED.
 */
export async function headToHead(db: Reader, me: string, them: string): Promise<HeadToHead> {
  const rows = await db.execute<{
    wins: number;
    losses: number;
    pushes: number;
    net: string;
    last_settled_at: Date | string | null;
    includes_seed: boolean;
    last_result: 'win' | 'loss' | 'push' | null;
    streak_len: number;
  }>(sql`
    WITH mine AS (
      SELECT id, outcome, settled_at, is_seed,
             CASE WHEN party_a_id = ${me} THEN 'party_a'::onchain_outcome
                  ELSE 'party_b'::onchain_outcome END AS my_side,
             CASE WHEN party_a_id = ${me} THEN coalesce(payout_a, 0) - coalesce(stake_a, 0)
                  ELSE coalesce(payout_b, 0) - coalesce(stake_b, 0) END AS my_net,
             CASE WHEN outcome IN ('split','refund') THEN 'push'
                  WHEN outcome = (CASE WHEN party_a_id = ${me} THEN 'party_a'::onchain_outcome
                                       ELSE 'party_b'::onchain_outcome END) THEN 'win'
                  WHEN outcome IN ('party_a','party_b') THEN 'loss' END AS result
      FROM bets
      WHERE onchain_status = 'settled'
        AND ((party_a_id = ${me} AND party_b_id = ${them})
          OR (party_a_id = ${them} AND party_b_id = ${me}))
    ),
    ordered AS (
      SELECT result,
             row_number() OVER (ORDER BY settled_at DESC NULLS LAST, id DESC) AS rn
      FROM mine
      WHERE result IS NOT NULL
    ),
    latest AS (SELECT result FROM ordered WHERE rn = 1),
    agg AS (
      SELECT count(*) FILTER (WHERE outcome = my_side)::int                       AS wins,
             count(*) FILTER (WHERE outcome IN ('party_a','party_b')
                                AND outcome <> my_side)::int                      AS losses,
             count(*) FILTER (WHERE outcome IN ('split','refund'))::int           AS pushes,
             coalesce(sum(my_net), 0)::text                                       AS net,
             max(settled_at)                                                      AS last_settled_at,
             coalesce(bool_or(is_seed), false)                                    AS includes_seed
      FROM mine
    )
    SELECT agg.*,
           (SELECT result FROM latest)                                            AS last_result,
           coalesce(
             (SELECT min(o.rn) - 1 FROM ordered o, latest l WHERE o.result <> l.result),
             (SELECT count(*) FROM ordered)
           )::int                                                                 AS streak_len
    FROM agg`);
  const r = rows[0];
  const net = BigInt(r?.net ?? '0');
  const last = r?.last_settled_at ?? null;
  const wins = r?.wins ?? 0;
  const losses = r?.losses ?? 0;
  const pushes = r?.pushes ?? 0;
  const total = wins + losses + pushes;
  const lastResult = r?.last_result ?? null;
  const streakLen = r?.streak_len ?? 0;
  return {
    wins,
    losses,
    pushes,
    net: net.toString(),
    net_display: signedUsd(net),
    last_settled_at: last === null ? null : new Date(last).toISOString(),
    includes_seed: r?.includes_seed ?? false,
    total,
    last_result: lastResult,
    streak:
      (lastResult === 'win' || lastResult === 'loss') && streakLen >= 1
        ? { holder: lastResult === 'win' ? 'me' : 'them', length: streakLen }
        : null,
    rival: total >= RIVAL_MIN_SETTLED,
  };
}

// ---- retention (DATA-MODEL §10 written schedule) ------------------------------------------

/**
 * Destroys enrollments at the earliest of: 180 days without a match (or since enrollment),
 * 30 days after disabling, or the hackathon deadline. Each deletion is audited with its reason.
 * Safe to run concurrently (the DELETE ... RETURNING claims each row once).
 */
export async function purgeExpiredEnrollments(
  deps: Pick<AppDeps, 'db'>,
  nowMs: number,
  opts: {
    /** Only these users (test isolation on a shared database). */ userIds?: readonly string[];
  } = {},
): Promise<{ deleted: number }> {
  const now = new Date(nowMs);
  const unusedBefore = new Date(nowMs - FACE_RETENTION.unusedMs);
  const disabledBefore = new Date(nowMs - FACE_RETENTION.disabledMs);
  const pastDeadline = nowMs >= Date.parse(FACE_RETENTION.hardDeadlineIso);
  const due = pastDeadline
    ? sql`true`
    : sql`(coalesce(${faceEnrollments.last_used_at}, ${faceEnrollments.created_at}) < ${unusedBefore.toISOString()}::timestamptz
         OR (${faceEnrollments.status} = 'disabled' AND ${faceEnrollments.disabled_at} < ${disabledBefore.toISOString()}::timestamptz))`;
  if (opts.userIds && opts.userIds.length === 0) return { deleted: 0 };
  return deps.db.transaction(async (tx) => {
    const gone = await tx
      .delete(faceEnrollments)
      .where(opts.userIds ? and(due, inArray(faceEnrollments.user_id, [...opts.userIds])) : due)
      .returning({
        user_id: faceEnrollments.user_id,
        status: faceEnrollments.status,
        disabled_at: faceEnrollments.disabled_at,
        model_name: faceEnrollments.model_name,
        model_version: faceEnrollments.model_version,
        created_at: faceEnrollments.created_at,
      });
    for (const r of gone) {
      const reason: FaceDeleteReason = pastDeadline
        ? 'retention_deadline'
        : r.status === 'disabled' && r.disabled_at !== null && r.disabled_at < disabledBefore
          ? 'retention_disabled'
          : 'retention_unused';
      await tx.insert(auditLog).values({
        actor_kind: 'system',
        subject_user_id: r.user_id,
        action: 'face.deleted',
        at: now,
        details: {
          reason,
          model_name: r.model_name,
          model_version: r.model_version,
          enrolled_at: r.created_at.toISOString(),
        },
      });
    }
    return { deleted: gone.length };
  });
}
