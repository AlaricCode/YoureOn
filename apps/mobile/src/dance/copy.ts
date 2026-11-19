// Every fixed string of the Dance Off screens (the live display, the result, the other phone's
// watch screen), with its copy role (ui/copyRule), checked by ./__tests__/copy.test.ts like
// gg/copy. Names, scores, routine titles and the announcer line are data.
import type { FramingReason } from '@youre-on/shared/dance/track';
import type { KeyMoveGrade } from '@youre-on/shared/dance/score';

import type { CopyRole } from '../ui/copyRule';
import type { RoundError } from './model/round';

type Line = readonly [text: string, role: CopyRole];

export const DANCE_COPY = {
  title: ['Dance off', 'label'],
  live: ['Dance off live', 'label'],
  // Framing (the framing check's reasons, then the hold before Start).
  needTwo: ['Two dancers needed', 'label'],
  tooMany: ['Too many people', 'label'],
  feet: ['Step back', 'label'],
  head: ['Heads in frame', 'label'],
  sameSide: ['One each side', 'label'],
  tooClose: ['Spread out', 'label'],
  hold: ['Hold it', 'label'],
  ready: ['Ready', 'label'],
  findingYou: ['Finding you', 'label'],
  start: ['Start', 'label'],
  // The round.
  starting: ['Starting', 'label'],
  getReady: ['Get ready', 'label'],
  go: ['GO', 'label'],
  match: ['Match', 'label'],
  nextMove: ['Next', 'label'],
  scoring: ['Scoring', 'label'],
  // Key-move popups.
  perfect: ['PERFECT', 'label'],
  good: ['GOOD', 'label'],
  miss: ['MISS', 'label'],
  // The result.
  wins: ['wins', 'label'],
  // Four words: the contract's own phrase for a refund (DANCE-OFF §5), so it is the body line.
  tooCloseToCall: ['Too close to call', 'body'],
  moves: ['Moves', 'label'],
  you: ['You', 'label'],
  sending: ['Sending to judge', 'label'],
  withJudge: ['With the judge', 'label'],
  judged: ['Judged', 'label'],
  notCounted: ['Round not counted', 'label'],
  // Watch screen (the other phone).
  gettingReady: ['Getting ready', 'label'],
  judging: ['Judging', 'label'],
  versus: ['vs', 'label'],
  // Actions.
  tryAgain: ['Try again', 'label'],
  danceAgain: ['Dance again', 'label'],
  leave: ['Leave', 'label'],
  // Problems (red lines, 1-3 words).
  noCamera: ['No camera', 'error'],
  // The iOS Simulator only (model/simRound, device/simulator): no camera, so a synthetic round.
  simSample: ['Simulator: play a sample round', 'contract'],
  cameraError: ['Camera error', 'error'],
  startFailed: ["Couldn't start", 'error'],
  noAttempt: ['Judge not ready', 'error'],
  noFrames: ['No frames caught', 'error'],
  uploadFailed: ["Couldn't send", 'error'],
  unknownRoutine: ['Unknown routine', 'error'],
} as const satisfies Record<string, Line>;

export const dt = (line: Line): string => line[0];

/** The framing reason → its line (`ok` is the hold before Start). */
export const FRAMING_COPY: Readonly<Record<FramingReason, Line>> = {
  ok: DANCE_COPY.hold,
  need_two: DANCE_COPY.needTwo,
  too_many: DANCE_COPY.tooMany,
  feet: DANCE_COPY.feet,
  head: DANCE_COPY.head,
  same_side: DANCE_COPY.sameSide,
  too_close: DANCE_COPY.tooClose,
};

export const GRADE_COPY: Readonly<Record<KeyMoveGrade, Line>> = {
  PERFECT: DANCE_COPY.perfect,
  GOOD: DANCE_COPY.good,
  MISS: DANCE_COPY.miss,
};

export const ERROR_COPY: Readonly<Record<RoundError, Line>> = {
  start_failed: DANCE_COPY.startFailed,
  no_attempt: DANCE_COPY.noAttempt,
  camera: DANCE_COPY.cameraError,
  no_frames: DANCE_COPY.noFrames,
  upload_failed: DANCE_COPY.uploadFailed,
};

/** First name only, so "<name> wins" stays a short label ("Eva Santos" → "Eva"). */
export const firstName = (name: string, fallback = 'They'): string =>
  name.trim().split(/\s+/)[0] || fallback;

/**
 * The two dancers' on-screen names (the framing hint, the name tags, "X vs Y", the result): first
 * names, unless both share one ("Alex Kim" and "Alex Ruiz"), then first name + last initial
 * ("Alex K" / "Alex R": no period, so "Alex K wins" stays a label), or the full names when that
 * still reads the same.
 */
export function danceLabels(names: { a: string; b: string }): { a: string; b: string } {
  const fa = firstName(names.a);
  const fb = firstName(names.b);
  if (fa.toLocaleLowerCase() !== fb.toLocaleLowerCase()) return { a: fa, b: fb };
  const initialed = (name: string, first: string) => {
    const last = name.trim().split(/\s+/).slice(1).at(-1);
    return last ? `${first} ${last[0]!.toLocaleUpperCase()}` : first;
  };
  const ia = initialed(names.a, fa);
  const ib = initialed(names.b, fb);
  if (ia.toLocaleLowerCase() !== ib.toLocaleLowerCase()) return { a: ia, b: ib };
  return { a: names.a.trim() || fa, b: names.b.trim() || fb };
}

/** "Logan wins" (a first name), or with `label` the danceLabels label as it is ("Alex K wins"). */
export const winsLabel = (name: string, label?: string): string =>
  `${label ?? firstName(name)} ${dt(DANCE_COPY.wins)}`;

/** Tenths → "87.4" (data). */
export const scoreText = (x10: number): string => {
  const v = Math.max(0, Math.min(1000, Math.round(x10)));
  return `${Math.floor(v / 10)}.${v % 10}`;
};

/** A live meter 0..100 → "87" (data). */
export const meterText = (meter: number): string =>
  String(Math.max(0, Math.min(100, Math.round(meter))));

/** Seconds left → "0:33" (data; a routine is at most 40 s, but minutes are kept anyway). */
export const clockText = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
