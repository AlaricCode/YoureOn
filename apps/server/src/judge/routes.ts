// Judge pipeline, Beat 4 (API-CONTRACT §2.9, §2.15, §7.1; SCHEMAS §4, §5):
//   PATCH /v1/devices/current                    (S)        -> 204   role phone | judge_cam (bound to a room)
//   POST  /v1/bets/:bet_id/attempts              (S, party) -> 201   LOCKED (or JUDGING after a REDO) -> ATTEMPT
//   POST  /v1/bets/:bet_id/attempts/:n/frames    (S, recorder device; multipart) -> 202   ATTEMPT -> JUDGING
//
// After the 202 the ruling job runs in the background: one structured vision call through
// deps.providers.llm (or the CACHED_RULING verdict), the deterministic bottle checks, the
// SCHEMAS §5.1 mapping (toOutcome, REDO_BELOW, MAX_REDOS -> VOID), the Ruling record and its
// ruling_hash (committing to the frame hashes, D7), one DB transaction (rulings row, attempt
// status, redo_count, ruling.issued + judge.cue), fan-out to the bet channel and the room's
// stage, then deps.onRuling(bet_id, ruling) (the payout stream sends `resolve`).
//
// The bet stays JUDGING after the ruling: RULED is entered by the payout stream once `resolve`
// confirms (API-CONTRACT §3.4). A REDO keeps it in JUDGING with the attempt in status 'redo',
// which is what lets POST …/attempts open attempt_no + 1.
//
// The performer never records: the judge cam must be the non-performer's device and
// recorder:'self' is refused to the performer (§2.9). A lost ruling job (crash before its
// commit, restart mid-call) never strands the bet in JUDGING: a throwing job commits REDO
// 'unclear'; a replayed frames upload re-runs it from attempt_frames; the keeper task
// 'judge-stuck' gives one older than STUCK_JUDGING_MS a REDO 'unclear' (no new model call).
//
// Not here yet (no object storage): clip PresignedUpload (`clip_upload` is null), clip-upload /
// clip-complete, signed frame_urls in attempt.evidence (empty). Frames are kept in Postgres.
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { attemptFrames, attempts, auditLog, bets, devices, rulings, users } from '@youre-on/db';
import { CameraEvidence } from '@youre-on/shared/evidence';
import { jcs } from '@youre-on/shared/jcs';
import { sha256Hex, Uuid, type Party } from '@youre-on/shared/primitives';
import type { Terms } from '@youre-on/shared/terms';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { parseWith, readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { assertRoomLive, getRoomOr404, isActiveMember } from '../rooms/service';
import { chainAckOf, partyOf, toOnchainStatus, type BetRow } from '../bets/snapshot';
import { attemptArmedCue, rulingCue } from './cues';
import { buildRuling, judgeFrames, rulingCanonical, type Judged } from './ruling';
import {
  DevicePatchRequest,
  StartAttemptRequest,
  type FramesAcceptedResponse,
  type StartAttemptResponse,
} from './schemas';
import { loadFinalTerms, termsMatchBet, type TermsLoader } from './terms';

/** §1.7: attempts + frames, 6/min per bet. */
export const ATTEMPTS_BUCKET = { limit: 6, windowMs: 60_000 } as const;
/** The judge cam's 3-2-1 before GO. */
export const GO_DELAY_MS = 3_000;
/** §2.9: per attempt try. */
export const MS_PER_TRY = 6_000;
/** Frames per upload (planning D10: 12–16 clustered at the end; capped at 12 for latency). */
export const MIN_FRAMES = 8;
export const MAX_FRAMES = 12;
/** §2.9: each JPEG ≤ 200 KB. */
export const MAX_FRAME_BYTES = 200 * 1024;
/** The frames multipart body: 12 × 200 KB + the evidence JSON + multipart overhead. */
export const FRAMES_BODY_LIMIT = 3 * 1024 * 1024;
/**
 * A ruling job this much past its upload, with no job running for it in this process, is
 * presumed lost (a restart mid vision call, or a crash before its commit) and is re-run by the
 * keeper sweep. Above JUDGE_TIMEOUT_MS (10 s) + the commit, so a live job is never doubled.
 */
export const STUCK_JUDGING_MS = 20_000;
/** gg_secs in the RULING cue when APPEAL_WINDOW_S is unset. */
const DEFAULT_GG_SECS = 10;

/** States POST …/attempts may be called in (ATTEMPT/JUDGING only for a replay or after a REDO). */
const ATTEMPT_FROM: readonly BetRow['state'][] = ['LOCKED', 'ATTEMPT', 'JUDGING'];

const FRAMES_PATH = /^\/v1\/bets\/[^/]+\/attempts\/\d+\/frames$/;

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];
type AttemptRow = typeof attempts.$inferSelect;

