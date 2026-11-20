// Camera checks (non-binding): SAM 3.1 measurements that can only refuse a verdict.
//
// The CheckSpec is NOT in the hashed Terms. It is compiled server-side from the bet's terms
// (compile-checks.ts) and stored in bet_checks, keyed by the terms_hash it was compiled from; at
// ruling time SAM runs on the attempt's regular frames in parallel with the vision call, the pure
// shared evaluator scores it, and checksVeto may turn a decisive MET into REDO 'unclear' with
// its own template reason (buildRuling, through Judged.disagreement + veto). When these checks
// run they replace the bottle checks (checks.ts), which apply otherwise.
//
//   compile   scheduleCompile(): after each proposed terms version (lock/terms.ts
//             persistEvaluation) and the odds recompose (odds/flow.ts), fire-and-forget; and
//             onTermsFrozen() at confirm (voice/tools.ts confirmAndLock), which makes sure the
//             frozen terms_hash has a row, then warms SAM. Never blocks or fails the terms flow;
//             a row is written only while its terms_hash is still the bet's.
//   warm      warmForAttempt() at POST …/attempts (recording starts), fire-and-forget.
//   rule      runAttemptChecks() (judge/routes.ts produceCamera) -> applyCameraVeto(); the report
//             is stored (attempt_checks) and pushed (checks.report) in the ruling's own commit.
//
// Active only when env CHECKS_ENABLED=true, SAM3_URL + SAM3_API_TOKEN are set (deps.sam), and the
// runtime toggle 'checks' is on (POST /v1/demo/toggles). A ruling under cached_ruling skips them
// (the stored verdict is a replay; vetoing it would make the demo fallback unreliable).
//
// Never for a Dance Off: checksEligible() refuses dance terms, so no bet_checks row is ever
// written for one, and every later step (which needs that row) does nothing.
import { eq } from 'drizzle-orm';
import { attemptChecks, betChecks, bets } from '@youre-on/db';
import { checksVeto, evaluateChecks, P1, type CheckReport } from '@youre-on/shared/checks/evaluate';
import { fromTerms } from '@youre-on/shared/checks/compile';
import { isDanceOff } from '@youre-on/shared/dance/terms';
import type { ChecksBox, ChecksReportPayload } from '@youre-on/shared/checks/events';
import type { SamSegmentReply } from '@youre-on/shared/checks/sam-reply';
import {
  CheckSpec,
  describeChecks,
  lookupOf,
  predicateClause,
  subjectKeys,
} from '@youre-on/shared/checks/spec';
import { hashJcs } from '@youre-on/shared/jcs';
import { toOutcome } from '@youre-on/shared/ruling';
import type { Terms } from '@youre-on/shared/terms';
import type { AppDeps } from '../context';
import { cachedRulingOn, togglesOf } from '../demo/toggles';
import { loadEnvelope } from '../lock/terms';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { compileChecks, type CompileChecksResult } from './compile-checks';
import type { Judged } from './ruling';
import type { SamStatsSnapshot } from './sam';

type Tx = Parameters<Parameters<AppDeps['db']['transaction']>[0]>[0];

/** What the compile side needs (persistEvaluation's deps may lack providers: then no compile). */
export type ChecksDeps = Pick<AppDeps, 'db' | 'hub' | 'log' | 'now' | 'env'> &
  Partial<Pick<AppDeps, 'providers' | 'sam'>>;

/** env + SAM configured (the kill switch and the service). */
export const checksConfigured = (deps: Pick<AppDeps, 'env'> & Partial<Pick<AppDeps, 'sam'>>) =>
  deps.env.CHECKS_ENABLED && deps.sam !== undefined;

/** Configured and the runtime toggle on. */
export const checksActive = (deps: Pick<AppDeps, 'env'> & Partial<Pick<AppDeps, 'sam'>>) =>
  checksConfigured(deps) && togglesOf(deps).checksOn();

// ---- background work, awaitable in tests -------------------------------------------------

const pending = new WeakMap<object, Map<string, Promise<unknown>>>();
/** Runs `start` unless a run under `key` is in flight (then joins it: no duplicate work). */
function track<T>(deps: object, key: string, start: () => Promise<T>): Promise<T> {
  let m = pending.get(deps);
  if (!m) pending.set(deps, (m = new Map()));
  const map = m;
  const existing = map.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const done = start().finally(() => map.delete(key));
  map.set(key, done);
  return done;
}

