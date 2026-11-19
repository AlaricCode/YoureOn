// DANCE-OFF §5: the server's DanceEvidence builder and the ruling fields it implies. Pure, so the
// server route, its tests and any reviewer rebuild the identical record from the same upload.
import { DanceEvidence, type EvidenceFrame } from '../evidence';
import type { ClaimResult } from '../ruling';
import { poseSha256, type PoseSeries } from './pose';
import { routineRef, type RoutineData } from './routine';
import { keyMoveBreakdown, scoreRound, type DanceRoundResult } from './score';
import { seriesChecks } from './track';

export interface BuildDanceEvidenceInput {
  bet_id: string;
  attempt_no: number;
  terms_hash: string;
  routine: RoutineData;
  /** Already parsed with PoseSeries. */
  series: PoseSeries;
  /** The uploaded key frames (index 0..n−1, sha256 of each JPEG). */
  frames: EvidenceFrame[];
  clip_sha256: string | null;
}

/**
 * Re-scores the series with the shared scorer and returns the strict record plus the full result
 * (for the validation prompt and the announcer). Throws if the record does not parse.
 */
export function buildDanceEvidence(i: BuildDanceEvidenceInput): {
  evidence: DanceEvidence;
  result: DanceRoundResult;
} {
  const result = scoreRound(i.routine, i.series);
  const checks = seriesChecks(i.series);
  const evidence = DanceEvidence.parse({
    schema_version: 1,
    kind: 'dance',
    bet_id: i.bet_id,
    attempt_no: i.attempt_no,
    terms_hash: i.terms_hash,
    routine: routineRef(i.routine),
    scorer_version: result.scorer_version,
    pose_sha256: poseSha256(i.series),
    pose_frames: i.series.frames.length,
    sync_offset_ms: i.series.sync_offset_ms,
    scores: { a: result.a.score_x10, b: result.b.score_x10 },
    winner: result.winner,
    too_close: result.too_close,
    failed: result.failed,
    key_moves: keyMoveBreakdown(result),
    checks: {
      coverage_a_pct: result.a.coverage_pct,
      coverage_b_pct: result.b.coverage_pct,
      max_people: checks.max_people,
      side_swaps: checks.side_swaps,
    },
    frames: i.frames,
    clip_sha256: i.clip_sha256,
  });
  return { evidence, result };
}

/**
 * The outcome of a dance-off ruling (DANCE-OFF §5): a winner on a valid round is decisive
 * (claim_result MET ⇔ A wins, since yes_party = 'A'); too close, failed, or an invalid round is
 * VOID 'undecidable' (both refunded). confidence is always 1.
 */
export function danceRulingOutcome(
  e: Pick<DanceEvidence, 'winner' | 'too_close' | 'failed'>,
  valid: boolean,
):
  | { outcome: 'A_WINS'; claim_result: Extract<ClaimResult, 'MET'>; void_reason: null }
  | { outcome: 'B_WINS'; claim_result: Extract<ClaimResult, 'NOT_MET'>; void_reason: null }
  | { outcome: 'VOID'; claim_result: Extract<ClaimResult, 'UNCLEAR'>; void_reason: 'undecidable' } {
  if (!valid || e.too_close || e.failed !== null || e.winner === null)
    return { outcome: 'VOID', claim_result: 'UNCLEAR', void_reason: 'undecidable' };
  return e.winner === 'A'
    ? { outcome: 'A_WINS', claim_result: 'MET', void_reason: null }
    : { outcome: 'B_WINS', claim_result: 'NOT_MET', void_reason: null };
}
