// Dance Off on the projector (DANCE-OFF §1, §5): both players dance side by side to a reference
// routine (5..40 s, each routine its own length) in front of one judge-cam phone; the shared
// scorer decides, Claude only validates the round. Pure helpers over the BetView the ticker folds:
//
//   - which bets are dance offs (Terms.type 'dance_off', performer null: BOTH perform);
//   - the routine the terms commit to (success_criteria[0] "Routine <id> v<n> sha256:<16 hex>",
//     its title and key-move names from the bundled registry);
//   - the `dance.scored` record (scores in tenths, winner, per-move PERFECT / GOOD / MISS, the
//     deterministic checks, Claude's validation) as the card keeps it;
//   - what the stage says in each step: framing -> dancing -> scoring -> the verdict, where a VOID
//     dance ruling reads "Too close to call" (or "No contest" for an invalid round), never "NN%".
import { getRoutine, routineSeconds } from '@youre-on/shared/dance/routine';
import { DANCE_TERMS_TYPE, parseDanceRoutineLine } from '@youre-on/shared/dance/terms';
import type { DanceScoredPayload } from '@youre-on/shared/realtime';
import { CALLED_OFF_MODEL, DANCE_OFF_MODEL } from '@youre-on/shared/ruling';
import type { BetView, PartyKey } from './ticker';

export type DanceGrade = 'PERFECT' | 'GOOD' | 'MISS';
export const DANCE_GRADES: readonly DanceGrade[] = ['PERFECT', 'GOOD', 'MISS'];

/** The card's copy of a `dance.scored` event (the server's re-score of the uploaded poses). */
export interface DanceView {
  attempt_no: number;
  routine_id: string;
  routine_version: number;
  /** Display scores in tenths (0..1000): 874 reads "87.4". */
  scores: { a: number; b: number };
  winner: PartyKey | null;
  too_close: boolean;
  /** coverage_a | coverage_b | no_frames: a round the scorer could not decide. */
  failed: string | null;
  key_moves: Array<{ id: string; a: DanceGrade; b: DanceGrade }>;
  checks: {
    coverage_a_pct: number;
    coverage_b_pct: number;
    max_people: number;
    side_swaps: number;
  };
  /** Claude's check of the round (never the winner); 'skipped' when it timed out. */
  validation: { verdict: 'valid' | 'invalid' | 'skipped'; notes: string };
  announcer_line: string;
  evidence_hash: string;
}

export function danceViewOf(p: DanceScoredPayload): DanceView {
  const e = p.evidence;
  return {
    attempt_no: e.attempt_no,
    routine_id: e.routine.id,
    routine_version: e.routine.version,
    scores: { a: e.scores.a, b: e.scores.b },
    winner: e.winner,
    too_close: e.too_close,
    failed: e.failed,
    key_moves: e.key_moves.map((k) => ({ id: k.id, a: k.a, b: k.b })),
    checks: { ...e.checks },
    validation: { verdict: p.validation.verdict, notes: p.validation.notes },
    announcer_line: p.announcer_line,
    evidence_hash: p.evidence_hash,
  };
}

/**
 * A dance off: its terms say so, or (a cold start before the envelope) its scored record or its
 * ruling does. Every place that would read `terms.performer` checks this first: a dance off has
 * none (both dance).
 */
export const isDanceBet = (b: BetView | null | undefined): boolean =>
  !!b &&
  (b.envelope?.terms.type === DANCE_TERMS_TYPE ||
    b.dance !== null ||
    b.ruling?.model === DANCE_OFF_MODEL);

/** "Wave Pop" in "Dance Off: Wave Pop, 15 seconds, higher match score wins, $5 each". */
const CLAIM_TITLE_RE = /^Dance Off: (.+?), (\d+) seconds\b/;

export interface DanceRoutineInfo {
  id: string | null;
  title: string;
  /** The round length in whole seconds (the routine's own, else the claim's), or null. */
  seconds: number | null;
  /** Key-move id -> its name ("k02" -> "Arms up"), when the routine is bundled here. */
  moves: Record<string, string>;
}

/**
 * The routine the bet is danced to: the id from success_criteria[0], the title and key-move
 * names from the bundled registry (only when the version matches), else the title the claim
 * spells out. null for a bet that is not a dance off, or with nothing to go on yet.
 */
export function danceRoutineOf(b: BetView): DanceRoutineInfo | null {
  if (!isDanceBet(b)) return null;
  const t = b.envelope?.terms;
  const line = t?.success_criteria[0];
  const ref = line !== undefined ? parseDanceRoutineLine(line) : null;
  const id = ref?.routine_id ?? b.dance?.routine_id ?? null;
  const version = ref?.version ?? b.dance?.routine_version ?? null;
  const r = id ? getRoutine(id) : null;
  const known = r && (version === null || r.version === version) ? r : null;
  const claim = t ? CLAIM_TITLE_RE.exec(t.claim) : null;
  const fromClaim = claim?.[1]?.trim();
  const title = known?.title ?? fromClaim ?? (id ? titleCase(id) : null);
  if (!title) return null;
  const seconds = known ? routineSeconds(known) : claim?.[2] ? Number(claim[2]) : null;
  const moves: Record<string, string> = {};
  for (const k of known?.key_moves ?? []) moves[k.id] = k.name;
  return { id, title, seconds, moves };
}

