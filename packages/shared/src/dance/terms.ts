// DANCE-OFF §1: how a routine is bound into the hashed Terms. No new Terms keys: the routine id,
// version and the first 16 hex of its sha256 ride in success_criteria[0], so terms_hash commits
// to the exact reference the scorer uses.
//   claim                 "Dance Off: <title>, 15 seconds, higher match score wins, $X each"
//   success_criteria[0]   "Routine <routine_id> v<version> sha256:<first 16 hex of routine sha256>"
//   success_criteria[1]   "Higher match score wins; scores within <TIE_MARGIN> points are too close
//                          to call (refund)"
//   failure_criteria      []
import { formatUsd } from '../money';
import type { Terms } from '../terms';
import { getRoutine, routineSha256, type RoutineData } from './routine';
import { DANCE_SCORING } from './score';

export const DANCE_TERMS_TYPE = 'dance_off' as const;
/** The round length every routine has, in the claim's words. */
export const DANCE_ROUND_SECONDS = 15;
/** The tie margin in display points ("2" for 20 tenths). */
export const DANCE_TIE_MARGIN_POINTS = DANCE_SCORING.TIE_MARGIN_X10 / 10;

const ROUTINE_LINE_RE = /^Routine ([a-z0-9]+(?:-[a-z0-9]+)*) v([1-9][0-9]{0,5}) sha256:([0-9a-f]{16})$/;

export const isDanceOff = (t: Pick<Terms, 'type'>): boolean => t.type === DANCE_TERMS_TYPE;

/** "Dance Off: Wave Pop, 15 seconds, higher match score wins, $5 each". */
export const danceClaim = (r: Pick<RoutineData, 'title'>, stakeMicro: string): string =>
  `Dance Off: ${r.title}, ${DANCE_ROUND_SECONDS} seconds, higher match score wins, ` +
  `${formatUsd(stakeMicro)} each`;

/** "Routine wave-pop v1 sha256:812f15c411edd626". */
export const danceRoutineLine = (r: RoutineData): string =>
  `Routine ${r.id} v${r.version} sha256:${routineSha256(r).slice(0, 16)}`;

/** "Higher match score wins; scores within 2 points are too close to call (refund)". */
export const DANCE_RULE_LINE = `Higher match score wins; scores within ${DANCE_TIE_MARGIN_POINTS} points are too close to call (refund)`;

/** The hashed text fields of a dance-off (the rest of the projection is fixed: see judge/dance-terms). */
export function danceTermsText(
  r: RoutineData,
  stakeMicro: string,
): { claim: string; success_criteria: [string, string]; failure_criteria: string[] } {
  return {
    claim: danceClaim(r, stakeMicro),
    success_criteria: [danceRoutineLine(r), DANCE_RULE_LINE],
    failure_criteria: [],
  };
}

export interface DanceRoutineLine {
  routine_id: string;
  version: number;
  /** First 16 hex chars of the routine's sha256. */
  sha16: string;
}

/** Parses "Routine <id> v<version> sha256:<16 hex>" (no registry check). */
export function parseDanceRoutineLine(line: string): DanceRoutineLine | null {
  const m = ROUTINE_LINE_RE.exec(line);
  if (!m) return null;
  return { routine_id: m[1]!, version: Number(m[2]), sha16: m[3]! };
}

export type DanceTermsRoutine =
  | ({ ok: true; routine: RoutineData } & DanceRoutineLine)
  | {
      ok: false;
      reason: 'not_dance' | 'malformed' | 'unknown_routine' | 'version_mismatch' | 'sha_mismatch';
    };

/**
 * §1: the routine a dance-off's Terms commit to, verified against the BUNDLED registry (id,
 * version and sha256 prefix must all match). The server scores only against this routine.
 */
export function parseDanceTermsRoutine(
  terms: Pick<Terms, 'type' | 'success_criteria'>,
): DanceTermsRoutine {
  if (terms.type !== DANCE_TERMS_TYPE) return { ok: false, reason: 'not_dance' };
  const line = terms.success_criteria[0];
  const parsed = line === undefined ? null : parseDanceRoutineLine(line);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const routine = getRoutine(parsed.routine_id);
  if (!routine) return { ok: false, reason: 'unknown_routine' };
  if (routine.version !== parsed.version) return { ok: false, reason: 'version_mismatch' };
  if (routineSha256(routine).slice(0, 16) !== parsed.sha16)
    return { ok: false, reason: 'sha_mismatch' };
  return { ok: true, routine, ...parsed };
}