export interface JudgeRoutesOptions {
  /** Where the frozen Terms come from (default: bet_terms_versions, when that table exists). */
  loadTerms?: TermsLoader;
}

export interface JudgeRouteModule extends RouteModule {
  /** Resolves when every ruling job started so far has finished (tests, graceful shutdown). */
  idle(): Promise<void>;
  /**
   * Re-runs every ruling job that is lost: attempt 'judging' on a JUDGING bet, uploaded more
   * than `olderThanMs` ago, with no job for it in this process. Registered as the keeper task
   * 'judge-stuck'; returns how many it restarted.
   */
  resumeStuck(deps: AppDeps, nowMs: number, olderThanMs?: number): Promise<number>;
}

function uuidOr404(raw: string, what: string): string {
  if (!Uuid.safeParse(raw).success) throw new HttpError('NOT_FOUND', `No such ${what}.`);
  return raw;
}

const isJpeg = (b: Uint8Array) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

async function displayNames(db: Pick<AppDeps['db'], 'select'>, bet: BetRow) {
  const rows = await db
    .select({ id: users.id, name: users.display_name })
    .from(users)
    .where(inArray(users.id, [bet.party_a_id, bet.party_b_id]));
  const name = (id: string) => rows.find((r) => r.id === id)?.name ?? 'Player';
  return { A: name(bet.party_a_id), B: name(bet.party_b_id) };
}

function stateEvent(
  bet: BetRow,
  state: BetRow['state'],
  prev: BetRow['state'],
  reason: string | null,
) {
  return {
    state,
    prev,
    onchain_status: toOnchainStatus(bet.onchain_status),
    chain_ack: chainAckOf(bet),
    pending_tx: null,
    reason,
  };
}

async function lockBet(tx: Tx, betId: string): Promise<BetRow> {
  const [bet] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update').limit(1);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  return bet;
}

async function versionedState(tx: Tx, bet: BetRow, set: Partial<typeof bets.$inferInsert>) {
  const updated = await tx
    .update(bets)
    .set(set)
    .where(and(eq(bets.id, bet.id), eq(bets.version, bet.version)))
    .returning({ id: bets.id });
  if (updated.length !== 1) throw new HttpError('INVALID_STATE', undefined, { reason: 'raced' });
}

/**
 * The room's judge-cam device of the NON-performer (most recently seen first). The performer can
 * never be their own recorder (API-CONTRACT §2.9, ARCHITECTURE §6): a judge cam the performer
 * binds to the room is ignored.
 */
async function findJudgeCam(db: Pick<AppDeps['db'], 'select'>, bet: BetRow, performer: Party) {
  if (!bet.room_id) return null;
  const [d] = await db
    .select({ id: devices.id, user_id: devices.user_id })
    .from(devices)
    .where(
      and(
        eq(devices.role, 'judge_cam'),
        eq(devices.judge_room_id, bet.room_id),
        isNull(devices.revoked_at),
        eq(devices.user_id, nonPerformerId(bet, performer)),
      ),
    )
    .orderBy(desc(devices.last_seen_at))
    .limit(1);
  return d ?? null;
}

const nonPerformerId = (bet: BetRow, performer: Party) =>
  performer === 'A' ? bet.party_b_id : bet.party_a_id;

function startResponse(a: AttemptRow, performer: Party): StartAttemptResponse {
  return {
    attempt_no: a.attempt_no,
    performer,
    recorder_device_id: a.recorded_by_device_id!,
    max_ms: a.max_ms,
    go_at: a.go_at.toISOString(),
  };
}