/** Resolves when every compile / warm started so far has finished (the tests await it). */
export async function checksIdle(deps: object): Promise<void> {
  for (;;) {
    const m = pending.get(deps);
    if (!m || m.size === 0) return;
    await Promise.allSettled([...m.values()]);
  }
}

// ---- compile ----------------------------------------------------------------------------

export interface StoredChecks {
  terms_hash: string;
  decision: 'checks' | 'judge_only';
  spec: CheckSpec | null;
  readback: string;
}

async function readRow(deps: Pick<AppDeps, 'db'>, betId: string) {
  const [row] = await deps.db.select().from(betChecks).where(eq(betChecks.bet_id, betId)).limit(1);
  return row ?? null;
}

async function currentHash(deps: Pick<AppDeps, 'db'>, betId: string): Promise<string | null> {
  const [b] = await deps.db
    .select({ h: bets.terms_hash })
    .from(bets)
    .where(eq(bets.id, betId))
    .limit(1);
  return b?.h ?? null;
}

/**
 * Compiles `terms` and upserts bet_checks, unless the bet already moved to other terms (before
 * or after the call). Pushes checks.compiled when it wrote. Never throws.
 */
async function compileAndStore(
  deps: ChecksDeps & Pick<AppDeps, 'providers'>,
  betId: string,
  terms: Terms,
  termsHash: string,
): Promise<StoredChecks | null> {
  try {
    const have = await readRow(deps, betId);
    // A stored fallback (the compiler failed) is retried: a transient outage must not stick.
    if (have?.terms_hash === termsHash && have.status === 'ok') return toStored(have);
    if ((await currentHash(deps, betId)) !== termsHash) return null;
    const r: CompileChecksResult = await compileChecks(deps, fromTerms(terms));
    const readback = describeChecks(r.spec);
    const values = {
      bet_id: betId,
      terms_hash: termsHash,
      decision: r.decision,
      spec: r.spec as unknown as Record<string, unknown> | null,
      why: r.why.slice(0, 400),
      readback,
      model: r.model,
      prompt_version: r.prompt_version,
      status: r.status,
      created_at: new Date(deps.now()),
    };
    // Written only while these are still the bet's terms (a newer version may have landed).
    const wrote = await deps.db.transaction(async (tx) => {
      const [b] = await tx
        .select({ h: bets.terms_hash })
        .from(bets)
        .where(eq(bets.id, betId))
        .for('update')
        .limit(1);
      if (b?.h !== termsHash) return null;
      await tx
        .insert(betChecks)
        .values(values)
        .onConflictDoUpdate({ target: betChecks.bet_id, set: values });
      return appendBetEvent(tx, {
        bet_id: betId,
        type: 'checks.compiled',
        payload: { terms_hash: termsHash, decision: r.decision, readback },
        now: deps.now(),
      });
    });
    if (!wrote) {
      deps.log.info('checks.compile_stale', { bet_id: betId });
      return null;
    }
    const [room] = await deps.db
      .select({ room_id: bets.room_id })
      .from(bets)
      .where(eq(bets.id, betId))
      .limit(1);
    deps.hub.publishBetEvent(wrote, room?.room_id ?? null);
    deps.log.info('checks.stored', {
      bet_id: betId,
      decision: r.decision,
      status: r.status,
      terms_hash: termsHash.slice(0, 12),
    });
    return { terms_hash: termsHash, decision: r.decision, spec: r.spec, readback };
  } catch (e) {
    deps.log.error('checks.compile_store_failed', { bet_id: betId, err: String(e) });
    return null;
  }
}

function toStored(row: typeof betChecks.$inferSelect): StoredChecks | null {
  if (row.decision === 'judge_only')
    return {
      terms_hash: row.terms_hash,
      decision: 'judge_only',
      spec: null,
      readback: row.readback,
    };
  const spec = CheckSpec.safeParse(row.spec);
  if (!spec.success) return null;
  return {
    terms_hash: row.terms_hash,
    decision: 'checks',
    spec: spec.data,
    readback: row.readback,
  };
}

const canCompile = (deps: ChecksDeps): deps is ChecksDeps & Pick<AppDeps, 'providers'> =>
  deps.providers !== undefined && checksActive(deps);

