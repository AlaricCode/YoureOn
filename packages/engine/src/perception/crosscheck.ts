/**
 * §6.3 cross-check of two perception hosts.
 *
 * 1. Per referenced entity (track_bin tracks, [D-43]) and per frame where either
 *    side is present: agree iff both present with IoU_bps ≥ IOU_AGREE_BPS
 *    (union 0 ⇒ agree), or only one side present with conf < DECISIVE_CONF_MIN.
 *    Pass iff `agree*10000/considered ≥ TRACK_AGREE_BPS` (no frames ⇒ pass).
 * 2. Evaluate each full session (one segment, verified = all checkpoints,
 *    maxCost = ∞): equal leg values and attempt counts; attempt, success and
 *    decisive frames pairwise within ±EVENT_TOL_FRAMES.
 * 3. The caller seals host A's tracks with flags bit1 = ok (`sealSession`).
 * 4. Advisory: per-entity agreement of phone `detections` witnesses (bit4).
 */
import {
  BPS_DENOM,
  DECISIVE_CONF_MIN,
  EVENT_TOL_FRAMES,
  FRAME_MS,
  IOU_AGREE_BPS,
  TRACK_AGREE_BPS,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_PHONE_DISAGREE,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
} from '../constants.js';
import { evaluateSession } from '../eval/index.js';
import type { Calibration, CrossCheckResult, EvalResult, Program, QFrame, SessionTracks } from '../types.js';
import { iouBps, isPresent } from './geometry.js';
import { trackedEntityIndices } from './program-info.js';

/** Agreement of one frame pair (§6.3 step 1); `null` when neither side is present (not considered). */
export function frameAgreement(a: QFrame | null | undefined, b: QFrame | null | undefined): boolean | null {
  const pa = isPresent(a);
  const pb = isPresent(b);
  if (!pa && !pb) return null;
  if (pa && pb) {
    const iou = iouBps(a, b);
    return iou === null || iou >= IOU_AGREE_BPS;
  }
  const only = (pa ? a : b)!;
  return only.conf < DECISIVE_CONF_MIN;
}

/** Per-entity agreement in bps over two frame sequences (no considered frames ⇒ 10000). */
export function trackAgreementBps(
  a: readonly (QFrame | null)[],
  b: readonly (QFrame | null)[],
  onlyFrames?: ReadonlySet<number>,
): number {
  const n = Math.max(a.length, b.length);
  let considered = 0;
  let agree = 0;
  for (let f = 0; f < n; f++) {
    if (onlyFrames && !onlyFrames.has(f)) continue;
    const r = frameAgreement(a[f] ?? null, b[f] ?? null);
    if (r === null) continue;
    considered++;
    if (r) agree++;
  }
  return considered === 0 ? BPS_DENOM : Math.floor((agree * BPS_DENOM) / considered);
}

/** Full-session evaluation as the cross-check runs it: cross-check flag assumed, verified = all checkpoints. */
export function crossCheckEval(p: Program, c: Calibration | null, s: SessionTracks): EvalResult {
  const flags = (s.flags | TRACK_FLAG_CROSS_CHECK_OK) & ~TRACK_FLAG_WINDOW_UNAVAILABLE;
  const sess = { ...s, flags };
  const first = evaluateSession(p, c, sess, []);
  if (first.checkpoints.length === 0) return first;
  return evaluateSession(p, c, sess, first.checkpoints);
}

const near = (x: number, y: number): boolean => Math.abs(x - y) <= EVENT_TOL_FRAMES;

/** Compare two evaluations (§6.3 step 2); returns human-readable mismatches. */
export function compareEvaluations(p: Program, ra: EvalResult, rb: EvalResult): string[] {
  const out: string[] = [];
  p.legs.forEach((leg, i) => {
    const tag = `leg ${leg.id}`;
    const va = ra.leg_results[i];
    const vb = rb.leg_results[i];
    if (va !== vb) out.push(`${tag}: value ${String(va)} vs ${String(vb)}`);
    const aa = ra.attempts.filter((x) => x.leg === i);
    const ab = rb.attempts.filter((x) => x.leg === i);
    if (aa.length !== ab.length) {
      out.push(`${tag}: attempts ${aa.length} vs ${ab.length}`);
    } else {
      aa.forEach((x, j) => {
        const y = ab[j]!;
        if (!near(x.frame, y.frame)) out.push(`${tag} attempt ${j + 1}: frame ${x.frame} vs ${y.frame}`);
        const sx = x.success_frame;
        const sy = y.success_frame;
        if ((sx === null) !== (sy === null) || (sx !== null && sy !== null && !near(sx, sy))) {
          out.push(`${tag} attempt ${j + 1}: success ${String(sx)} vs ${String(sy)}`);
        }
      });
    }
    const da = ra.decisive_frames[i] ?? [];
    const db = rb.decisive_frames[i] ?? [];
    if (da.length !== db.length || da.some((f, j) => !near(f, db[j]!))) {
      out.push(`${tag}: decisive frames [${da.join(',')}] vs [${db.join(',')}]`);
    }
  });
  return out;
}

