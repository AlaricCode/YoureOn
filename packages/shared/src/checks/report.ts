// The camera checks' record and how it combines with Claude's verdict (design final.md §7-§8).
// CheckReport is strict and hashed (RulingV2.check_report_hash); checksVeto is the only place a
// report touches a ruling, and it can only refuse a verdict, never pick or flip a winner.
import { z } from 'zod/v4';
import { MAX_JUDGE_FRAMES } from '../judge/frames';
import { Hex32, IsoUtc } from '../primitives';
import type { ClaimResult } from '../ruling';
import {
  type CheckSpec,
  filmingHint,
  lookupOf,
  MAX_ASSERTIONS,
  PREDICATE_SET,
  predicateClause,
  predicateFailure,
  subjectKeys,
  windowPhrase,
} from './spec';

export const Tri = z.enum(['true', 'false', 'unknown']);
export type Tri = z.infer<typeof Tri>;
/** §7: abstain is only ever never_seen, computed by the evaluator. */
export const CheckValue = z.enum(['true', 'false', 'unknown', 'abstain']);
export type CheckValue = z.infer<typeof CheckValue>;

/** Why a row has its value (the first reason that decided it). */
export const CheckWhy = z.enum([
  'ok', // decided on geometry
  'absent', // no candidate >= S_FLOOR where one was needed
  'weak', // only candidates in [S_FLOOR, S_SEEN)
  'ambiguous', // a rival within MARGIN, or more strong instances than count
  'count_mismatch', // fewer instances than count (or than count candidates)
  'clipped', // a subject's main box within EDGE of the frame border
  'fragmented', // main blob < 70% of the mask (occluded / split): upright
  'between_bands', // the measurement fell between the true and the false band
  'single_frame', // a false condition held on one frame only (two-frame rule)
  'start_unstable', // moved_from_start: frames 0-1 disagree (IoU < 0.8)
  'not_together', // switched_sides: never both seen in a lead-in frame
  'unmatched', // multi-instance cross-frame matching not unambiguous
  'ref_missing', // b / ref not seen where needed
  'clip_too_short', // touching last_Ns on a clip shorter than N s (a FALSE reason)
  'never_seen', // abstain: ungated subject never detected in any frame
  'too_few_frames', // U1, or fewer than 3 frames in last_Ns
]);
export type CheckWhy = z.infer<typeof CheckWhy>;

export const MeasureKey = z.enum([
  'score',
  'shift_rel',
  'size_chg',
  'tilt_deg',
  'elong',
  'gap_rel',
  'iou',
  'frames',
]);
export const Measure = z.strictObject({ k: MeasureKey, v: z.number() });
export type Measure = z.infer<typeof Measure>;

export const CheckRow = z.strictObject({
  value: CheckValue,
  why: CheckWhy,
  /** Indices into the regular frames that decided it. */
  frames: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_JUDGE_FRAMES - 1),
    )
    .max(MAX_JUDGE_FRAMES),
  measures: z.array(Measure).max(4),
});
export type CheckRow = z.infer<typeof CheckRow>;

/** §8. terms_hash, frame_hashes and created_at come from the caller (ReportMeta). */
export const CheckReport = z
  .strictObject({
    schema_version: z.literal(1),
    predicates: z.literal(PREDICATE_SET),
    status: z.enum(['ok', 'unavailable']),
    /** The service's rev; "" only when unavailable before a readable reply. */
    sam_rev: z.string().max(80),
    /** sha256(JCS(raw /segment reply)); null iff unavailable. */
    sam_reply_hash: Hex32.nullable(),
    terms_hash: Hex32,
    /** The regular frames sent to SAM, in order. */
    frame_hashes: z.array(Hex32).min(1).max(MAX_JUDGE_FRAMES),
    /** One row per assertion, in spec order; [] iff unavailable. */
    results: z.array(CheckRow).max(MAX_ASSERTIONS),
    gate: Tri,
    need: Tri,
    created_at: IsoUtc,
  })
  .superRefine((r, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const off = r.status === 'unavailable';
    if (off !== (r.sam_reply_hash === null)) bad('sam_reply_hash', 'null iff unavailable');
    if (off !== (r.results.length === 0)) bad('results', '[] iff unavailable');
    if (off && (r.gate !== 'unknown' || r.need !== 'unknown'))
      bad('gate', 'unknown when unavailable');
  });
