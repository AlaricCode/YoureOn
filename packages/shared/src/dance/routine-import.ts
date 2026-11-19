// DANCE-OFF §8: the pure half of `scripts/dance-routine.ts import`. It turns the JSON the macOS
// reference tool (tools/dance-ref) writes into a RoutineData: keeps the frames in 0..15000 ms,
// quantizes them, picks the key moves and validates the result. No I/O, so it is unit tested.
// Script-only: NOT re-exported from ./index (the phone and the stage never need it).
import { KEYPOINT_LEN } from './joints';
import { quantizePerson } from './pose';
import {
  ROUTINE_COUNT_IN_BEATS,
  ROUTINE_DURATION_MS,
  ROUTINE_MAX_KEY_MOVES,
  ROUTINE_MIN_KEY_MOVES,
  RoutineData,
} from './routine';

/** What tools/dance-ref writes (extra keys such as schema_version or w/h ints are fine). */
export interface RoutineImportJson {
  id?: string;
  version?: number;
  title?: string;
  song?: string;
  bpm?: number;
  first_beat_ms?: number;
  w: number;
  h: number;
  source?: string;
  /** Gaps are allowed (Vision saw nobody); no fixed cadence is assumed. */
  frames: { t: number; k: (number | null)[] }[];
  /** Optional: when absent (and no flag picks them) the importer picks beats. */
  key_moves?: { id?: string; t: number; name?: string }[];
  media?: { video: string | null; audio: string | null };
}

/** The CLI flags, as strings (undefined or '' = not given). Flags override the JSON. */
export interface RoutineImportFlags {
  id?: string;
  title?: string;
  song?: string;
  bpm?: string;
  firstBeatMs?: string;
  version?: string;
  /** "ms,ms,…" */
  keyMoves?: string;
  /** Every K beats from first_beat_ms. */
  every?: string;
}

/** A picked beat stays this far from either end, so its judging window fits the round. */
export const KEY_MOVE_EDGE_MS = 500;
const TITLE_MAX = 40;
const SONG_MAX = 80;
const ID_MAX = 32;
const NAME_MAX = 24;

/** "Wave_Pop 2" -> "wave-pop-2": the tool allows underscores, RoutineId is kebab-case. */
export function routineIdSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '');
}

/** Beats first_beat_ms + n·K·beat (n ≥ 0) that sit KEY_MOVE_EDGE_MS inside the round. */
export function beatTimes(bpm: number, firstBeatMs: number, k: number): number[] {
  const step = (k * 60_000) / bpm;
  const out: number[] = [];
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(firstBeatMs)) return out;
  for (let n = 0; ; n++) {
    const t = Math.round(firstBeatMs + n * step);
    if (t > ROUTINE_DURATION_MS - KEY_MOVE_EDGE_MS) break;
    if (t >= KEY_MOVE_EDGE_MS) out.push(t);
  }
  return out;
}

/** The smallest K whose beats fit in ROUTINE_MAX_KEY_MOVES (2 at 120 bpm: 14 moves). */
export function defaultEvery(bpm: number, firstBeatMs: number): number {
  let k = 1;
  while (beatTimes(bpm, firstBeatMs, k).length > ROUTINE_MAX_KEY_MOVES) k++;
  return k;
}

/** Clamp into the round, round to ms, de-duplicate, sort, then thin evenly to at most 16. */
export function normalizeKeyMoveTimes(times: readonly number[]): number[] {
  if (times.some((t) => !Number.isFinite(t))) throw new Error('bad key-move time');
  const clamped = times.map((t) => Math.min(ROUTINE_DURATION_MS, Math.max(0, Math.round(t))));
  let uniq = [...new Set(clamped)].sort((a, b) => a - b);
  if (uniq.length > ROUTINE_MAX_KEY_MOVES) {
    const step = uniq.length / ROUTINE_MAX_KEY_MOVES;
    const all = uniq;
    uniq = Array.from({ length: ROUTINE_MAX_KEY_MOVES }, (_, i) => all[Math.floor(i * step)]!);
  }
  if (uniq.length < ROUTINE_MIN_KEY_MOVES) {
    const need = `${ROUTINE_MIN_KEY_MOVES}..${ROUTINE_MAX_KEY_MOVES}`;
    throw new Error(`${uniq.length} key moves; a routine needs ${need}`);
  }
  return uniq;
}

const given = (s: string | undefined): string | undefined =>
  s === undefined || s.trim() === '' ? undefined : s.trim();

/**
 * The key-move times, in priority order: --key-moves, --every K, the JSON's key_moves, and
 * otherwise every defaultEvery() beats. Times are used as given (never snapped to a frame: the
 * scorer looks up the nearest reference frame itself), so they stay on the beat.
 */
