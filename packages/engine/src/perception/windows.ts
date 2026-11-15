/**
 * §6.5 decisive-window extraction: not consensus, but the produced buffer MUST
 * satisfy the post-condition (same `leg_results`, `winner_mask`, `checkpoints`
 * as the full-session evaluation, within every on-chain cap).
 *
 * Window conventions (see docs/CONTRACTS-ERRATA.md, [perception]):
 * - `[a, b]` in the §6.5 table is inclusive; `[0, D)` is half-open; the
 *   `holds(D)` row `[0, D+5]` is taken as `[0, D+5)` so that §15.2's window is
 *   exactly frames `[0, 105)`.
 * - "full coverage" = `[0, min(n_frames, LIMIT + TAIL_FRAMES))`.
 * - `rep_count` adds `[0, k]` for every key frame `k` of a leg that uses it.
 */
import {
  ATTEMPT_WINDOW_TAIL_PAD,
  HOLDS_WINDOW_TAIL_PAD,
  MAX_BUFFER_PAYLOAD,
  MAX_EVAL_COST,
  MAX_EVAL_FRAMES,
  MAX_SEGMENTS,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
  WINDOW_MERGE_GAP,
  WINDOW_PAD_FRAMES,
  WINDOW_WIDEN_FRAMES,
  WINDOW_WIDEN_RETRIES,
  AI_JUDGED_TRACK_FLAGS,
} from '../constants.js';
import { buildPayload, encodeCalibration, encodeProgram, encodeTrackBin } from '../encode/index.js';
import { evaluate, evaluateSession } from '../eval/index.js';
import type {
  Calibration,
  Checkpoint,
  Cmp,
  EvalResult,
  Expr,
  Leg,
  Program,
  QFrame,
  SessionTracks,
  TrackBufferData,
  TrackTableEntry,
  VerifiedCheckpoint,
} from '../types.js';
import { exprHasOp, exprIsActorBound, maxBufferFrame, trackedEntityIndices } from './program-info.js';

/** Inclusive frame interval. */
export interface FrameWindow {
  lo: number;
  hi: number;
}

function cmpHolds(c: Cmp, a: number, b: number): boolean {
  switch (c) {
    case '>=':
      return a >= b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '<':
      return a < b;
    case '==':
      return a === b;
    case '!=':
      return a !== b;
  }
}

/**
 * Frames of `rising(X)` in F_R over the full session, obtained through the
 * public evaluator: a one-leg program `count(X) >= 1` (no attempts) has
 * decisive frames = all frames of `rising(X)` (§3.7).
 */
export function risingFrames(p: Program, c: Calibration | null, session: SessionTracks, x: Expr): number[] {
  const leg: Leg = {
    id: 1,
    actor_bound: exprIsActorBound(p, x),
    attempt_window_frames: 50,
    success: x,
    rule: { kind: 'count', cmp: '>=', k: 1, attempts: 0 },
  };
  const probe: Program = {
    ...p,
    kind: 'rules',
    legs: [leg],
    outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
  };
  const flags = (session.flags | TRACK_FLAG_CROSS_CHECK_OK) & ~TRACK_FLAG_WINDOW_UNAVAILABLE;
  const r = evaluateSession(probe, c, { ...session, flags }, []);
  return r.decisive_frames[0] ?? [];
}

/** Merge sorted-by-`lo` windows whose gap (`next.lo - prev.hi - 1`) is < WINDOW_MERGE_GAP. */
export function clampAndMerge(ws: readonly FrameWindow[], end: number, mergeGap: number = WINDOW_MERGE_GAP): FrameWindow[] {
  const clamped = ws
    .map((w) => ({ lo: Math.max(0, w.lo), hi: Math.min(end - 1, w.hi) }))
    .filter((w) => w.lo <= w.hi)
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: FrameWindow[] = [];
  for (const w of clamped) {
    const last = out[out.length - 1];
    if (last && w.lo - last.hi - 1 < mergeGap) last.hi = Math.max(last.hi, w.hi);
    else out.push({ ...w });
  }
  return out;
}