/**
 * Which terms get camera checks: camera (skill) bets only, and never a dance off (camera
 * evidence, but the pose score decides; the SAM checks would have nothing to measure).
 */
export const checksEligible = (terms: Pick<Terms, 'evidence_source' | 'type'>): boolean =>
  terms.evidence_source === 'camera' && !isDanceOff(terms);

/**
 * Fire-and-forget: compile this terms version (one in flight per bet + terms_hash). A no-op while
 * checks are inactive. Returns the promise for tests; callers never await it.
 */
export function scheduleCompile(
  deps: ChecksDeps,
  betId: string,
  terms: Terms,
  termsHash: string,
): Promise<StoredChecks | null> {
  if (!canCompile(deps) || !checksEligible(terms)) return Promise.resolve(null);
  return track(deps, `compile:${betId}:${termsHash}`, () =>
    compileAndStore(deps, betId, terms, termsHash),
  );
}

/** Fire-and-forget: compile the bet's current terms (latest version) if not stored yet. */
export function scheduleCompileCurrent(
  deps: ChecksDeps,
  betId: string,
): Promise<StoredChecks | null> {
  if (!canCompile(deps)) return Promise.resolve(null);
  const run = async () => {
    try {
      const h = await currentHash(deps, betId);
      const latest = await loadEnvelope(deps.db, betId);
      if (!h || !latest || latest.envelope.terms_hash !== h) return null;
      return await scheduleCompile(deps, betId, latest.envelope.terms, h);
    } catch (e) {
      deps.log.error('checks.compile_current_failed', { bet_id: betId, err: String(e) });
      return null;
    }
  };
  // Not deduped here (the hash is read inside, so an older in-flight run must not be joined by a
  // call made for newer terms); scheduleCompile dedupes per terms_hash. Tracked for checksIdle.
  return track(deps, `current:${betId}:${++currentSeq}`, run);
}
let currentSeq = 0;

/**
 * At confirm (the terms are frozen and the lock starts): make sure the frozen terms_hash has its
 * row (compiling now if a proposal-time compile never ran or was stale), then warm SAM for a
 * 'checks' bet. Fire-and-forget; never throws.
 */
export function onTermsFrozen(deps: ChecksDeps, betId: string): Promise<void> {
  if (!canCompile(deps)) return Promise.resolve();
  const run = async () => {
    try {
      let s = await scheduleCompileCurrent(deps, betId);
      if (!s) {
        // stale or joined an older run: the frozen hash's row may still be there
        const row = await readRow(deps, betId);
        if (row && row.terms_hash === (await currentHash(deps, betId))) s = toStored(row);
      }
      if (s?.decision === 'checks') deps.sam?.warm();
    } catch (e) {
      deps.log.warn('checks.frozen_failed', { bet_id: betId, err: String(e) });
    }
  };
  return track(deps, `frozen:${betId}`, run);
}

/** POST …/attempts: recording starts; warm SAM if this bet will be checked. Fire-and-forget. */
export function warmForAttempt(deps: ChecksDeps, betId: string): Promise<void> {
  if (!checksActive(deps) || cachedRulingOn(deps)) return Promise.resolve();
  const run = async () => {
    try {
      const row = await readRow(deps, betId);
      if (row?.decision === 'checks' && row.terms_hash === (await currentHash(deps, betId)))
        deps.sam?.warm();
    } catch (e) {
      deps.log.warn('checks.warm_lookup_failed', { bet_id: betId, err: String(e) });
    }
  };
  return track(deps, `warm:${betId}`, run);
}

// ---- ruling -----------------------------------------------------------------------------

export interface AttemptChecksInput {
  bet_id: string;
  attempt_no: number;
  /** bets.terms_hash (the locked terms). */
  terms_hash: string;
  /** The regular frames only (no landing crop), in send order. */
  frames: readonly { t_ms: number; bytes: Uint8Array }[];
  /** Their sha256, same order. */
  frame_hashes: readonly string[];
  /** CameraEvidence.duration_ms; undefined (an old row) = unavailable without a SAM call. */
  duration_ms: number | undefined;
}

export interface CheckRun {
  spec: CheckSpec;
  report: CheckReport;
  report_hash: string;
  /** null when no SAM call was made. */
  sam_ms: number | null;
  /** The parsed reply (boxes for checks.report); null when unavailable. */
  reply: SamSegmentReply | null;
}