export type CheckReport = z.infer<typeof CheckReport>;

/** §7 Kleene AND; abstain rows are left out; an empty AND is true. */
export function kleeneAnd(xs: readonly CheckValue[]): Tri {
  const v = xs.filter((x): x is Tri => x !== 'abstain');
  return v.includes('false') ? 'false' : v.includes('unknown') ? 'unknown' : 'true';
}
/** Kleene OR (moved_from_start of: 'any'). */
export function kleeneOr(xs: readonly Tri[]): Tri {
  return xs.includes('true') ? 'true' : xs.includes('unknown') ? 'unknown' : 'false';
}

export type VetoKind = 'not_on_camera' | 'contradicts' | 'unconfirmed';
/** A refusal: the verdict becomes REDO 'unclear' with `why` as the spoken reason. */
export interface Veto {
  kind: VetoKind;
  /** The assertion (spec order) the reason is about. */
  index: number;
  why: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * §7. null: Claude's outcome stands. Otherwise REDO 'unclear' (which counts toward MAX_REDOS).
 * - no spec, no report, SAM unavailable, or UNCLEAR: null (UNCLEAR is already REDO).
 * - NOT_MET stands: needs are necessary, never sufficient, so cannot contradict a miss; and a
 *   subject out of shot is no ground to overturn one either (a bottle flung out of frame is a miss,
 *   and a gate veto on NOT_MET would let a failing performer duck out of shot into REDO, then VOID
 *   max_redos). The checks only ever refuse a MET.
 * - MET with any gate not true: not_on_camera.
 * - MET with a false need: contradicts; else with an unknown need: unconfirmed (first in spec order).
 */
export function checksVeto(
  claim: ClaimResult,
  spec: CheckSpec | null,
  r: CheckReport | null,
): Veto | null {
  if (spec === null || r === null || r.status === 'unavailable' || claim !== 'MET') return null;
  const ent = lookupOf(spec);
  const row = (i: number) => r.results[i]?.value ?? 'unknown';
  const gi = spec.assertions.findIndex((a, i) => a.role === 'gate' && row(i) !== 'true');
  const g = spec.assertions[gi]?.test;
  if (g !== undefined) {
    // CheckSpec only lets `visible` gate; the fallback text covers an unparsed spec.
    const what =
      g.p === 'visible' ? `the ${ent(g.e)?.prompt ?? g.e} ${windowPhrase(g.window)}` : 'it';
    return {
      kind: 'not_on_camera',
      index: gi,
      why: `Couldn't see ${what}. Keep it in frame and run it back.`,
    };
  }
  const fi = spec.assertions.findIndex((a, i) => a.role === 'need' && row(i) === 'false');
  const f = spec.assertions[fi]?.test;
  if (f !== undefined)
    return {
      kind: 'contradicts',
      index: fi,
      why: `Checks disagree: ${predicateFailure(f, ent, r.results[fi]?.why === 'clip_too_short')}.`,
    };
  const ui = spec.assertions.findIndex((a, i) => a.role === 'need' && row(i) === 'unknown');
  const u = spec.assertions[ui]?.test;
  if (u !== undefined) {
    const hint = filmingHint(u, ent);
    return {
      kind: 'unconfirmed',
      index: ui,
      why: `Couldn't confirm ${predicateClause(u, ent, subjectKeys(spec))}. ${hint === null ? 'Keep it in frame and run it back' : cap(hint)}.`,
    };
  }
  return null;
}
