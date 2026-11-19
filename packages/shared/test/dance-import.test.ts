// DANCE-OFF §8: `scripts/dance-routine.ts import` (its pure half, src/dance/routine-import.ts) on
// the JSON tools/dance-ref writes: real video timestamps, Vision gaps, optional key_moves, "".
import { describe, expect, it } from 'vitest';
import { dequantizePerson, getRoutine, RoutineData } from '../src';
import {
  beatTimes,
  defaultEvery,
  KEY_MOVE_EDGE_MS,
  normalizeKeyMoveTimes,
  pickKeyMoveTimes,
  routineFromImport,
  routineIdSlug,
  type RoutineImportJson,
} from '../src/dance/routine-import';

const BB = getRoutine('bounce-back')!;

/**
 * What the tool writes for a take of `r`: floats, frames at real timestamps (t + 1 ms, so no
 * beat lands on a frame), a 600 ms hole where Vision saw nobody, and the tool's own extra keys.
 */
function toolJson(r: RoutineData, over: Partial<RoutineImportJson> = {}): RoutineImportJson {
  const json = {
    schema_version: 1,
    id: 'bounce_back_take2',
    version: 2,
    title: '',
    song: '',
    bpm: r.bpm,
    duration_ms: 15_000,
    first_beat_ms: r.first_beat_ms,
    count_in_beats: 3,
    w: r.w,
    h: r.h,
    mirrored_source: false,
    source: 'vision',
    frames: r.frames
      .map((f) => ({ t: f.t + 1, k: dequantizePerson(f.k) }))
      .filter((f) => f.t < 3_000 || f.t > 3_600),
    key_moves: r.key_moves.map((m, i) => ({
      id: `km${String(i + 1).padStart(2, '0')}`,
      t: m.t,
      name: m.name,
    })),
    media: { video: null, audio: null },
    ...over,
  };
  return json;
}

const onBeat = (t: number, r: { bpm: number; first_beat_ms: number }, k = 1) => {
  const beats = (t - r.first_beat_ms) / ((k * 60_000) / r.bpm);
  return Math.abs(beats - Math.round(beats)) * ((k * 60_000) / r.bpm) <= 2;
};