/**
 * The SAM side of one attempt ruling, started next to the vision call. null = no checks for
 * this attempt (inactive, cached_ruling, no 'checks' row for the locked terms): the bottle
 * checks alone apply. Never throws; SAM failures give an 'unavailable' report (no veto).
 */
export async function runAttemptChecks(
  deps: Pick<AppDeps, 'db' | 'env' | 'log' | 'now'> & Partial<Pick<AppDeps, 'sam'>>,
  input: AttemptChecksInput,
): Promise<CheckRun | null> {
  if (!checksActive(deps) || cachedRulingOn(deps) || !deps.sam) return null;
  try {
    const row = await readRow(deps, input.bet_id);
    if (!row || row.decision !== 'checks' || row.terms_hash !== input.terms_hash) return null;
    const stored = toStored(row);
    if (!stored?.spec) {
      deps.log.error('checks.bad_spec', { bet_id: input.bet_id });
      return null;
    }
    const spec = stored.spec;
    const meta = {
      terms_hash: input.terms_hash,
      frame_hashes: [...input.frame_hashes],
      created_at: new Date(deps.now()).toISOString(),
    };
    const times = input.frames.map((f) => f.t_ms);
    let raw: unknown = null;
    let reply: SamSegmentReply | null = null;
    let samMs: number | null = null;
    if (input.duration_ms !== undefined && input.frames.length > 0) {
      const res = await deps.sam.segment(
        spec.entities.map((e) => e.prompt),
        input.frames.map((f) => f.bytes),
        { masks: true, promptFrame: 0, timeoutMs: deps.env.SAM_TIMEOUT_MS },
      );
      samMs = res.ms;
      if (res.ok) {
        const bad = replyGap(res.reply, spec, input.frames.length);
        if (bad === null) {
          raw = res.raw;
          reply = res.reply;
        } else {
          // A defective reply is SAM's fault, not the clip's: unavailable (no veto), never U1.
          deps.log.warn('checks.sam_reply_incomplete', { bet_id: input.bet_id, why: bad });
        }
      }
    }
    const report = evaluateChecks(spec, raw, times, input.duration_ms ?? 0, meta);
    if (report.status === 'unavailable') reply = null;
    deps.log.info('checks.report', {
      bet_id: input.bet_id,
      attempt_no: input.attempt_no,
      status: report.status,
      gate: report.gate,
      need: report.need,
      sam_ms: samMs,
    });
    return { spec, report, report_hash: hashJcs(report), sam_ms: samMs, reply };
  } catch (e) {
    deps.log.error('checks.run_failed', { bet_id: input.bet_id, err: String(e) });
    return null;
  }
}

/**
 * Why a parsed reply does not cover the frames sent (null when it does): every spec prompt must
 * have exactly the frame indices 0..n-1, once each.
 */
export function replyGap(reply: SamSegmentReply, spec: CheckSpec, n: number): string | null {
  for (const e of spec.entities) {
    const r = reply.results.find((x) => x.prompt === e.prompt);
    if (!r) return `no result for '${e.prompt}'`;
    const idx = new Set(r.frames.map((f) => f.index));
    if (r.frames.length !== n || idx.size !== n || r.frames.some((f) => f.index >= n))
      return `'${e.prompt}': ${r.frames.length} frames for ${n} sent`;
  }
  return null;
}

/** The camera veto replaces the bottle-check disagreement on a bet with a spec. */
export function applyCameraVeto(
  judged: Judged,
  run: CheckRun,
  yesParty: 'A' | 'B',
): { judged: Judged; veto: ChecksReportPayload['veto'] } {
  if (judged.kind !== 'verdict') return { judged, veto: null };
  const conf = Math.round(judged.verdict.confidence * 100) / 100;
  const decisive =
    toOutcome({ claim_result: judged.verdict.claim_result, confidence: conf }, yesParty) !== 'REDO';
  const found = checksVeto(judged.verdict.claim_result, run.spec, run.report);
  // Recorded (disagreement, audit, event) only when it is what makes the ruling REDO.
  const v = found && decisive ? found : null;
  const next: Judged = {
    ...judged,
    disagreement: v?.why ?? null,
    veto: v ? { kind: v.kind, why: v.why } : null,
  };
  return { judged: next, veto: v ? { kind: v.kind, why: v.why.slice(0, 280) } : null };
}