export function createJudgeRoutes(opts: JudgeRoutesOptions = {}): JudgeRouteModule {
  const loadTerms = opts.loadTerms ?? loadFinalTerms;
  /** Running ruling jobs by attempt id (one per attempt per process). */
  const jobs = new Map<string, Promise<void>>();

  async function termsFor(deps: AppDeps, bet: BetRow): Promise<Terms> {
    const terms = await loadTerms(deps.db, bet);
    if (!terms) throw new HttpError('TERMS_NOT_FINAL', 'The terms are not final yet.');
    if (!termsMatchBet(terms, bet)) {
      deps.log.error('judge.terms_hash_mismatch', { bet_id: bet.id });
      throw new HttpError('TERMS_HASH_MISMATCH', "These terms don't match the locked bet.");
    }
    if (terms.evidence_source !== 'camera' || terms.performer === null) {
      throw new HttpError('INVALID_STATE', 'This bet is not judged on camera.', {
        state: bet.state,
        reason: 'not_camera',
      });
    }
    return terms;
  }

  // ---- the ruling job --------------------------------------------------------------------

  async function runRuling(
    deps: AppDeps,
    job: {
      bet_id: string;
      attempt_id: string;
      attempt_no: number;
      terms: Terms;
      evidence_hash: string;
      frame_hashes: string[];
      frames: { t_ms: number; bytes: Uint8Array }[];
      received_at: number;
    },
    /** Skip the vision call and commit this instead (the failure fallback of startJob). */
    forced?: Judged,
  ): Promise<void> {
    const [bet0] = await deps.db.select().from(bets).where(eq(bets.id, job.bet_id)).limit(1);
    if (!bet0) return;
    const names = await displayNames(deps.db, bet0);
    const judged =
      forced ??
      (await judgeFrames(deps, {
        terms: job.terms,
        performer_name: names[job.terms.performer ?? 'B'],
        frames: job.frames,
      }));
    const now = deps.now();
    const ruling = buildRuling(
      {
        ruling_id: randomUUID(),
        bet_id: job.bet_id,
        attempt_no: job.attempt_no,
        yes_party: job.terms.yes_party,
        terms_hash: bet0.terms_hash!,
        evidence_hash: job.evidence_hash,
        frame_hashes: job.frame_hashes,
        created_at: new Date(now).toISOString(),
      },
      judged,
    );
    const { canonical, hash } = rulingCanonical(ruling);

    const committed = await deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, job.bet_id);
      const [a] = await tx.select().from(attempts).where(eq(attempts.id, job.attempt_id)).limit(1);
      if (!a || a.status !== 'judging' || bet.state !== 'JUDGING') return null; // moved on
      await tx.insert(rulings).values({
        id: ruling.ruling_id,
        bet_id: bet.id,
        stage: 'attempt',
        attempt_id: a.id,
        model: ruling.model,
        outcome: ruling.outcome,
        claim_result: ruling.claim_result,
        redo_reason: ruling.redo_reason,
        void_reason: ruling.void_reason,
        confidence: ruling.confidence.toFixed(2),
        reason: ruling.reason,
        cited_frames: ruling.cited_frames,
        frame_hashes: ruling.frame_hashes,
        evidence_kind: 'camera',
        evidence_hash: ruling.evidence_hash,
        record_canonical: canonical,
        ruling_hash: hash,
        latency_ms: Math.max(0, now - job.received_at),
        created_at: new Date(ruling.created_at),
      });
      await tx
        .update(attempts)
        .set({ status: ruling.outcome === 'REDO' ? 'redo' : 'ruled' })
        .where(eq(attempts.id, a.id));
      if (ruling.outcome === 'REDO') {
        await versionedState(tx, bet, { redo_count: Math.min(3, bet.redo_count + 1) });
      }
      const events: BetEventEnvelope[] = [
        await appendBetEvent(tx, {
          bet_id: bet.id,
          type: 'ruling.issued',
          payload: { ruling, ruling_hash: hash },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: bet.id,
          type: 'judge.cue',
          payload: rulingCue(ruling, names, deps.env.APPEAL_WINDOW_S ?? DEFAULT_GG_SECS),
          now,
        }),
      ];
      await tx.insert(auditLog).values({
        actor_kind: 'judge',
        action: 'ruling.issued',
        bet_id: bet.id,
        details: {
          ruling_id: ruling.ruling_id,
          ruling_hash: hash,
          outcome: ruling.outcome,
          attempt_no: ruling.attempt_no,
          model: ruling.model,
          ...(judged.kind === 'failure' ? { llm_status: judged.status } : {}),
          ...(judged.kind === 'verdict' && judged.disagreement
            ? { checks_disagree: judged.disagreement }
            : {}),
        },
      });
      return { events, room_id: bet.room_id };
    });
    if (!committed) return;
    for (const e of committed.events) deps.hub.publishBetEvent(e, committed.room_id);
    deps.log.info('judge.ruling', {
      bet_id: job.bet_id,
      attempt_no: job.attempt_no,
      outcome: ruling.outcome,
      ruling_hash: hash,
      latency_ms: now - job.received_at,
    });
    if (deps.onRuling) {
      try {
        await deps.onRuling(job.bet_id, ruling);
      } catch (e) {
        deps.log.error('judge.on_ruling_failed', { bet_id: job.bet_id, err: String(e) });
      }
    }
  }

  type Job = Parameters<typeof runRuling>[1];

  /**
   * Runs the ruling job in the background, at most one per attempt in this process. If it
   * throws (a DB error, a bug), it commits a REDO 'unclear' through the same path, as for a
   * model failure (API-CONTRACT §7.1), so the bet never sits in JUDGING. If even that fails, the
   * keeper sweep (resumeStuck) or a replayed frames upload re-runs it.
   */
  function startJob(deps: AppDeps, job: Job, forced?: Judged): boolean {
    if (jobs.has(job.attempt_id)) return false;
    const p = runRuling(deps, job, forced)
      .catch(async (e: unknown) => {
        deps.log.error('judge.job_failed', { bet_id: job.bet_id, err: String(e) });
        try {
          await runRuling(deps, job, {
            kind: 'failure',
            model: `anthropic/${deps.env.JUDGE_MODEL}`,
            status: 'error',
            message: String(e),
          });
        } catch (e2) {
          deps.log.error('judge.job_fallback_failed', { bet_id: job.bet_id, err: String(e2) });
        }
      })
      .finally(() => jobs.delete(job.attempt_id));
    jobs.set(job.attempt_id, p);
    return true;
  }

  /**
   * Rebuilds a 'judging' attempt's job from the DB (attempt_frames) and starts it; `forced`
   * commits that instead of calling the model again.
   */
  async function restartJob(
    deps: AppDeps,
    bet: BetRow,
    att: AttemptRow,
    forced?: Judged,
  ): Promise<boolean> {
    if (jobs.has(att.id) || att.status !== 'judging' || bet.state !== 'JUDGING') return false;
    if (!att.client_clip_hash || !att.uploaded_at) return false;
    const stored = await deps.db
      .select({
        t_ms: attemptFrames.t_ms,
        sha256: attemptFrames.sha256,
        bytes: attemptFrames.bytes,
      })
      .from(attemptFrames)
      .where(eq(attemptFrames.attempt_id, att.id))
      .orderBy(asc(attemptFrames.idx));
    const terms = await termsFor(deps, bet);
    deps.log.warn('judge.job_restarted', {
      bet_id: bet.id,
      attempt_no: att.attempt_no,
      forced: forced?.kind ?? null,
    });
    return startJob(
      deps,
      {
        bet_id: bet.id,
        attempt_id: att.id,
        attempt_no: att.attempt_no,
        terms,
        evidence_hash: att.client_clip_hash,
        frame_hashes: att.frame_hashes,
        frames: stored.map((f) => ({ t_ms: f.t_ms, bytes: new Uint8Array(f.bytes) })),
        received_at: att.uploaded_at.getTime(),
      },
      forced,
    );
  }

  /**
   * The keeper sweep: a lost job gets a REDO 'unclear' through the normal commit path (no new
   * model call, so a job that keeps dying never loops on a paid API), and the judge says
   * "Run it back". A replayed frames upload instead re-runs the vision call.
   */
  async function resumeStuck(
    deps: AppDeps,
    nowMs: number,
    olderThanMs: number = STUCK_JUDGING_MS,
  ): Promise<number> {
    const stuck = await deps.db
      .select({ bet: bets, att: attempts })
      .from(attempts)
      .innerJoin(bets, eq(bets.id, attempts.bet_id))
      .where(
        and(
          eq(attempts.status, 'judging'),
          eq(bets.state, 'JUDGING'),
          lt(attempts.uploaded_at, new Date(nowMs - olderThanMs)),
        ),
      )
      .limit(20);
    let n = 0;
    for (const { bet, att } of stuck) {
      try {
        const lost: Judged = {
          kind: 'failure',
          model: `anthropic/${deps.env.JUDGE_MODEL}`,
          status: 'lost',
          message: 'ruling job lost (restart or crash before commit)',
        };
        if (await restartJob(deps, bet, att, lost)) n++;
      } catch (e) {
        deps.log.error('judge.resume_failed', { bet_id: bet.id, err: String(e) });
      }
    }
    return n;
  }

  return {
    name: 'judge',
    bodyLimits: [{ path: FRAMES_PATH, maxBytes: FRAMES_BODY_LIMIT }],

    async idle() {
      while (jobs.size) await Promise.allSettled([...jobs.values()]);
    },

    resumeStuck,

    register(app, deps) {
      // Lost ruling jobs (restart mid-call, crash before commit) are re-run from the DB.
      deps.keeper?.register({
        name: 'judge-stuck',
        run: (nowMs) => resumeStuck(deps, nowMs),
      });

      // ---- PATCH /v1/devices/current (§2.15) ---------------------------------------------
      app.patch('/v1/devices/current', requireSignedRequest, async (c) => {
        const me = appAuth(c);
        const body = await readBody(c, DevicePatchRequest);
        const [dev] = await deps.db
          .select()
          .from(devices)
          .where(eq(devices.id, me.device_id))
          .limit(1);
        if (!dev) throw new HttpError('AUTH_REQUIRED');
        const role = body.role ?? dev.role;
        let roomId: string | null = null;
        if (role === 'judge_cam') {
          roomId = body.room_id ?? dev.judge_room_id;
          if (!roomId) {
            throw new HttpError('VALIDATION_FAILED', 'Pick the room this camera judges.', {
              issues: [{ path: 'room_id', message: "required for role 'judge_cam'" }],
            });
          }
          const room = await getRoomOr404(deps.db, roomId);
          assertRoomLive(room, deps.now());
          if (!(await isActiveMember(deps.db, room.id, me.user_id))) {
            throw new HttpError('NOT_IN_ROOM', "You're not in this room.");
          }
        } else if (body.room_id) {
          throw new HttpError('VALIDATION_FAILED', 'Only a judge cam is bound to a room.', {
            issues: [{ path: 'room_id', message: "only with role 'judge_cam'" }],
          });
        }
        await deps.db
          .update(devices)
          .set({ role, judge_room_id: roomId })
          .where(eq(devices.id, me.device_id));
        await deps.db.insert(auditLog).values({
          actor_kind: 'user',
          actor_user_id: me.user_id,
          action: 'device.role_set',
          request_id: c.get('requestId'),
          details: { device_id: me.device_id, role, room_id: roomId },
        });
        return c.body(null, 204);
      });

      // ---- POST /v1/bets/:bet_id/attempts (§2.9) ------------------------------------------
      app.post('/v1/bets/:bet_id/attempts', requireSignedRequest, async (c) => {
        const me = appAuth(c);
        const betId = uuidOr404(c.req.param('bet_id'), 'bet');
        const body = await readBody(c, StartAttemptRequest);

        const [bet0] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
        if (!bet0) throw new HttpError('NOT_FOUND', 'No such bet.');
        if (!partyOf(bet0, me.user_id)) {
          throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
        }
        // The per-bet bucket is taken only for a party: a stranger's 403s (bet ids are public
        // onchain) must not spend the parties' tokens and lock them out of judging.
        deps.rateLimit?.take('attempts', betId, ATTEMPTS_BUCKET);
        if (!ATTEMPT_FROM.includes(bet0.state)) {
          throw new HttpError('INVALID_STATE', undefined, { state: bet0.state });
        }
        const terms = await termsFor(deps, bet0);
        const performer = terms.performer!;
        // 'self' = the caller's phone records, so only the non-performer may ask for it (§2.9).
        if (body.recorder === 'self' && partyOf(bet0, me.user_id) === performer) {
          throw new HttpError('NOT_A_PARTY', "You can't record your own attempt.", {
            reason: 'performer_cannot_record',
          });
        }
        const names = await displayNames(deps.db, bet0);
        const now = deps.now();

        const out = await deps.db.transaction(async (tx) => {
          const bet = await lockBet(tx, betId);
          const prior = await tx
            .select()
            .from(attempts)
            .where(eq(attempts.bet_id, betId))
            .orderBy(desc(attempts.attempt_no));
          const same = prior.find((a) => a.attempt_no === body.attempt_no);
          // Idem (bet_id, attempt_no): the same attempt, still current, replays its 201.
          if (
            same &&
            same === prior[0] &&
            same.status !== 'redo' &&
            (bet.state === 'ATTEMPT' || bet.state === 'JUDGING')
          ) {
            return { res: startResponse(same, performer), events: [], recorderUser: null };
          }
          let expected: number;
          if (bet.state === 'LOCKED' && prior.length === 0) expected = 1;
          else if (bet.state === 'JUDGING' && prior[0]?.status === 'redo')
            expected = prior[0].attempt_no + 1;
          else throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
          if (body.attempt_no !== expected) {
            throw new HttpError('VALIDATION_FAILED', `This is attempt ${expected}.`, {
              issues: [{ path: 'attempt_no', message: `expected ${expected}` }],
              expected,
            });
          }

          let recorder: { id: string; user_id: string };
          if (body.recorder === 'judge_cam') {
            const cam = await findJudgeCam(tx, bet, performer);
            if (!cam) {
              throw new HttpError('INVALID_STATE', 'No judge cam is set up in this room.', {
                state: bet.state,
                reason: 'no_judge_cam',
              });
            }
            recorder = cam;
          } else {
            // checked above against bet0; party ids never change after creation
            recorder = { id: me.device_id, user_id: me.user_id };
          }

          const [a] = await tx
            .insert(attempts)
            .values({
              bet_id: bet.id,
              attempt_no: body.attempt_no,
              recorded_by_user_id: recorder.user_id,
              recorded_by_device_id: recorder.id,
              recorder: body.recorder,
              status: 'recording',
              max_ms: MS_PER_TRY * terms.attempts.count,
              go_at: new Date(now + GO_DELAY_MS),
              started_at: new Date(now),
            })
            .returning();
          await versionedState(tx, bet, { state: 'ATTEMPT' });
          const res = startResponse(a!, performer);
          const events: BetEventEnvelope[] = [
            await appendBetEvent(tx, {
              bet_id: bet.id,
              type: 'bet.state',
              payload: stateEvent(bet, 'ATTEMPT', bet.state, null),
              now,
            }),
            await appendBetEvent(tx, {
              bet_id: bet.id,
              type: 'attempt.started',
              payload: {
                attempt_no: res.attempt_no,
                performer,
                max_ms: res.max_ms,
                recorder_device_id: res.recorder_device_id,
                go_at: res.go_at,
              },
              now,
            }),
            await appendBetEvent(tx, {
              bet_id: bet.id,
              type: 'judge.cue',
              payload: attemptArmedCue(res.attempt_no, names[performer]),
              now,
            }),
          ];
          await tx.insert(auditLog).values({
            actor_kind: 'user',
            actor_user_id: me.user_id,
            action: 'bet.state_changed',
            bet_id: bet.id,
            request_id: c.get('requestId'),
            details: { from: bet.state, to: 'ATTEMPT', attempt_no: res.attempt_no },
          });
          return { res, events, recorderUser: recorder.user_id, room_id: bet.room_id };
        });

        for (const e of out.events) deps.hub.publishBetEvent(e, bet0.room_id);
        // The judge cam may only be on its user channel; the hub dedupes by seq per socket.
        if (out.recorderUser) {
          for (const e of out.events) deps.hub.publishToUser(out.recorderUser, e);
        }
        return c.json(out.res, 201);
      });

      // ---- POST /v1/bets/:bet_id/attempts/:n/frames (§2.9) --------------------------------
      app.post('/v1/bets/:bet_id/attempts/:n/frames', requireSignedRequest, async (c) => {
        const me = appAuth(c);
        const betId = uuidOr404(c.req.param('bet_id'), 'bet');
        const nRaw = c.req.param('n');
        if (!/^[1-9][0-9]{0,4}$/.test(nRaw)) throw new HttpError('NOT_FOUND', 'No such attempt.');
        const n = Number(nRaw);

        const [bet0] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
        if (!bet0) throw new HttpError('NOT_FOUND', 'No such bet.');
        const [att] = await deps.db
          .select()
          .from(attempts)
          .where(and(eq(attempts.bet_id, betId), eq(attempts.attempt_no, n)))
          .limit(1);
        if (!att) throw new HttpError('NOT_FOUND', 'No such attempt.');

        // Evidence provenance (ARCHITECTURE §6): only the attempt's recorder device, and for a
        // judge_cam attempt only while it is still this room's judge cam.
        const notRecorder = () =>
          new HttpError('NOT_A_PARTY', "Only this room's judge cam can upload frames.", {
            reason: 'not_recorder',
          });
        if (att.recorded_by_device_id !== me.device_id) throw notRecorder();
        if (att.recorder === 'judge_cam') {
          const [dev] = await deps.db
            .select({
              role: devices.role,
              room: devices.judge_room_id,
              revoked: devices.revoked_at,
            })
            .from(devices)
            .where(eq(devices.id, me.device_id))
            .limit(1);
          if (!dev || dev.role !== 'judge_cam' || dev.room !== bet0.room_id || dev.revoked) {
            throw notRecorder();
          }
        }
        // Only the recorder spends the per-bet bucket (see POST /attempts).
        deps.rateLimit?.take('attempts', betId, ATTEMPTS_BUCKET);

        // Parse the multipart body (the signing middleware already buffered it).
        const ct = c.req.header('content-type') ?? '';
        if (!ct.toLowerCase().startsWith('multipart/form-data')) {
          throw new HttpError('VALIDATION_FAILED', 'Send the frames as multipart/form-data.', {
            issues: [{ path: 'content-type', message: 'multipart/form-data required' }],
          });
        }
        let form: FormData;
        try {
          const raw = await c.req.arrayBuffer();
          form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
        } catch {
          throw new HttpError('VALIDATION_FAILED', 'That upload could not be read.', {
            issues: [{ path: '', message: 'invalid multipart body' }],
          });
        }
        const evPart = form.get('evidence');
        let evRaw: unknown;
        try {
          evRaw = JSON.parse(
            typeof evPart === 'string' ? evPart : evPart ? await evPart.text() : '',
          );
        } catch {
          throw new HttpError('VALIDATION_FAILED', 'The evidence part is missing or not JSON.', {
            issues: [{ path: 'evidence', message: 'JSON CameraEvidence required' }],
          });
        }
        const evidence = parseWith(CameraEvidence, evRaw);

        // Idem (bet_id, n) + clip_sha256: the same upload replays the 202, another is refused.
        if (att.client_clip_hash !== null) {
          if (att.client_clip_hash === evidence.clip_sha256) {
            // A lost job (no ruling yet, none running here) is restarted by the replay.
            await restartJob(deps, bet0, att).catch((e: unknown) =>
              deps.log.error('judge.resume_failed', { bet_id: betId, err: String(e) }),
            );
            const replay: FramesAcceptedResponse = {
              judging: true,
              frame_hashes: att.frame_hashes,
              clip_upload: null,
            };
            return c.json(replay, 202);
          }
          throw new HttpError('ATTEMPT_NOT_OPEN', 'Frames for this attempt are already in.');
        }
        if (bet0.state !== 'ATTEMPT' || att.status !== 'recording') {
          throw new HttpError('ATTEMPT_NOT_OPEN', 'This attempt is not open.', {
            state: bet0.state,
          });
        }

        const bad = (path: string, message: string): never => {
          throw new HttpError('VALIDATION_FAILED', undefined, { issues: [{ path, message }] });
        };
        if (evidence.bet_id !== betId) bad('evidence.bet_id', 'does not match the URL');
        if (evidence.attempt_no !== n) bad('evidence.attempt_no', 'does not match the URL');
        const recorderParty = partyOf(bet0, att.recorded_by_user_id);
        if (recorderParty && evidence.recorded_by !== recorderParty) {
          bad('evidence.recorded_by', `must be ${recorderParty}`);
        }
        const parts = form.getAll('frame');
        if (parts.length < MIN_FRAMES || parts.length > MAX_FRAMES) {
          bad('frame', `send ${MIN_FRAMES} to ${MAX_FRAMES} frames (got ${parts.length})`);
        }
        if (evidence.frames.length !== parts.length) {
          bad(
            'evidence.frames',
            `lists ${evidence.frames.length} frames, body has ${parts.length}`,
          );
        }
        const frames: { t_ms: number; sha256: string; bytes: Uint8Array }[] = [];
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]!;
          const meta = evidence.frames[i]!;
          if (meta.index !== i) bad(`evidence.frames.${i}.index`, `expected ${i}`);
          if (typeof p === 'string') bad(`frame.${i}`, 'must be a JPEG file part');
          const blob = p as Blob;
          if (blob.size > MAX_FRAME_BYTES) {
            throw new HttpError('PAYLOAD_TOO_LARGE', `Frame ${i} is over 200 KB.`, { index: i });
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (!isJpeg(bytes)) bad(`frame.${i}`, 'not a JPEG');
          const got = sha256Hex(bytes);
          if (got !== meta.sha256) {
            throw new HttpError('FRAME_HASH_MISMATCH', `Frame ${i} doesn't match its hash.`, {
              index: i,
              expected: meta.sha256,
              got,
            });
          }
          frames.push({ t_ms: meta.t_ms, sha256: got, bytes });
        }
        const frameHashes = frames.map((f) => f.sha256);
        const terms = await termsFor(deps, bet0);
        const now = deps.now();

        const out = await deps.db.transaction(async (tx) => {
          const bet = await lockBet(tx, betId);
          const [a] = await tx
            .select()
            .from(attempts)
            .where(eq(attempts.id, att.id))
            .for('update')
            .limit(1);
          if (bet.state !== 'ATTEMPT' || a?.status !== 'recording') {
            throw new HttpError('ATTEMPT_NOT_OPEN', 'This attempt is not open.', {
              state: bet.state,
            });
          }
          await tx
            .update(attempts)
            .set({
              status: 'judging',
              uploaded_at: new Date(now),
              client_clip_hash: evidence.clip_sha256,
              clip_mime: evidence.mime,
              clip_bytes: evidence.clip_bytes,
              duration_ms: evidence.duration_ms,
              evidence_canonical: jcs(evidence),
              frame_hashes: frameHashes,
              frame_ts_ms: frames.map((f) => f.t_ms),
            })
            .where(eq(attempts.id, att.id));
          await tx.insert(attemptFrames).values(
            frames.map((f, i) => ({
              attempt_id: att.id,
              idx: i,
              t_ms: f.t_ms,
              sha256: f.sha256,
              bytes: f.bytes,
            })),
          );
          await versionedState(tx, bet, { state: 'JUDGING' });
          const events: BetEventEnvelope[] = [
            await appendBetEvent(tx, {
              bet_id: bet.id,
              type: 'bet.state',
              payload: stateEvent(bet, 'JUDGING', bet.state, null),
              now,
            }),
            await appendBetEvent(tx, {
              bet_id: bet.id,
              type: 'attempt.evidence',
              payload: { evidence, frame_urls: [] },
              now,
            }),
          ];
          return { events, room_id: bet.room_id };
        });
        for (const e of out.events) deps.hub.publishBetEvent(e, out.room_id);

        startJob(deps, {
          bet_id: betId,
          attempt_id: att.id,
          attempt_no: n,
          terms,
          evidence_hash: evidence.clip_sha256,
          frame_hashes: frameHashes,
          frames,
          received_at: now,
        });

        const res: FramesAcceptedResponse = {
          judging: true,
          frame_hashes: frameHashes,
          clip_upload: null,
        };
        return c.json(res, 202);
      });
    },
  };
}

/** The module routes.ts mounts. deps.onRuling (AppDeps) is the payout hook. */
export const judgeRoutes: JudgeRouteModule = createJudgeRoutes();