export function pickKeyMoveTimes(
  raw: Pick<RoutineImportJson, 'key_moves'>,
  flags: Pick<RoutineImportFlags, 'keyMoves' | 'every'>,
  bpm: number,
  firstBeatMs: number,
): number[] {
  const explicit = given(flags.keyMoves);
  const every = given(flags.every);
  if (explicit) return normalizeKeyMoveTimes(explicit.split(',').map((s) => Number(s.trim())));
  if (every) {
    const k = Number(every);
    if (!Number.isInteger(k) || k < 1) throw new Error('--every K: a whole number of beats');
    return normalizeKeyMoveTimes(beatTimes(bpm, firstBeatMs, k));
  }
  if (raw.key_moves?.length) return normalizeKeyMoveTimes(raw.key_moves.map((m) => m.t));
  return normalizeKeyMoveTimes(beatTimes(bpm, firstBeatMs, defaultEvery(bpm, firstBeatMs)));
}

/** Builds and validates (RoutineData.parse) the routine. Throws with a readable message. */
export function routineFromImport(raw: RoutineImportJson, flags: RoutineImportFlags): RoutineData {
  const idIn = given(flags.id) ?? given(raw.id);
  if (!idIn) throw new Error('--id is required (or an "id" in the JSON)');
  const id = routineIdSlug(idIn);
  if (!id) throw new Error(`bad id "${idIn}"`);
  const bpm = Number(given(flags.bpm) ?? raw.bpm ?? 120);
  const firstBeat = Math.round(Number(given(flags.firstBeatMs) ?? raw.first_beat_ms ?? 0));
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('bad --bpm');
  if (!Number.isFinite(firstBeat) || firstBeat < 0) throw new Error('bad --first-beat-ms');
  if (!Number.isFinite(raw.w) || !Number.isFinite(raw.h)) throw new Error('w / h are required');
  if (!Array.isArray(raw.frames)) throw new Error('frames are required');

  // Floats in [0, 1] (the tool's raw output) or ints already quantized (xy ≤ 10000, c ≤ 1000).
  const quantized = raw.frames.some((f) => f.k.some((v) => v !== null && v > 1));
  const frames: RoutineData['frames'] = [];
  for (const f of raw.frames) {
    const t = Math.round(f.t);
    if (!Number.isFinite(t) || t < 0 || t > ROUTINE_DURATION_MS) continue;
    if (frames.length && t <= frames[frames.length - 1]!.t) continue;
    if (f.k.length !== KEYPOINT_LEN) throw new Error(`frame t=${t}: ${f.k.length} values`);
    const k = f.k.map((v, i) => {
      if (v === null || !Number.isFinite(v)) return 0;
      if (!quantized) return v;
      return i % 3 === 2 ? v / 1000 : v / 10_000;
    });
    frames.push({ t, k: quantizePerson(k) });
  }
  if (frames.length < 2) throw new Error('fewer than 2 frames inside 0..15000 ms');

  const times = pickKeyMoveTimes(raw, flags, bpm, firstBeat);
  // Names from the JSON (the tool's --key-move-names), matched on the ORIGINAL (clamped) time.
  const named = new Map<number, string>();
  for (const m of raw.key_moves ?? []) {
    const name = typeof m.name === 'string' ? m.name.trim().slice(0, NAME_MAX).trim() : '';
    const t = Math.min(ROUTINE_DURATION_MS, Math.max(0, Math.round(m.t)));
    if (name && !named.has(t)) named.set(t, name);
  }
  const key_moves = times.map((t, i) => ({
    id: `k${String(i + 1).padStart(2, '0')}`,
    t,
    name: named.get(t) ?? `Move ${i + 1}`,
  }));

  // An empty string counts as not given: the tool writes "" when --song / --title were omitted.
  const title = (given(flags.title) ?? given(raw.title) ?? id).slice(0, TITLE_MAX);
  const song = (given(flags.song) ?? given(raw.song) ?? 'Unnamed track').slice(0, SONG_MAX);
  return RoutineData.parse({
    schema_version: 1,
    id,
    version: Number(given(flags.version) ?? raw.version ?? 1),
    title,
    song,
    bpm,
    duration_ms: ROUTINE_DURATION_MS,
    first_beat_ms: firstBeat,
    count_in_beats: ROUTINE_COUNT_IN_BEATS,
    w: Math.round(raw.w),
    h: Math.round(raw.h),
    mirrored_source: false,
    source: raw.source === 'synthetic' ? 'synthetic' : 'vision',
    frames,
    key_moves,
    media: raw.media ?? { video: null, audio: null },
  });
}
