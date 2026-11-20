// The judge pipeline's routes. A party starts an attempt (POST …/attempts: LOCKED, or JUDGING
// after a REDO, -> ATTEMPT); the recorder device uploads its frames (…/frames), or a Dance Off's
// pose series and key frames (…/dance), -> JUDGING; PATCH /v1/devices/current binds a judge cam
// to a room. A background ruling job then commits the Ruling and its events in one transaction
// and calls deps.onRuling: the payout stream sends `resolve` and moves the bet to RULED once it
// confirms. A REDO leaves the bet in JUDGING with the attempt 'redo', which is what lets
// POST …/attempts open attempt_no + 1.
//
// There is no object storage: frames are kept in Postgres (attempt_frames), `clip_upload` is null
// and attempt.evidence's frame_urls is always empty.
//
// Spec: docs/planning/API-CONTRACT.md §2.9.
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { attemptFrames, attempts, auditLog, bets, devices, rulings, users } from '@youre-on/db';
import type { DanceUploadResponse } from '@youre-on/shared/api';
import { buildDanceEvidence } from '@youre-on/shared/dance/evidence';
import { poseSha256 } from '@youre-on/shared/dance/pose';
import { routineSha256 } from '@youre-on/shared/dance/routine';
import { isDanceOff, parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import {
  CameraEvidence,
  DANCE_FRAME_MAX_BYTES,
  DanceEvidence,
  DanceUpload,
} from '@youre-on/shared/evidence';
import {
  MAX_FRAME_BYTES as SHARED_MAX_FRAME_BYTES,
  MAX_JUDGE_FRAMES,
  MIN_JUDGE_FRAMES,
  judgeFramesProblem,
} from '@youre-on/shared/judge/frames';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { sha256Hex, Uuid, type Party } from '@youre-on/shared/primitives';
import type { DanceScoredPayload } from '@youre-on/shared/realtime';
import type { Ruling } from '@youre-on/shared/ruling';
import type { Terms } from '@youre-on/shared/terms';
import type { AppDeps, AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { parseWith, readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import type { JudgeCue } from '../bets/cues';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { assertRoomLive, getRoomOr404, isActiveMember } from '../rooms/service';
import { chainAckOf, partyOf, toOnchainStatus, type BetRow } from '../bets/snapshot';
import {
  attemptArmedCue,
  danceArmedCue,
  danceRulingCue,
  rulingCue,
  type DanceVoidWhy,
} from './cues';
import { buildDanceRuling, callDanceValidator, type DanceCheck } from './dance';
import { danceFacesIdentified } from './dance-faces';
import {
  applyCameraVeto,
  runAttemptChecks,
  storeAttemptChecks,
  warmForAttempt,
  type CheckRun,
} from './camera-checks';
import { buildRuling, judgeFrames, rulingCanonical, type Judged } from './ruling';
import {
  DevicePatchRequest,
  StartAttemptRequest,
  type FramesAcceptedResponse,
  type StartAttemptResponse,
} from './schemas';
import { loadFinalTerms, termsMatchBet, type TermsLoader } from './terms';

/** Shared by POST …/attempts, …/frames and …/dance: 6/min per bet. */
export const ATTEMPTS_BUCKET = { limit: 6, windowMs: 60_000 } as const;
/** The judge cam's 3-2-1 before GO. */
export const GO_DELAY_MS = 3_000;
/** Recording time per try: max_ms = MS_PER_TRY × attempts.count. */
export const MS_PER_TRY = 6_000;
/**
 * Frames per upload, the landing crop not counted: the phone sends 12, clustered at the end (more
 * would slow the ruling); 8 is still accepted from older phones and scripts/cp1-drive.
 */
export const MIN_FRAMES = MIN_JUDGE_FRAMES;
export const MAX_FRAMES = MAX_JUDGE_FRAMES;
/** Each JPEG ≤ 200 KB, the landing crop included (= the attempt_frames_size CHECK). */
export const MAX_FRAME_BYTES = SHARED_MAX_FRAME_BYTES;
/** The frames multipart body: 13 × 200 KB (12 frames + the crop) + the evidence JSON + overhead. */
export const FRAMES_BODY_LIMIT = 3 * 1024 * 1024;
/**
 * How old a 'judging' upload must be before resumeStuck presumes its job lost (a restart
 * mid-call, or a crash before its commit). Longer than any call a live job waits on
 * (JUDGE_TIMEOUT_MS 10 s, SAM_TIMEOUT_MS ≤ 15 s in parallel, DANCE_TIMEOUT_MS 8 s) plus the
 * commit, so a live job is never doubled.
 */
export const STUCK_JUDGING_MS = 20_000;
/** gg_secs in the RULING cue when APPEAL_WINDOW_S is unset. */
const DEFAULT_GG_SECS = 10;
/**
 * A dance attempt's recording window, instead of MS_PER_TRY × count. Each routine has its own
 * length (5..40 s); this fits the longest (40 s) + the count-in (3 beats, ≤ 4.5 s at 40 bpm) +
 * the recording tail, with slack. Informational: the phone stops on the routine's end.
 */
export const DANCE_MAX_MS = 50_000;
/**
 * The dance multipart: ≤ 6 key frames × 200 KB (1.2 MB) + the PoseSeries JSON. A 40 s round +
 * count-in at the 30 fps cap is ~1300 frames (POSE_MAX_FRAMES 1500), ≤ ~720 bytes each with both
 * players (2 × 57 ints of ≤ 5 digits), so ≤ ~1.1 MB of poses. 4 MiB leaves ~1.7 MB of margin.
 */
export const DANCE_BODY_LIMIT = 4 * 1024 * 1024;

/** States POST …/attempts may be called in (ATTEMPT/JUDGING only for a replay or after a REDO). */
const ATTEMPT_FROM: readonly BetRow['state'][] = ['LOCKED', 'ATTEMPT', 'JUDGING'];

const FRAMES_PATH = /^\/v1\/bets\/[^/]+\/attempts\/\d+\/frames$/;
const DANCE_PATH = /^\/v1\/bets\/[^/]+\/attempts\/\d+\/dance$/;

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];
type AttemptRow = typeof attempts.$inferSelect;

interface JobBase {
  bet_id: string;
  attempt_id: string;
  attempt_no: number;
  terms: Terms;
  /** What `resolve` commits: CameraEvidence.clip_sha256, or hashJcs(DanceEvidence). */
  evidence_hash: string;
  frame_hashes: string[];
  received_at: number;
}

/** A camera (skill) attempt: the vision judge rules on the frames. */
interface CameraJob extends JobBase {
  kind: 'camera';
  /** In send order; the landing crop (if any) last. */
  frames: { t_ms: number; bytes: Uint8Array; landing_crop?: boolean | undefined }[];
  /** CameraEvidence.duration_ms (the prompt's landing window). */
  duration_ms: number | undefined;
}

/** A dance round: the score decides, the round check (./dance.ts) only validates. */
interface DanceJob extends JobBase {
  kind: 'dance';
  /** The server-built record; evidence_hash = hashJcs(evidence). */
  evidence: DanceEvidence;
  /** The key frames, in evidence.frames order. */
  frames: { t_ms: number; bytes: Uint8Array }[];
}

type Job = CameraJob | DanceJob;

/** What a ruling job commits, whichever judge produced it. */
interface Produced {
  ruling: Ruling;
  /** jcs of the record evidence_hash commits to (rulings.evidence_canonical), or null. */
  evidence_canonical: string | null;
  /** dance.scored, appended just before ruling.issued in the same commit. */
  scored: DanceScoredPayload | null;
  /**
   * The camera checks' run (camera-checks.ts): attempt_checks + checks.report in the same commit,
   * before ruling.issued. Always null for a dance round.
   */
  checks: { run: CheckRun; veto: Parameters<typeof storeAttemptChecks>[1]['veto'] } | null;
  cue: JudgeCue;
  /** Extra audit details. */
  audit: Record<string, unknown>;
}

export interface JudgeRoutesOptions {
  /** Where the frozen Terms come from (default: loadFinalTerms, from bet_terms_versions). */
  loadTerms?: TermsLoader;
}

export interface JudgeRouteModule extends RouteModule {
  /** Resolves when every ruling job started so far has finished (the tests await it). */
  idle(): Promise<void>;
  /**
   * Re-runs the ruling jobs that are lost (up to 20 per call): attempt 'judging' on a JUDGING
   * bet, uploaded more than `olderThanMs` ago, with no job for it in this process. Registered as
   * the keeper task 'judge-stuck'; returns how many it restarted.
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
 * never be their own recorder: a judge cam the performer binds to the room is ignored.
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

/**
 * Dance Off: both parties dance, so neither is neutral, and the round is filmed by A's side only:
 * the room's judge cam, else A's phone. The judge cam is a second device of A (the mobile
 * judge-cam poll follows A's bets), so only A's judge-cam devices count: a judge cam B binds to
 * the room never becomes a dance recorder (the recorder uploads the whole PoseSeries).
 */
export async function findDanceJudgeCam(db: Pick<AppDeps['db'], 'select'>, bet: BetRow) {
  // findJudgeCam takes the PERFORMER and returns the other party's cam: 'B' -> A's devices.
  return findJudgeCam(db, bet, 'B');
}

/** The upload's CameraEvidence as stored (attempts.evidence_canonical), or null. */
function storedEvidence(att: AttemptRow): CameraEvidence | null {
  if (!att.evidence_canonical) return null;
  try {
    const r = CameraEvidence.safeParse(JSON.parse(att.evidence_canonical));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A dance round's DanceEvidence as stored (attempts.evidence_canonical), or null. */
function storedDanceEvidence(att: Pick<AttemptRow, 'evidence_canonical'>): DanceEvidence | null {
  if (!att.evidence_canonical) return null;
  try {
    const r = DanceEvidence.safeParse(JSON.parse(att.evidence_canonical));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The 202 to a dance upload (also its replay): the server's scores, never the phone's. */
function danceAccepted(e: DanceEvidence, client: { a: number; b: number }): DanceUploadResponse {
  return {
    judging: true,
    evidence_hash: hashJcs(e),
    pose_sha256: e.pose_sha256,
    scores: { a: e.scores.a, b: e.scores.b },
    client_mismatch: client.a !== e.scores.a || client.b !== e.scores.b,
    frame_hashes: e.frames.map((f) => f.sha256),
  };
}

/**
 * Evidence provenance: only the attempt's recorder device may upload, and for a judge_cam
 * attempt only while it is still this room's judge cam.
 */
export async function assertRecorder(
  deps: AppDeps,
  att: AttemptRow,
  bet: BetRow,
  deviceId: string,
): Promise<void> {
  const notRecorder = () =>
    new HttpError('NOT_A_PARTY', "Only this room's judge cam can upload frames.", {
      reason: 'not_recorder',
    });
  if (att.recorded_by_device_id !== deviceId) throw notRecorder();
  if (att.recorder === 'judge_cam') {
    const [dev] = await deps.db
      .select({
        role: devices.role,
        room: devices.judge_room_id,
        revoked: devices.revoked_at,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!dev || dev.role !== 'judge_cam' || dev.room !== bet.room_id || dev.revoked) {
      throw notRecorder();
    }
  }
}

/** The multipart body (the signing middleware already buffered it); 422 when it isn't one. */
async function readForm(c: Context<AppEnv>, what: string): Promise<FormData> {
  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError('VALIDATION_FAILED', `Send the ${what} as multipart/form-data.`, {
      issues: [{ path: 'content-type', message: 'multipart/form-data required' }],
    });
  }
  try {
    const raw = await c.req.arrayBuffer();
    return await new Response(raw, { headers: { 'content-type': ct } }).formData();
  } catch {
    throw new HttpError('VALIDATION_FAILED', 'That upload could not be read.', {
      issues: [{ path: '', message: 'invalid multipart body' }],
    });
  }
}

/** A JSON part (a string field or a file part), or 422 naming the part. */
async function jsonPart(form: FormData, name: string, message: string): Promise<unknown> {
  const part = form.get(name);
  try {
    return JSON.parse(typeof part === 'string' ? part : part ? await part.text() : '');
  } catch {
    throw new HttpError('VALIDATION_FAILED', `The ${name} part is missing or not JSON.`, {
      issues: [{ path: name, message }],
    });
  }
}

/** POST …/attempts found no judge cam: the phone's cue to record itself ('self'). */
const isNoJudgeCam = (e: unknown) =>
  e instanceof HttpError && e.code === 'INVALID_STATE' && e.details?.reason === 'no_judge_cam';

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
    // A dance off has no single performer (both dance); every other camera bet has one.
    if (terms.evidence_source !== 'camera' || (terms.performer === null && !isDanceOff(terms))) {
      throw new HttpError('INVALID_STATE', 'This bet is not judged on camera.', {
        state: bet.state,
        reason: 'not_camera',
      });
    }
    return terms;
  }

  // ---- the ruling job --------------------------------------------------------------------

  /** The camera judge: the vision verdict (or `forced`) -> the Ruling (buildRuling). */
  async function produceCamera(
    deps: AppDeps,
    job: CameraJob,
    bet0: BetRow,
    names: { A: string; B: string },
    /** Skip the vision call and commit this instead (see runRuling). */
    forced: Judged | undefined,
  ): Promise<{ produced: Produced; now: number }> {
    // Camera checks (camera-checks.ts): SAM on the regular frames (never the landing crop), in
    // parallel with the vision call. null = no camera checks for this attempt: the bottle checks
    // (checks.ts) alone apply.
    const regular = job.frames.flatMap((f, i) =>
      f.landing_crop ? [] : [{ t_ms: f.t_ms, bytes: f.bytes, hash: job.frame_hashes[i]! }],
    );
    const checksP: Promise<CheckRun | null> = forced
      ? Promise.resolve(null)
      : runAttemptChecks(deps, {
          bet_id: job.bet_id,
          attempt_no: job.attempt_no,
          terms_hash: bet0.terms_hash!,
          frames: regular,
          frame_hashes: regular.map((f) => f.hash),
          duration_ms: job.duration_ms,
        });
    let judged =
      forced ??
      (await judgeFrames(deps, {
        terms: job.terms,
        performer_name: names[job.terms.performer ?? 'B'],
        frames: job.frames,
        duration_ms: job.duration_ms,
      }));
    const checks = await checksP;
    let veto: Parameters<typeof storeAttemptChecks>[1]['veto'] = null;
    if (checks) ({ judged, veto } = applyCameraVeto(judged, checks, job.terms.yes_party));
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
    return {
      now,
      produced: {
        ruling,
        evidence_canonical: null,
        scored: null,
        checks: checks ? { run: checks, veto } : null,
        cue: rulingCue(ruling, names, deps.env.APPEAL_WINDOW_S ?? DEFAULT_GG_SECS),
        audit: {
          ...(judged.kind === 'failure' ? { llm_status: judged.status } : {}),
          ...(judged.kind === 'verdict' && judged.disagreement
            ? { checks_disagree: judged.disagreement }
            : {}),
          ...(checks
            ? {
                camera_checks: {
                  status: checks.report.status,
                  gate: checks.report.gate,
                  need: checks.report.need,
                  report_hash: checks.report_hash,
                  veto: veto?.kind ?? null,
                  sam_ms: checks.sam_ms,
                },
              }
            : {}),
        },
      },
    };
  }

  /**
   * A dance round: the round check (or, when `forced`, a skipped check: no model call, the round
   * settles on the score) -> the deterministic ruling + dance.scored.
   */
  async function produceDance(
    deps: AppDeps,
    job: DanceJob,
    bet0: BetRow,
    names: { A: string; B: string },
    forced: Judged | undefined,
  ): Promise<{ produced: Produced; now: number }> {
    const check: DanceCheck = forced
      ? {
          kind: 'skipped',
          model: forced.model,
          status: forced.kind === 'failure' ? forced.status : 'forced',
          message: forced.kind === 'failure' ? forced.message : '',
        }
      : await callDanceValidator(deps, {
          terms: job.terms,
          names,
          evidence: job.evidence,
          frames: job.frames,
        });
    const now = deps.now();
    const d = buildDanceRuling(
      {
        ruling_id: randomUUID(),
        bet_id: job.bet_id,
        attempt_no: job.attempt_no,
        terms_hash: bet0.terms_hash!,
        evidence_hash: job.evidence_hash,
        frame_hashes: job.frame_hashes,
        created_at: new Date(now).toISOString(),
      },
      job.evidence,
      check,
      names,
    );
    const why: DanceVoidWhy | null =
      d.ruling.outcome !== 'VOID'
        ? null
        : d.validation.verdict === 'invalid'
          ? 'invalid'
          : (job.evidence.failed ?? 'too_close');
    return {
      now,
      produced: {
        ruling: d.ruling,
        // = the attempt's evidence_canonical
        evidence_canonical: jcs(job.evidence),
        scored: {
          evidence: job.evidence,
          evidence_hash: job.evidence_hash,
          validation: d.validation,
          announcer_line: d.announcer_line,
        },
        checks: null,
        cue: danceRulingCue(
          d.ruling,
          job.evidence.scores,
          why,
          names,
          deps.env.APPEAL_WINDOW_S ?? DEFAULT_GG_SECS,
        ),
        audit: {
          validation: d.validation.verdict,
          check_model: check.model,
          scores: job.evidence.scores,
          ...(check.kind === 'skipped' ? { llm_status: check.status } : {}),
        },
      },
    };
  }

  async function runRuling(
    deps: AppDeps,
    job: Job,
    /**
     * Skip the model call and commit this instead (the failure fallback of startJob, the keeper
     * sweep). For a dance round it means: the check is skipped, the score settles it.
     */
    forced?: Judged,
  ): Promise<void> {
    const [bet0] = await deps.db.select().from(bets).where(eq(bets.id, job.bet_id)).limit(1);
    if (!bet0) return;
    const names = await displayNames(deps.db, bet0);
    const { produced, now } =
      job.kind === 'dance'
        ? await produceDance(deps, job, bet0, names, forced)
        : await produceCamera(deps, job, bet0, names, forced);
    const ruling = produced.ruling;
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
        // a dance round is camera evidence too (no pg enum change); its record is the
        // DanceEvidence JCS, and sha256(evidence_canonical) = evidence_hash (rulings CHECK)
        evidence_kind: 'camera',
        evidence_hash: ruling.evidence_hash,
        evidence_canonical: produced.evidence_canonical,
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
      const events: BetEventEnvelope[] = [];
      // checks.report first, so a client has the boxes when the ruling lands (camera judge only).
      if (produced.checks) {
        events.push(
          ...(await storeAttemptChecks(tx, {
            bet_id: bet.id,
            attempt_no: job.attempt_no,
            run: produced.checks.run,
            veto: produced.checks.veto,
            now,
          })),
        );
      }
      // dance.scored next (the market.settled precedent): the scores are in before the ruling.
      if (produced.scored) {
        events.push(
          await appendBetEvent(tx, {
            bet_id: bet.id,
            type: 'dance.scored',
            payload: produced.scored,
            now,
          }),
        );
      }
      events.push(
        await appendBetEvent(tx, {
          bet_id: bet.id,
          type: 'ruling.issued',
          payload: { ruling, ruling_hash: hash },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: bet.id,
          type: 'judge.cue',
          payload: produced.cue,
          now,
        }),
      );
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
          ...produced.audit,
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

  /**
   * Runs the ruling job in the background, at most one per attempt in this process. If it
   * throws (a DB error, a bug), it commits a REDO 'unclear' through the same path, as for a
   * model failure, so the bet never sits in JUDGING (a dance round instead settles on its score,
   * the check skipped). If even that fails, the keeper sweep (resumeStuck) or a replayed upload
   * re-runs it.
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
    if (isDanceOff(terms)) {
      // evidence_hash = hashJcs(the stored DanceEvidence), never client_clip_hash (a stand-in
      // when the phone kept no clip).
      const evidence = storedDanceEvidence(att);
      if (!evidence) {
        deps.log.error('judge.dance_evidence_unreadable', {
          bet_id: bet.id,
          attempt_no: att.attempt_no,
        });
        return false;
      }
      deps.log.warn('judge.job_restarted', {
        bet_id: bet.id,
        attempt_no: att.attempt_no,
        forced: forced?.kind ?? null,
        kind: 'dance',
      });
      return startJob(
        deps,
        {
          kind: 'dance',
          bet_id: bet.id,
          attempt_id: att.id,
          attempt_no: att.attempt_no,
          terms,
          evidence,
          evidence_hash: hashJcs(evidence),
          frame_hashes: att.frame_hashes,
          frames: stored.map((f) => ({ t_ms: f.t_ms, bytes: new Uint8Array(f.bytes) })),
          received_at: att.uploaded_at.getTime(),
        },
        forced,
      );
    }
    // Which stored frame is the landing crop: the evidence record says (frames[i].landing_crop).
    const crops = new Set(
      storedEvidence(att)?.frames.flatMap((f) => (f.landing_crop ? [f.index] : [])),
    );
    deps.log.warn('judge.job_restarted', {
      bet_id: bet.id,
      attempt_no: att.attempt_no,
      forced: forced?.kind ?? null,
    });
    return startJob(
      deps,
      {
        kind: 'camera',
        bet_id: bet.id,
        attempt_id: att.id,
        attempt_no: att.attempt_no,
        terms,
        evidence_hash: att.client_clip_hash,
        frame_hashes: att.frame_hashes,
        frames: stored.map((f, i) => ({
          t_ms: f.t_ms,
          bytes: new Uint8Array(f.bytes),
          ...(crops.has(i) ? { landing_crop: true } : {}),
        })),
        duration_ms: att.duration_ms ?? undefined,
        received_at: att.uploaded_at.getTime(),
      },
      forced,
    );
  }

  /**
   * The keeper sweep: a lost job gets a REDO 'unclear' through the normal commit path (no new
   * model call, so a job that keeps dying never loops on a paid API), and the judge says
   * "Run it back"; a lost dance round settles on its score (the check skipped). A replayed
   * upload instead re-runs the model call.
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
    bodyLimits: [
      { path: FRAMES_PATH, maxBytes: FRAMES_BODY_LIMIT },
      { path: DANCE_PATH, maxBytes: DANCE_BODY_LIMIT },
    ],

    async idle() {
      while (jobs.size) await Promise.allSettled([...jobs.values()]);
    },

    resumeStuck,

    register(app, deps) {
      deps.keeper?.register({
        name: 'judge-stuck',
        run: (nowMs) => resumeStuck(deps, nowMs),
      });

      // ---- PATCH /v1/devices/current -----------------------------------------------------
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

      // ---- POST /v1/bets/:bet_id/attempts ------------------------------------------------
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
        // Dance Off: both dance, so the attempt names the yes party (A) as `performer` (the
        // event's field is a Party), and only A's side films it (findDanceJudgeCam).
        const dance = isDanceOff(terms);
        const performer: Party = terms.performer ?? terms.yes_party;
        if (dance) {
          // The recorder uploads the whole PoseSeries, so B's phone never records a dance off.
          if (body.recorder === 'self' && partyOf(bet0, me.user_id) !== 'A') {
            throw new HttpError('NOT_A_PARTY', "A's phone films the dance off.", {
              reason: 'recorder_is_a',
            });
          }
        } else if (body.recorder === 'self' && partyOf(bet0, me.user_id) === performer) {
          // 'self' = the caller's phone records, so only the non-performer may ask for it.
          throw new HttpError('NOT_A_PARTY', "You can't record your own attempt.", {
            reason: 'performer_cannot_record',
          });
        }
        const names = await displayNames(deps.db, bet0);
        const now = deps.now();

        const started = deps.db.transaction(async (tx) => {
          const bet = await lockBet(tx, betId);
          const prior = await tx
            .select()
            .from(attempts)
            .where(eq(attempts.bet_id, betId))
            .orderBy(desc(attempts.attempt_no));
          const same = prior.find((a) => a.attempt_no === body.attempt_no);
          // Idem (bet_id, attempt_no): the same attempt, still current and still live
          // (recording, or its evidence in with the judge), replays its 201. One that is over
          // (ruled, including a called-off one from ./call-off.ts, or redo) does not.
          if (
            same &&
            same === prior[0] &&
            (same.status === 'recording' ||
              same.status === 'uploaded' ||
              same.status === 'judging') &&
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
            const cam = dance
              ? await findDanceJudgeCam(tx, bet)
              : await findJudgeCam(tx, bet, performer);
            if (!cam) {
              throw new HttpError('INVALID_STATE', 'No judge cam is set up in this room.', {
                state: bet.state,
                reason: 'no_judge_cam',
              });
            }
            recorder = cam;
          } else {
            // A dance off with a judge cam in the room is filmed by that cam, never a phone.
            if (dance && (await findDanceJudgeCam(tx, bet))) {
              throw new HttpError('INVALID_STATE', 'The judge cam films this dance off.', {
                state: bet.state,
                reason: 'judge_cam_present',
              });
            }
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
              max_ms: dance ? DANCE_MAX_MS : MS_PER_TRY * terms.attempts.count,
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
              payload: dance
                ? danceArmedCue(res.attempt_no, names)
                : attemptArmedCue(res.attempt_no, names[performer]),
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
        // No judge cam (409 no_judge_cam): nothing was written, and the phone asks again with
        // 'self' (two phones, apps/mobile/src/attempt/recorder.ts). The refusal gives its token
        // back, so the fallback spends no more of the bet's 6/min than the judge-cam path.
        const out = await started.catch((e: unknown) => {
          if (isNoJudgeCam(e)) deps.rateLimit?.refund('attempts', betId, ATTEMPTS_BUCKET);
          throw e;
        });

        for (const e of out.events) deps.hub.publishBetEvent(e, bet0.room_id);
        // Recording starts: wake SAM if this bet has camera checks (fire-and-forget; a dance off
        // never has any).
        if (!dance) void warmForAttempt(deps, betId);
        // The judge cam may only be on its user channel; the hub dedupes by seq per socket.
        if (out.recorderUser) {
          for (const e of out.events) deps.hub.publishToUser(out.recorderUser, e);
        }
        return c.json(out.res, 201);
      });

      // ---- POST /v1/bets/:bet_id/attempts/:n/frames --------------------------------------
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

        await assertRecorder(deps, att, bet0, me.device_id);
        // Only the recorder spends the per-bet bucket (see POST /attempts).
        deps.rateLimit?.take('attempts', betId, ATTEMPTS_BUCKET);

        const form = await readForm(c, 'frames');
        const evRaw = await jsonPart(form, 'evidence', 'JSON CameraEvidence required');
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
        if (evidence.frames.length !== parts.length) {
          bad(
            'evidence.frames',
            `lists ${evidence.frames.length} frames, body has ${parts.length}`,
          );
        }
        // MIN_JUDGE_FRAMES..MAX_JUDGE_FRAMES frames, plus at most one landing crop, sent last.
        const problem = judgeFramesProblem(evidence.frames);
        if (problem) bad(problem.path, problem.message);
        const frames: {
          t_ms: number;
          sha256: string;
          bytes: Uint8Array;
          landing_crop?: boolean;
        }[] = [];
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
          frames.push({
            t_ms: meta.t_ms,
            sha256: got,
            bytes,
            ...(meta.landing_crop ? { landing_crop: true } : {}),
          });
        }
        const frameHashes = frames.map((f) => f.sha256);
        const terms = await termsFor(deps, bet0);
        if (isDanceOff(terms)) {
          throw new HttpError('INVALID_STATE', 'Send a dance round to …/dance.', {
            state: bet0.state,
            reason: 'dance_upload',
          });
        }
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
          kind: 'camera',
          bet_id: betId,
          attempt_id: att.id,
          attempt_no: n,
          terms,
          evidence_hash: evidence.clip_sha256,
          frame_hashes: frameHashes,
          frames,
          duration_ms: evidence.duration_ms,
          received_at: now,
        });

        const res: FramesAcceptedResponse = {
          judging: true,
          frame_hashes: frameHashes,
          clip_upload: null,
        };
        return c.json(res, 202);
      });

      // ---- POST /v1/bets/:bet_id/attempts/:n/dance ---------------------------------------
      app.post('/v1/bets/:bet_id/attempts/:n/dance', requireSignedRequest, async (c) => {
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
        await assertRecorder(deps, att, bet0, me.device_id);
        deps.rateLimit?.take('attempts', betId, ATTEMPTS_BUCKET);

        const form = await readForm(c, 'round');
        const upload = parseWith(
          DanceUpload,
          await jsonPart(form, 'upload', 'JSON DanceUpload required'),
        );

        // Idem (bet_id, n) + pose_sha256 + the frame hashes: the same round replays the 202 (and
        // restarts a lost job), another is refused.
        if (att.client_clip_hash !== null) {
          const prior = storedDanceEvidence(att);
          if (
            prior &&
            prior.pose_sha256 === upload.pose_sha256 &&
            sameList(
              prior.frames.map((f) => f.sha256),
              upload.frames.map((f) => f.sha256),
            )
          ) {
            await restartJob(deps, bet0, att).catch((e: unknown) =>
              deps.log.error('judge.resume_failed', { bet_id: betId, err: String(e) }),
            );
            return c.json(danceAccepted(prior, upload.client_scores), 202);
          }
          throw new HttpError('ATTEMPT_NOT_OPEN', 'This round is already in.');
        }
        if (bet0.state !== 'ATTEMPT' || att.status !== 'recording') {
          throw new HttpError('ATTEMPT_NOT_OPEN', 'This attempt is not open.', {
            state: bet0.state,
          });
        }

        const terms = await termsFor(deps, bet0);
        if (!isDanceOff(terms)) {
          throw new HttpError('INVALID_STATE', 'This bet is not a dance off.', {
            state: bet0.state,
            reason: 'not_dance',
          });
        }
        // The routine the terms commit to (id, version, sha256 prefix), from THIS server's bundle.
        const ref = parseDanceTermsRoutine(terms);
        if (!ref.ok) {
          deps.log.error('judge.dance_routine_unavailable', { bet_id: betId, reason: ref.reason });
          throw new HttpError('INVALID_STATE', "This server doesn't have that routine.", {
            state: bet0.state,
            reason: 'routine_unavailable',
          });
        }
        const routine = ref.routine;
        if (upload.routine_id !== routine.id || upload.routine_sha256 !== routineSha256(routine)) {
          throw new HttpError('VALIDATION_FAILED', 'That is not the routine of this bet.', {
            issues: [
              upload.routine_id !== routine.id
                ? { path: 'upload.routine_id', message: `must be ${routine.id}` }
                : { path: 'upload.routine_sha256', message: 'not the routine these terms name' },
            ],
            reason: 'wrong_routine',
          });
        }
        // The hashed pose series: what the server scores is what the phone hashed.
        const pose = poseSha256(upload.series);
        if (pose !== upload.pose_sha256) {
          throw new HttpError('EVIDENCE_HASH_MISMATCH', "The pose data doesn't match its hash.", {
            what: 'pose',
            expected: upload.pose_sha256,
            got: pose,
          });
        }

        const bad = (path: string, message: string): never => {
          throw new HttpError('VALIDATION_FAILED', undefined, { issues: [{ path, message }] });
        };
        const parts = form.getAll('frame');
        if (upload.frames.length !== parts.length) {
          bad('upload.frames', `lists ${upload.frames.length} frames, body has ${parts.length}`);
        }
        const frames: { t_ms: number; sha256: string; bytes: Uint8Array }[] = [];
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]!;
          const meta = upload.frames[i]!;
          if (meta.index !== i) bad(`upload.frames.${i}.index`, `expected ${i}`);
          if (typeof p === 'string') bad(`frame.${i}`, 'must be a JPEG file part');
          const blob = p as Blob;
          if (blob.size > DANCE_FRAME_MAX_BYTES) {
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

        // Re-score on the server (the shared scorer over the dequantized series): the phone's
        // client_scores are only compared, never used.
        const { evidence } = buildDanceEvidence({
          bet_id: betId,
          attempt_no: n,
          terms_hash: bet0.terms_hash!,
          routine,
          series: upload.series,
          frames: upload.frames.map((f) => ({ index: f.index, t_ms: f.t_ms, sha256: f.sha256 })),
          clip_sha256: upload.clip_sha256,
          // A may start on the right only when this server identified both by face.
          faces_identified: danceFacesIdentified(deps, betId),
        });
        const canonical = jcs(evidence);
        const evidenceHash = sha256Hex(canonical);
        const accepted = danceAccepted(evidence, upload.client_scores);
        if (accepted.client_mismatch) {
          deps.log.warn('judge.dance_client_mismatch', {
            bet_id: betId,
            attempt_no: n,
            client: upload.client_scores,
            server: evidence.scores,
          });
        }
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
              // The clip's hash when the phone kept one, else the record's own hash: a
              // deterministic stand-in (the ruling commits evidence_hash, never this column).
              client_clip_hash: upload.clip_sha256 ?? evidenceHash,
              evidence_hash: evidenceHash,
              evidence_canonical: canonical,
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
          // No attempt.evidence: its payload is CameraEvidence. dance.scored (with the record)
          // comes with the ruling.
          const events: BetEventEnvelope[] = [
            await appendBetEvent(tx, {
              bet_id: bet.id,
              type: 'bet.state',
              payload: stateEvent(bet, 'JUDGING', bet.state, null),
              now,
            }),
          ];
          await tx.insert(auditLog).values({
            actor_kind: 'user',
            actor_user_id: me.user_id,
            action: 'dance.uploaded',
            bet_id: bet.id,
            request_id: c.get('requestId'),
            details: {
              attempt_no: n,
              evidence_hash: evidenceHash,
              pose_sha256: evidence.pose_sha256,
              scores: evidence.scores,
              client_scores: upload.client_scores,
            },
          });
          return { events, room_id: bet.room_id };
        });
        for (const e of out.events) deps.hub.publishBetEvent(e, out.room_id);

        startJob(deps, {
          kind: 'dance',
          bet_id: betId,
          attempt_id: att.id,
          attempt_no: n,
          terms,
          evidence,
          evidence_hash: evidenceHash,
          frame_hashes: frameHashes,
          frames: frames.map((f) => ({ t_ms: f.t_ms, bytes: f.bytes })),
          received_at: now,
        });
        return c.json(accepted, 202);
      });
    },
  };
}

/** The module src/routes.ts mounts. deps.onRuling (AppDeps) is the payout hook. */
export const judgeRoutes: JudgeRouteModule = createJudgeRoutes();
