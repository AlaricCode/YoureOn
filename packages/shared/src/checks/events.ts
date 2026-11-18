// The camera checks' realtime events (API-CONTRACT §3.4 checks.compiled / checks.report). Additive:
// older phones and stages drop unknown types (parseRealtimeEvent). Non-binding: the CheckSpec is
// compiled server-side beside the bet, never in the hashed Terms.
//
//   checks.compiled  the server compiled the bet's current terms into a CheckSpec (or judge_only).
//                    Sent each time a terms version is compiled; a newer terms_hash supersedes it.
//   checks.report    one attempt's CheckReport, in the same commit as its ruling.issued (sent just
//                    before it). Small: per-row values, the veto that applied (if any) and the main
//                    boxes on the frames the rows cite. No masks.
import { z } from 'zod/v4';
import { MAX_JUDGE_FRAMES } from '../judge/frames';
import { Hex32 } from '../primitives';
import { CheckValue, CheckWhy, Measure, Tri } from './report';
import {
  EntityKey,
  MAX_ASSERTIONS,
  MAX_ENTITIES,
  MAX_ENTITY_COUNT,
  READBACK_MAX_CHARS,
  Role,
} from './spec';

export const ChecksDecision = z.enum(['checks', 'judge_only']);
export type ChecksDecision = z.infer<typeof ChecksDecision>;

/** checks.compiled */
export const ChecksCompiledPayload = z.object({
  /** The terms version it was compiled from (= bets.terms_hash while current). */
  terms_hash: Hex32,
  decision: ChecksDecision,
  /** describeChecks(spec): "Ref cam: …", or the judge-only line. */
  readback: z.string().max(READBACK_MAX_CHARS),
});
export type ChecksCompiledPayload = z.infer<typeof ChecksCompiledPayload>;

const FrameIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_JUDGE_FRAMES - 1);
const Px = z.number().int().min(0);

/** One row of the report, in spec order (CheckRow + its role and a readable label). */
export const ChecksReportRow = z.object({
  role: Role,
  /** The predicate's template clause, e.g. "the bottle stands upright". */
  label: z.string().max(160),
  value: CheckValue,
  why: CheckWhy,
  frames: z.array(FrameIndex).max(MAX_JUDGE_FRAMES),
  measures: z.array(Measure).max(4),
});
export type ChecksReportRow = z.infer<typeof ChecksReportRow>;

/** One SAM detection drawn on a frame: the main blob's box (xyxy px, x1/y1 exclusive). */
export const ChecksBox = z.object({
  key: EntityKey,
  prompt: z.string().max(40),
  box_xyxy: z.tuple([Px, Px, Px, Px]),
  score: z.number(),
});
export type ChecksBox = z.infer<typeof ChecksBox>;

/** Boxes per regular frame index (as a string key), only for frames the rows cite. */
export const MAX_BOXES_PER_FRAME = MAX_ENTITIES * (MAX_ENTITY_COUNT + 1);

export const ChecksVetoKind = z.enum(['not_on_camera', 'contradicts', 'unconfirmed']);
export type ChecksVetoKind = z.infer<typeof ChecksVetoKind>;

/** checks.report */
export const ChecksReportPayload = z.object({
  attempt_no: z.number().int().min(1),
  /** 'unavailable': SAM errored, timed out or replied unreadably (no veto; rows empty). */
  status: z.enum(['ok', 'unavailable']),
  gate: Tri,
  need: Tri,
  /**
   * The veto that turned this attempt's decisive verdict into REDO ('why' is the ruling's
   * reason), or null when the checks changed nothing (passed, unavailable, or the verdict was
   * already REDO / NOT_MET-with-gates-true).
   */
  veto: z.object({ kind: ChecksVetoKind, why: z.string().max(280) }).nullable(),
  results: z.array(ChecksReportRow).max(MAX_ASSERTIONS),
  boxes: z.record(
    z.string().regex(/^(?:[0-9]|1[01])$/),
    z.array(ChecksBox).max(MAX_BOXES_PER_FRAME),
  ),
  /** The regular frames' pixel size (from the masks); null when unavailable. */
  frame_size: z.object({ w: Px, h: Px }).nullable(),
  /** hashJcs(CheckReport), as stored in attempt_checks. */
  report_hash: Hex32,
});
export type ChecksReportPayload = z.infer<typeof ChecksReportPayload>;