/** The checks.report payload: rows with labels, and the boxes on the frames the rows cite. */
export function reportPayload(
  attemptNo: number,
  run: CheckRun,
  veto: ChecksReportPayload['veto'],
): ChecksReportPayload {
  const { spec, report, reply } = run;
  const ent = lookupOf(spec);
  const subjects = subjectKeys(spec);
  const results = report.results.map((r, i) => {
    const a = spec.assertions[i]!;
    return {
      role: a.role,
      label: predicateClause(a.test, ent, subjects).slice(0, 160),
      value: r.value,
      why: r.why,
      frames: r.frames,
      measures: r.measures,
    };
  });
  const cited = new Set(results.flatMap((r) => r.frames));
  const boxes: Record<string, ChecksBox[]> = {};
  let frameSize: ChecksReportPayload['frame_size'] = null;
  if (reply) {
    for (const e of spec.entities) {
      const pr = reply.results.find((x) => x.prompt === e.prompt);
      for (const f of pr?.frames ?? []) {
        for (const o of f.objects)
          if (!frameSize && o.mask_rle)
            frameSize = { w: o.mask_rle.size[1], h: o.mask_rle.size[0] };
        if (!cited.has(f.index)) continue;
        const dets = f.objects
          .filter((o) => o.box_xyxy !== null && o.score >= P1.S_FLOOR)
          .sort((x, y) => y.score - x.score)
          .slice(0, e.count + 1)
          .map((o) => ({
            key: e.key,
            prompt: e.prompt,
            box_xyxy: o.box_xyxy!,
            score: Math.round(o.score * 1000) / 1000,
          }));
        if (dets.length) (boxes[String(f.index)] ??= []).push(...dets);
      }
    }
  }
  return {
    attempt_no: attemptNo,
    status: report.status,
    gate: report.gate,
    need: report.need,
    veto,
    results,
    boxes,
    frame_size: frameSize,
    report_hash: run.report_hash,
  };
}

/**
 * Inside the ruling's commit: attempt_checks row + checks.report (before ruling.issued). Returns
 * the event, or none when the row already exists (a replayed job).
 */
export async function storeAttemptChecks(
  tx: Tx,
  o: {
    bet_id: string;
    attempt_no: number;
    run: CheckRun;
    veto: ChecksReportPayload['veto'];
    now: number;
  },
): Promise<BetEventEnvelope[]> {
  const inserted = await tx
    .insert(attemptChecks)
    .values({
      bet_id: o.bet_id,
      attempt_no: o.attempt_no,
      status: o.run.report.status,
      report: o.run.report as unknown as Record<string, unknown>,
      report_hash: o.run.report_hash,
      sam_ms: o.run.sam_ms,
      created_at: new Date(o.now),
    })
    .onConflictDoNothing()
    .returning({ bet_id: attemptChecks.bet_id });
  if (!inserted.length) return [];
  return [
    await appendBetEvent(tx, {
      bet_id: o.bet_id,
      type: 'checks.report',
      payload: reportPayload(o.attempt_no, o.run, o.veto),
      now: o.now,
    }),
  ];
}

// ---- health -----------------------------------------------------------------------------

export interface ChecksHealth extends Partial<SamStatsSnapshot> {
  /** env CHECKS_ENABLED (the kill switch). */
  enabled: boolean;
  /** SAM3_URL + SAM3_API_TOKEN set (deps.sam built). */
  sam_configured: boolean;
  /** The runtime toggle 'checks'. */
  toggle: boolean;
  /** All three: rulings run SAM now (cached_ruling still skips them). */
  active: boolean;
  /** env SAM_TIMEOUT_MS. */
  timeout_ms: number;
}

/** The `checks` block of GET /v1/demo/health. */
export function checksHealth(
  deps: Pick<AppDeps, 'env'> & Partial<Pick<AppDeps, 'sam'>>,
): ChecksHealth {
  return {
    enabled: deps.env.CHECKS_ENABLED,
    sam_configured: deps.sam !== undefined,
    toggle: togglesOf(deps).checksOn(),
    active: checksActive(deps),
    timeout_ms: deps.env.SAM_TIMEOUT_MS,
    ...(deps.sam?.stats() ?? {}),
  };
}