describe('routine import', () => {
  it('keeps the JSON key moves on their beats with their names (never snapped to a frame)', () => {
    const r = routineFromImport(toolJson(BB), {});
    expect(r.key_moves.map((m) => m.t)).toEqual(BB.key_moves.map((m) => m.t));
    expect(r.key_moves.map((m) => m.name)).toEqual(BB.key_moves.map((m) => m.name));
    const ids = BB.key_moves.map((_, i) => `k${String(i + 1).padStart(2, '0')}`);
    expect(r.key_moves.map((m) => m.id)).toEqual(ids);
    const frameTimes = new Set(r.frames.map((f) => f.t));
    expect(r.key_moves.some((m) => frameTimes.has(m.t))).toBe(false);
    for (const m of r.key_moves) expect(onBeat(m.t, BB)).toBe(true);
    // The Vision gap survives as a gap; nothing is resampled.
    expect(r.frames.some((f) => f.t > 3_000 && f.t < 3_600)).toBe(false);
    expect(RoutineData.safeParse(r).success).toBe(true);
  });

  it('takes the tool output as written: version 2, "" song and title, underscores in id', () => {
    const r = routineFromImport(toolJson(BB), {});
    expect(r.id).toBe('bounce-back-take2');
    expect(r.version).toBe(2);
    expect(r.title).toBe('bounce-back-take2');
    expect(r.song).toBe('Unnamed track');
    expect(r.source).toBe('vision');
    expect(r.media).toEqual({ video: null, audio: null });
    const flagged = routineFromImport(toolJson(BB), {
      id: 'bounce-back',
      title: 'x'.repeat(60),
      song: 'y'.repeat(100),
      version: '3',
    });
    expect(flagged).toMatchObject({ id: 'bounce-back', version: 3 });
    expect(flagged.title).toHaveLength(40);
    expect(flagged.song).toHaveLength(80);
    expect(routineFromImport(toolJson(BB, { song: 'Click 112' }), { song: '' }).song).toBe(
      'Click 112',
    );
  });

  it('picks beats when the JSON has no key_moves and no flag picks them', () => {
    const json = toolJson(BB);
    delete json.key_moves;
    const r = routineFromImport(json, {});
    const k = defaultEvery(BB.bpm, BB.first_beat_ms);
    expect(k).toBe(2);
    expect(r.key_moves.length).toBeGreaterThanOrEqual(8);
    expect(r.key_moves.length).toBeLessThanOrEqual(16);
    expect(r.key_moves.map((m) => m.t)).toEqual(beatTimes(BB.bpm, BB.first_beat_ms, k));
    for (const m of r.key_moves) {
      expect(onBeat(m.t, BB, k)).toBe(true);
      expect(m.t).toBeGreaterThanOrEqual(KEY_MOVE_EDGE_MS);
      expect(m.t).toBeLessThanOrEqual(15_000 - KEY_MOVE_EDGE_MS);
    }
    expect(r.key_moves[0]!.name).toBe('Move 1');
    // 120 bpm from 500 ms: every 2 beats, 500..14500 = 15 moves.
    expect(beatTimes(120, 500, defaultEvery(120, 500))).toHaveLength(15);
  });

  it('flags win over the JSON: --every K, then --key-moves (names still match by time)', () => {
    const every = routineFromImport(toolJson(BB), { every: '3' });
    expect(every.key_moves.map((m) => m.t)).toEqual(beatTimes(BB.bpm, BB.first_beat_ms, 3));
    const picked = BB.key_moves.slice(0, 8).map((m) => m.t);
    const explicit = routineFromImport(toolJson(BB), { keyMoves: picked.join(', ') });
    expect(explicit.key_moves.map((m) => m.t)).toEqual(picked);
    const names = BB.key_moves.slice(0, 8).map((m) => m.name);
    expect(explicit.key_moves.map((m) => m.name)).toEqual(names);
    expect(() => routineFromImport(toolJson(BB), { keyMoves: '1000,2000' })).toThrow(
      /2 key moves/,
    );
    expect(() => routineFromImport(toolJson(BB), { every: '1.5' })).toThrow(/--every/);
  });

  it('normalizes times: clamp, de-duplicate, sort and thin to 16', () => {
    const messy = [9000, -50, 1000.4, 1000, 20_000, 3000, 4000, 5000, 6000];
    expect(normalizeKeyMoveTimes(messy)).toEqual([0, 1000, 3000, 4000, 5000, 6000, 9000, 15_000]);
    const many = Array.from({ length: 40 }, (_, i) => 500 + i * 300);
    const thin = normalizeKeyMoveTimes(many);
    expect(thin).toHaveLength(16);
    expect(thin[0]).toBe(500);
    expect([...thin].sort((a, b) => a - b)).toEqual(thin);
    expect(() => normalizeKeyMoveTimes([1000, Number.NaN])).toThrow(/bad key-move time/);
    expect(pickKeyMoveTimes({}, { keyMoves: '' }, 120, 500)).toHaveLength(15);
  });

  it('slugs ids into kebab-case and refuses an empty one', () => {
    expect(routineIdSlug('Wave_Pop 2')).toBe('wave-pop-2');
    expect(routineIdSlug('--x--')).toBe('x');
    expect(routineIdSlug('a'.repeat(31) + '-b')).toBe('a'.repeat(31));
    expect(() => routineFromImport(toolJson(BB, { id: '__' }), {})).toThrow(/bad id/);
    expect(() => routineFromImport(toolJson(BB, { id: '' }), {})).toThrow(/--id is required/);
  });
});