const titleCase = (id: string) =>
  id
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

/** "Wave Pop · 15 seconds", "Bye Bye Shuffle · 33 seconds" (each routine has its own length). */
export function danceRoutineLabel(b: BetView): string {
  const r = danceRoutineOf(b);
  const len = danceSecondsText(r);
  return r ? `${r.title} · ${len}` : len;
}

/** "15 seconds", or "One round" when the length is unknown. */
export const danceSecondsText = (r: Pick<DanceRoutineInfo, 'seconds'> | null): string =>
  r?.seconds != null ? `${r.seconds} seconds` : 'One round';

/** A display score in tenths, as the scoreboard prints it: 874 -> "87.4". */
export const danceScoreText = (x10: number): string =>
  Number.isFinite(x10) ? (Math.max(0, Math.min(1000, Math.round(x10))) / 10).toFixed(1) : '—';

/** Where a dance off's play phase is: lining up, the round, or the server scoring it. */
export type DancePlayStep = 'framing' | 'dancing' | 'scoring';

export function dancePlayStep(b: BetView): DancePlayStep {
  if (b.dance || b.state === 'JUDGING') return 'scoring';
  if (b.attempt_no !== null || b.state === 'ATTEMPT') return 'dancing';
  return 'framing';
}

/**
 * The phone that films the round. DANCE-OFF §6.2: the room's judge cam, or else A's phone. The
 * stage cannot tell a judge cam apart from the parties' phones, so it shows A's phone filming.
 */
export const DANCE_RECORDER: PartyKey = 'A';

/** How the round came out, once ruled: a winner, too close to call, or no contest. */
export type DanceResult =
  { kind: 'win'; winner: PartyKey } | { kind: 'too_close' } | { kind: 'no_contest' };

export function danceResult(b: BetView): DanceResult | null {
  const o = b.appeal_result?.final_outcome ?? b.ruling?.outcome;
  if (o === 'A_WINS') return { kind: 'win', winner: 'A' };
  if (o === 'B_WINS') return { kind: 'win', winner: 'B' };
  if (o !== 'VOID') return null;
  // A call-off (both players agreed, or the operator): no round, so no contest.
  if (b.ruling?.model === CALLED_OFF_MODEL) return { kind: 'no_contest' };
  const d = b.dance;
  // DANCE-OFF §5: an invalid round (someone left, a third dancer, a side swap) is void with the
  // reason naming it; a too-close or failed (coverage) round is "too close to call".
  if (d && d.validation.verdict === 'invalid' && !d.too_close && !d.failed)
    return { kind: 'no_contest' };
  return { kind: 'too_close' };
}

/** The verdict line: "Logan wins", "Too close to call", "No contest". */
export function danceVerdictLine(r: DanceResult, name: (p: PartyKey) => string): string {
  if (r.kind === 'win') return `${name(r.winner)} wins`;
  return r.kind === 'too_close' ? 'Too close to call' : 'No contest';
}

/** One column of the key-move grid: the move's name and each dancer's grade. */
export interface KeyMoveRow {
  id: string;
  name: string;
  a: DanceGrade;
  b: DanceGrade;
}

export function keyMoveRows(b: BetView): KeyMoveRow[] {
  const d = b.dance;
  if (!d) return [];
  const moves = danceRoutineOf(b)?.moves ?? {};
  return d.key_moves.map((k, i) => ({
    id: k.id,
    name: moves[k.id] ?? `Move ${i + 1}`,
    a: k.a,
    b: k.b,
  }));
}

/** PERFECT / GOOD / MISS counts for one dancer. */
export function gradeTally(
  moves: ReadonlyArray<{ a: DanceGrade; b: DanceGrade }>,
  party: PartyKey,
): Record<DanceGrade, number> {
  const out: Record<DanceGrade, number> = { PERFECT: 0, GOOD: 0, MISS: 0 };
  for (const m of moves) out[party === 'A' ? m.a : m.b] += 1;
  return out;
}

/** "5 perfect · 4 good · 3 miss" (zero counts left out; "no key moves" when there are none). */
export function tallyLine(t: Record<DanceGrade, number>): string {
  const parts = DANCE_GRADES.filter((g) => t[g] > 0).map((g) => `${t[g]} ${g.toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'no key moves';
}

/** "87.4 to 71.0", winner first when there is one (the rail and the ticker). */
export function danceScoreLine(d: Pick<DanceView, 'scores' | 'winner'>): string {
  const a = danceScoreText(d.scores.a);
  const b = danceScoreText(d.scores.b);
  return d.winner === 'B' ? `${b} to ${a}` : `${a} to ${b}`;
}

/** "Logan wins · Logan 87.4 · Jake 71.0" (the verdict only once ruled); null before the score. */
export function danceSummaryLine(b: BetView, name: (p: PartyKey) => string): string | null {
  const d = b.dance;
  if (!d) return null;
  const r = danceResult(b);
  const a = `${name('A')} ${danceScoreText(d.scores.a)}`;
  const scores = `${a} · ${name('B')} ${danceScoreText(d.scores.b)}`;
  return r ? `${danceVerdictLine(r, name)} · ${scores}` : scores;
}