export interface WindowPlan {
  /** raw (unclamped, unmerged) windows */
  windows: FrameWindow[];
  /** whether some rule demands full coverage */
  full: boolean;
}

/** §6.5 steps 1–2: key frames and coverage windows from the full-session result. */
export function planWindows(p: Program, c: Calibration | null, session: SessionTracks, full: EvalResult): WindowPlan {
  const W = WINDOW_PAD_FRAMES;
  const windows: FrameWindow[] = [];
  let needFull = false;
  const around = (k: number): void => {
    windows.push({ lo: k - W, hi: k + W });
  };
  for (const cp of full.checkpoints) around(cp.frame);

  p.legs.forEach((leg, i) => {
    if (!leg.success || !leg.rule) return;
    const keys: number[] = [];
    const DF = full.decisive_frames[i] ?? [];
    keys.push(...DF);
    const RV = leg.valid_attempt ? risingFrames(p, c, session, leg.valid_attempt) : [];
    const RS = leg.rule.kind === 'count' && leg.rule.attempts === 0 ? DF : risingFrames(p, c, session, leg.success);
    keys.push(...RV, ...RS);
    const attempts = full.attempts.filter((a) => a.leg === i);
    for (const a of attempts) {
      keys.push(a.frame);
      if (a.success_frame !== null) keys.push(a.success_frame);
      const next = RV.find((r) => r > a.frame);
      const end = Math.min(a.frame + leg.attempt_window_frames, next ?? Number.POSITIVE_INFINITY);
      windows.push({ lo: a.frame - W, hi: end + ATTEMPT_WINDOW_TAIL_PAD });
    }
    for (const cp of full.checkpoints) keys.push(cp.frame);
    for (const k of keys) around(k);

    const rule = leg.rule;
    switch (rule.kind) {
      case 'holds':
        windows.push({ lo: 0, hi: rule.frames + HOLDS_WINDOW_TAIL_PAD - 1 });
        break;
      case 'before':
        if (DF.length === 0) windows.push({ lo: 0, hi: rule.frames - 1 });
        break;
      case 'exists':
        if (DF.length === 0) needFull = true;
        break;
      case 'never':
        // "nothing happened" claims need full coverage (raw True ⇔ no decisive frame).
        if (DF.length === 0) needFull = true;
        break;
      case 'count':
        if (rule.attempts === 0 && !cmpHolds(rule.cmp, DF.length, rule.k)) needFull = true;
        if (rule.attempts > 0 && RV.length === 0) needFull = true;
        break;
    }
    if (exprHasOp(leg.success, 'rep_count') || exprHasOp(leg.valid_attempt, 'rep_count')) {
      const maxKey = keys.length > 0 ? Math.max(...keys) : -1;
      if (maxKey >= 0) windows.push({ lo: 0, hi: maxKey });
    }
  });
  return { windows, full: needFull };
}

function sameCheckpoints(a: readonly Checkpoint[], b: readonly Checkpoint[]): boolean {
  return a.length === b.length && a.every((x, i) => x.participant === b[i]!.participant && x.frame === b[i]!.frame);
}

/** Build the TrackBufferData for the given merged windows. */
export function bufferForWindows(p: Program, session: SessionTracks, ws: readonly FrameWindow[], flags: number): TrackBufferData {
  const tracked = trackedEntityIndices(p);
  const tracks: TrackTableEntry[] = [];
  const cols: (readonly (QFrame | null)[])[] = [];
  for (const ei of tracked) {
    const st = session.tracks.find((t) => t.entity_idx === ei);
    tracks.push({ entity_idx: ei, participant_idx: st?.participant_idx ?? null, ref_h: st?.ref_h ?? 0 });
    cols.push(st?.frames ?? []);
  }
  return {
    flags,
    model_hash: session.model_hash,
    tracks,
    segments: ws.map((w) => {
      const frames: (QFrame | null)[][] = [];
      for (let f = w.lo; f <= w.hi; f++) frames.push(cols.map((col) => col[f] ?? null));
      return { frame_start: w.lo, frames };
    }),
  };
}

export interface ExtractAttempt {
  windows: FrameWindow[];
  ok: boolean;
  reason?: string;
}