/** A phone `detections` witness body (§7.1), parsed. Boxes: `[label, x0, y0, x1, y1, conf%]`. */
export interface PhoneDetections {
  frames: { t_ms: number; boxes: [string, number, number, number, number, number][] }[];
}

function labelMatcher(p: Program, c: Calibration | null): (entity: string, label: string) => boolean {
  const refLabel = new Map<string, string>();
  for (const r of c?.scene.entity_refs ?? []) refLabel.set(r.entity, r.label.toLowerCase());
  const phrase = new Map<string, string>();
  for (const e of p.entities) if (e.kind === 'object') phrase.set(e.name, e.phrase);
  return (entity, label) => {
    const l = label.toLowerCase();
    return l === entity || l === refLabel.get(entity) || l === phrase.get(entity);
  };
}

/** Per-entity agreement of one phone witness against the sealed tracks (§6.3 step 4, advisory). */
export function phoneAgreementBps(
  sealed: SessionTracks,
  phone: PhoneDetections,
  p: Program,
  c: Calibration | null,
): Record<string, number> {
  const matches = labelMatcher(p, c);
  const out: Record<string, number> = {};
  for (const ei of trackedEntityIndices(p)) {
    const st = sealed.tracks.find((t) => t.entity_idx === ei);
    if (!st) continue;
    const phoneFrames: (QFrame | null)[] = new Array(sealed.n_frames).fill(null);
    const reported = new Set<number>();
    for (const fr of phone.frames) {
      if (!(fr.t_ms >= 0)) continue;
      const f = Math.floor(fr.t_ms / FRAME_MS);
      if (f >= sealed.n_frames) continue;
      reported.add(f);
      for (const [label, x0, y0, x1, y1, conf] of fr.boxes) {
        if (!matches(st.entity, label)) continue;
        const cur = phoneFrames[f];
        if (!cur || conf > cur.conf) phoneFrames[f] = { x0, y0, x1, y1, conf, fill: 0, id_conf: 0, pose: 0 };
      }
    }
    // Only frames the phone actually reported are compared (phones sample sparsely).
    out[st.entity] = trackAgreementBps(st.frames, phoneFrames, reported);
  }
  return out;
}

/**
 * `crossCheck(a, b, p, c)` (§6.3). `phones` (optional) adds the advisory
 * `phone_agreement_bps` (computed against host A, the sealed tracks); it never
 * changes `ok`.
 */
export function crossCheck(
  a: SessionTracks,
  b: SessionTracks,
  p: Program,
  c: Calibration | null,
  phones?: readonly PhoneDetections[],
): CrossCheckResult {
  const entity_agreement_bps: Record<string, number> = {};
  let ok = true;
  for (const ei of trackedEntityIndices(p)) {
    const ta = a.tracks.find((t) => t.entity_idx === ei);
    const tb = b.tracks.find((t) => t.entity_idx === ei);
    const name = ta?.entity ?? tb?.entity ?? p.entities[ei]!.name;
    const bps = trackAgreementBps(ta?.frames ?? [], tb?.frames ?? []);
    entity_agreement_bps[name] = bps;
    if (bps < TRACK_AGREE_BPS) ok = false;
  }

  let event_mismatches: string[] = [];
  if (p.kind === 'rules') {
    event_mismatches = compareEvaluations(p, crossCheckEval(p, c, a), crossCheckEval(p, c, b));
    if (event_mismatches.length > 0) ok = false;
  }

  const result: CrossCheckResult = { ok, entity_agreement_bps, event_mismatches };
  if (phones && phones.length > 0) {
    const agg: Record<string, number> = {};
    for (const ph of phones) {
      for (const [k, v] of Object.entries(phoneAgreementBps(a, ph, p, c))) agg[k] = Math.min(agg[k] ?? BPS_DENOM, v);
    }
    result.phone_agreement_bps = agg;
  }
  return result;
}

/**
 * Host A's tracks as sealed after the cross-check (§6.3 step 3): flags bit1 =
 * `ok`; bit4 (`phone_disagree`) when any phone agreement is below TRACK_AGREE_BPS.
 */
export function sealSession(a: SessionTracks, result: CrossCheckResult): SessionTracks {
  let flags = result.ok ? a.flags | TRACK_FLAG_CROSS_CHECK_OK : a.flags & ~TRACK_FLAG_CROSS_CHECK_OK;
  const phone = result.phone_agreement_bps;
  if (phone && Object.values(phone).some((v) => v < TRACK_AGREE_BPS)) flags |= TRACK_FLAG_PHONE_DISAGREE;
  return { ...a, flags };
}
