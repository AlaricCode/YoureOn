// DANCE-OFF §2: a reference routine (generated into ./routines/<id>.ts by scripts/dance-routine.ts)
// and the bundled registry. routine_sha256 = hashJcs(RoutineData) is bound into the Terms text
// (./terms.ts), so a routine file never changes once a bet has been locked on it: a new take gets
// a new `version`.
import { z } from 'zod/v4';
import { hashJcs } from '../jcs';
import { KEYPOINT_LEN, JOINT_COUNT } from './joints';
import { POSE_C_SCALE, POSE_XY_SCALE } from './pose';
import { ROUTINE_BOUNCE_BACK } from './routines/bounce-back';
import { ROUTINE_SIDE_SHUFFLE } from './routines/side-shuffle';
import { ROUTINE_WAVE_POP } from './routines/wave-pop';

export const ROUTINE_DURATION_MS = 15_000;
export const ROUTINE_COUNT_IN_BEATS = 3;
export const ROUTINE_MIN_KEY_MOVES = 8;
export const ROUTINE_MAX_KEY_MOVES = 16;

const Int = z.number().int();
export const RoutineId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case id');

const RoutineKeypoints = z
  .array(Int.min(0).max(POSE_XY_SCALE))
  .length(KEYPOINT_LEN)
  .refine((k) => {
    for (let j = 0; j < JOINT_COUNT; j++) if (k[j * 3 + 2]! > POSE_C_SCALE) return false;
    return true;
  }, `c must be 0..${POSE_C_SCALE}`);

export const RoutineKeyMove = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,24}$/),
  /** ms since t0, on a beat. */
  t: Int.min(0).max(ROUTINE_DURATION_MS),
  /** Shown in the PERFECT / GOOD / MISS popup, e.g. "Arms up". */
  name: z.string().min(1).max(24),
});
export type RoutineKeyMove = z.infer<typeof RoutineKeyMove>;

export const RoutineData = z
  .strictObject({
    schema_version: z.literal(1),
    id: RoutineId.max(32),
    version: Int.min(1),
    title: z.string().min(1).max(40),
    /** Royalty-free or ElevenLabs Music only (DANCE-OFF §8). */
    song: z.string().min(1).max(80),
    bpm: z.number().min(40).max(240),
    duration_ms: z.literal(ROUTINE_DURATION_MS),
    /** The first downbeat after t0; the count-in plays the 3 beats before t0. */
    first_beat_ms: Int.min(0).max(ROUTINE_DURATION_MS),
    count_in_beats: z.literal(ROUTINE_COUNT_IN_BEATS),
    w: Int.min(1).max(8192),
    h: Int.min(1).max(8192),
    mirrored_source: z.literal(false),
    source: z.enum(['synthetic', 'vision']),
    frames: z
      .array(z.strictObject({ t: Int.min(0).max(ROUTINE_DURATION_MS), k: RoutineKeypoints }))
      .min(2)
      .max(1_000),
    key_moves: z
      .array(RoutineKeyMove)
      .min(ROUTINE_MIN_KEY_MOVES)
      .max(ROUTINE_MAX_KEY_MOVES),
    media: z.strictObject({ video: z.string().nullable(), audio: z.string().nullable() }),
  })
  .superRefine((r, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    for (let i = 1; i < r.frames.length; i++)
      if (r.frames[i]!.t <= r.frames[i - 1]!.t) return bad(['frames', i, 't'], 't must increase');
    for (let i = 1; i < r.key_moves.length; i++)
      if (r.key_moves[i]!.t <= r.key_moves[i - 1]!.t)
        return bad(['key_moves', i, 't'], 't must increase');
    if (new Set(r.key_moves.map((m) => m.id)).size !== r.key_moves.length)
      bad(['key_moves'], 'ids must be unique');
  });
export type RoutineData = z.infer<typeof RoutineData>;

/** What DanceEvidence and the Terms text commit to. */
export interface RoutineRef {
  id: string;
  version: number;
  sha256: string;
}

const SHA_CACHE = new WeakMap<RoutineData, string>();

/** sha256(JCS(routine)), cached per object (the bundled routines are ~13k ints each). */
export function routineSha256(r: RoutineData): string {
  let h = SHA_CACHE.get(r);
  if (h === undefined) {
    h = hashJcs(r);
    SHA_CACHE.set(r, h);
  }
  return h;
}

export const routineRef = (r: RoutineData): RoutineRef => ({
  id: r.id,
  version: r.version,
  sha256: routineSha256(r),
});

/** The bundled routines, in the order the phone shows the cards. Exactly 3. */
export const ROUTINES: readonly RoutineData[] = [
  ROUTINE_WAVE_POP,
  ROUTINE_BOUNCE_BACK,
  ROUTINE_SIDE_SHUFFLE,
];

export const ROUTINE_IDS: readonly string[] = ROUTINES.map((r) => r.id);

export function getRoutine(id: string): RoutineData | null {
  for (const r of ROUTINES) if (r.id === id) return r;
  return null;
}

/** ms per beat. */
export const beatMs = (r: Pick<RoutineData, 'bpm'>): number => 60_000 / r.bpm;