/**
 * `extractDecisiveWindows(p, c, session, verified)` (§6.5). Returns the
 * TrackBufferData to encode, or `null` when no window set reproduces the
 * full-session result within the caps (the backend then uses SP1 or posts
 * flags bit3). A session that already carries flags bit3 (perception declared
 * windows unavailable) yields `null` directly.
 *
 * ai_judged programs get the minimal track_bin (`T = 0, S = 0, flags = 0b10`, §5.6);
 * market programs have no track_bin (they use market_bin) and yield `null`.
 */
export function extractDecisiveWindows(
  p: Program,
  c: Calibration | null,
  session: SessionTracks,
  verified: readonly VerifiedCheckpoint[],
  trace?: ExtractAttempt[],
): TrackBufferData | null {
  if (p.kind === 'ai_judged') return { flags: AI_JUDGED_TRACK_FLAGS, model_hash: session.model_hash, tracks: [], segments: [] };
  if (p.kind !== 'rules') return null;
  if ((session.flags & TRACK_FLAG_WINDOW_UNAVAILABLE) !== 0) return null;

  const flags = session.flags & ~TRACK_FLAG_WINDOW_UNAVAILABLE;
  const sess: SessionTracks = { ...session, flags };
  const end = Math.min(session.n_frames, maxBufferFrame(p));
  if (end <= 0) return null;
  const full = evaluateSession(p, c, sess, verified);
  // Plan from the legs' semantics even when the session has not (yet) passed
  // the cross-check: the post-condition still compares against `full`.
  const planSess: SessionTracks = { ...sess, flags: flags | TRACK_FLAG_CROSS_CHECK_OK };
  const planFull = planSess.flags === flags ? full : evaluateSession(p, c, planSess, verified);
  const plan = planWindows(p, c, planSess, planFull);

  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(c, p);

  const attempt = (ws: FrameWindow[]): TrackBufferData | null => {
    const fail = (reason: string): null => {
      trace?.push({ windows: ws.map((w) => ({ ...w })), ok: false, reason });
      return null;
    };
    if (ws.length === 0) return fail('no windows');
    if (ws.length > MAX_SEGMENTS) return fail(`segments ${ws.length} > ${MAX_SEGMENTS}`);
    const nFrames = ws.reduce((s, w) => s + (w.hi - w.lo + 1), 0);
    if (nFrames > MAX_EVAL_FRAMES) return fail(`frames ${nFrames} > ${MAX_EVAL_FRAMES}`);
    const buffer = bufferForWindows(p, sess, ws, flags);
    const trackBin = encodeTrackBin(buffer);
    const payloadLen = programBin.length + calibrationBin.length + trackBin.length;
    if (payloadLen > MAX_BUFFER_PAYLOAD) return fail(`payload ${payloadLen} > ${MAX_BUFFER_PAYLOAD}`);
    buildPayload(programBin, calibrationBin, trackBin);
    const r = evaluate(programBin, calibrationBin, trackBin, verified);
    if (r.cost > MAX_EVAL_COST) return fail(`cost ${r.cost} > ${MAX_EVAL_COST}`);
    const same =
      r.winner_mask === full.winner_mask &&
      r.leg_results.length === full.leg_results.length &&
      r.leg_results.every((v, i) => v === full.leg_results[i]) &&
      sameCheckpoints(r.checkpoints, full.checkpoints);
    if (!same) return fail('result differs from full session');
    trace?.push({ windows: ws.map((w) => ({ ...w })), ok: true });
    return buffer;
  };

  const fullWindow: FrameWindow[] = [{ lo: 0, hi: end - 1 }];
  if (!plan.full) {
    for (let widen = 0; widen <= WINDOW_WIDEN_RETRIES; widen++) {
      const d = widen * WINDOW_WIDEN_FRAMES;
      const ws = clampAndMerge(
        plan.windows.map((w) => ({ lo: w.lo - d, hi: w.hi + d })),
        end,
      );
      const r = attempt(ws.length > 0 ? ws : fullWindow);
      if (r) return r;
    }
  }
  return attempt(fullWindow);
}

