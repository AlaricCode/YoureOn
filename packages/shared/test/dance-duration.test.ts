// DANCE-OFF §2, §1, §4: the round length is per routine (RoutineData.duration_ms, 5..40 s). The
// two 15 s synthetic routines must score, hash and read EXACTLY as they did when every routine was
// 15 s (scorer_version stays dance-score@1), and a long routine (bye-bye-shuffle, 32.6 s) must
// carry its own length through the schema, the Terms text, the scorer and the upload.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeTermsHash,
  danceCoverageBins,
  danceRoundSeconds,
  danceTermsText,
  DanceUpload,
  DANCE_SCORER_VERSION,
  getRoutine,
  parseDanceTermsRoutine,
  poseSha256,
  PoseSeries,
  POSE_MAX_FRAMES,
  ROUTINE_MAX_DURATION_MS,
  ROUTINE_MIN_DURATION_MS,
  ROUTINE_SHA256_PINS,
  RoutineData,
  ROUTINES,
  routineSeconds,
  routineSha256,
  scoreRound,
  Terms,
} from '../src';
import { routineFromImport } from '../src/dance/routine-import';
import { jcs } from '../src/jcs';
import { lcg, makePlayer, selfSeries, seriesOf } from './dance-helpers';
import { skillTerms } from './fixtures';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const WAVE_POP = getRoutine('wave-pop')!;
const BOUNCE_BACK = getRoutine('bounce-back')!;
const BYE_BYE = getRoutine('bye-bye-shuffle')!;

function danceTerms(r: RoutineData, stake = '5000000') {
  const text = danceTermsText(r, stake);
  return {
    ...skillTerms(),
    type: 'dance_off',
    claim: text.claim,
    performer: null,
    yes_party: 'A',
    attempts: { count: 1, rule: 'single' },
    success_criteria: text.success_criteria,
    failure_criteria: [],
    edge_cases: [],
    evidence_source: 'camera',
    market: null,
    stakes: { a: stake, b: stake, currency: 'USDC' },
  };
}

/**
 * Pinned on main BEFORE the round length became per routine (every routine was a literal 15 s).
 * Each value is sha256(JSON.stringify(scoreRound(...))) over seeded synthetic players.
 */
const BASELINE = {
  'wave-pop': {
    sha: '812f15c411edd6269364f0af6b5d25cacba42a2ca953b33fc69c24275d26e454',
    self: '8135b6d8dff96345e1e66efe68ea27916c56b6ef818d80c304756b849afbf2b6',
    amateur_vs_still: 'd509156861526880d2d43811d424966c0d2c968203be686df3b08035e95623ec',
    half_vs_amateur: 'e335856effc5e015a792ba44aa69113a01e802796714ce8c0be7198aedf2be1d',
    scores: [775, 0, 527, 826, 'coverage_a'],
  },
  'bounce-back': {
    sha: '7cfedcae2fd032a0e490209d4244f212a047ea3fe179929602bab672e0b86fd1',
    self: '5dda5f3b1525bb2e25a46b1234558ae29fb8e4a57bd4175593e89ee3f33368d5',
    amateur_vs_still: '4f85d29ebd4ab9381ec2d3b040a2d62b00fc813bc1746f082bcf6f9c753f2dda',
    half_vs_amateur: 'f8e1e5f3b51ab4d572b1b546aede94917cd49a25d74a82bfe16fe026dfd426f3',
    scores: [737, 0, 495, 799, 'coverage_a'],
  },
} as const;

describe('15 s routines are unchanged (scorer dance-score@1)', () => {
  for (const id of ['wave-pop', 'bounce-back'] as const) {
    it(`${id}: same routine hash and byte-identical scoreRound results`, () => {
      const r = getRoutine(id)!;
      const want = BASELINE[id];
      expect(r.duration_ms).toBe(15_000);
      expect(routineSha256(r)).toBe(want.sha);
      expect(DANCE_SCORER_VERSION).toBe('dance-score@1');
      expect(digest(scoreRound(r, selfSeries(r)))).toBe(want.self);
      const rng = lcg(42);
      const amateur = makePlayer(
        r,
        { angleDeg: 12, lagMs: 250, lagWobbleMs: 60, jitter: 0.003 },
        rng,
      );
      const still = makePlayer(r, { stand: true, jitter: 0.003 }, rng);
      const half = makePlayer(
        r,
        { angleDeg: 12, lagMs: 250, jitter: 0.003, visibleUntilMs: 8000, dropout: 0.1 },
        rng,
      );
      const r1 = scoreRound(r, seriesOf(r, amateur, still));
      const r2 = scoreRound(r, seriesOf(r, half, amateur, { sync_offset_ms: 120 }));
      expect([r1.a.score_x10, r1.b.score_x10, r2.a.score_x10, r2.b.score_x10, r2.failed]).toEqual(
        want.scores,
      );
      expect(digest(r1)).toBe(want.amateur_vs_still);
      expect(digest(r2)).toBe(want.half_vs_amateur);
      expect(danceCoverageBins(r)).toBe(30);
    });
  }

  it('wave-pop: the exact Terms text and terms hash of before', () => {
    expect(danceTermsText(WAVE_POP, '5000000')).toEqual({
      claim: 'Dance Off: Wave Pop, 15 seconds, higher match score wins, $5 each',
      success_criteria: [
        'Routine wave-pop v1 sha256:812f15c411edd626',
        'Higher match score wins; scores within 2 points are too close to call (refund)',
      ],
      failure_criteria: [],
    });
    expect(computeTermsHash(danceTerms(WAVE_POP)).terms_hash).toBe(
      '3f512ec58f142b1b7833a88d637e787cfa87967b172a74944bafe93d2254356e',
    );
    expect(danceTermsText(BOUNCE_BACK, '5000000').claim).toBe(
      'Dance Off: Bounce Back, 15 seconds, higher match score wins, $5 each',
    );
  });
});

describe('per-routine round length (§2)', () => {
  it('bundles exactly 3 routines, bye-bye-shuffle first (the default card)', () => {
    expect(ROUTINES.map((r) => r.id)).toEqual(['bye-bye-shuffle', 'wave-pop', 'bounce-back']);
    expect(getRoutine('side-shuffle')).toBeNull();
  });

  it('bye-bye-shuffle: a 32.6 s Vision take with music, no video, 11 on-beat key moves', () => {
    expect(RoutineData.safeParse(BYE_BYE).success).toBe(true);
    expect(BYE_BYE).toMatchObject({
      duration_ms: 32_600,
      source: 'vision',
      bpm: 172.6,
      first_beat_ms: 235,
      media: { video: null, audio: 'bye-bye-shuffle.m4a' },
    });
    expect(BYE_BYE.key_moves).toHaveLength(11);
    expect(BYE_BYE.key_moves.at(-1)!.t).toBeLessThanOrEqual(BYE_BYE.duration_ms - 500);
    expect(BYE_BYE.frames.at(-1)!.t).toBeLessThanOrEqual(BYE_BYE.duration_ms);
    expect(routineSeconds(BYE_BYE)).toBe(33);
    expect(danceCoverageBins(BYE_BYE)).toBe(66);
  });

  it('routine sha pins match, and the one hashed float (bpm 172.6) prints as a short decimal', () => {
    expect(Object.keys(ROUTINE_SHA256_PINS).sort()).toEqual(ROUTINES.map((r) => r.id).sort());
    for (const r of ROUTINES) expect(routineSha256(r), r.id).toBe(ROUTINE_SHA256_PINS[r.id]);
    expect(ROUTINE_SHA256_PINS['bye-bye-shuffle']).toBe(
      'c60e0f2b6a99e2229334d128777abf3cecb7b9e5f50afab496fc5489bef1ef35',
    );
    expect(jcs(BYE_BYE)).toContain('"bpm":172.6,');
    // Every other number a routine hashes is an int.
    const floats: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'number' && !Number.isInteger(v)) floats.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    for (const r of ROUTINES) walk(r, r.id);
    expect(floats).toEqual(['bye-bye-shuffle.bpm']);
    // bpm is whole or one decimal; anything finer is refused.
    const bpm = (b: number) => RoutineData.safeParse({ ...WAVE_POP, bpm: b }).success;
    expect([bpm(120), bpm(172.6), bpm(99.9)]).toEqual([true, true, true]);
    expect([bpm(172.63), bpm(120.05), bpm(1 / 3 + 100)]).toEqual([false, false, false]);
  });

  it('duration_ms is 5000..40000 and bounds every frame, key move and the first beat', () => {
    const ok = (over: Partial<RoutineData>) => RoutineData.safeParse({ ...WAVE_POP, ...over });
    expect(ROUTINE_MIN_DURATION_MS).toBe(5_000);
    expect(ROUTINE_MAX_DURATION_MS).toBe(40_000);
    expect(ok({ duration_ms: 40_000 }).success).toBe(true);
    expect(ok({ duration_ms: 40_001 }).success).toBe(false);
    expect(ok({ duration_ms: 4_999 }).success).toBe(false);
    expect(ok({ duration_ms: 15_000.5 }).success).toBe(false);
    // wave-pop's last frame is at 15000: a 14.9 s duration leaves it outside.
    expect(ok({ duration_ms: 14_900 }).success).toBe(false);
    const frames = WAVE_POP.frames.filter((f) => f.t <= 12_000);
    const keys = WAVE_POP.key_moves.filter((m) => m.t <= 12_000);
    expect(ok({ duration_ms: 12_000, frames, key_moves: keys }).success).toBe(true);
    expect(
      ok({ duration_ms: 12_000, frames, key_moves: WAVE_POP.key_moves }).error?.issues[0]?.path,
    ).toEqual(['key_moves', keys.length, 't']);
    expect(
      ok({ duration_ms: 12_000, frames, key_moves: keys, first_beat_ms: 12_001 }).success,
    ).toBe(false);
  });

  it('Terms text says the routine length, parses back and hashes', () => {
    const t = Terms.parse(danceTerms(BYE_BYE, '10000000'));
    expect(t.claim).toBe(
      'Dance Off: Bye Bye Shuffle, 33 seconds, higher match score wins, $10 each',
    );
    expect(t.success_criteria[0]).toBe(
      `Routine bye-bye-shuffle v1 sha256:${routineSha256(BYE_BYE).slice(0, 16)}`,
    );
    const p = parseDanceTermsRoutine(t);
    expect(p.ok && p.routine).toBe(BYE_BYE);
    expect(danceRoundSeconds(t)).toBe(33);
    expect(danceRoundSeconds(Terms.parse(danceTerms(WAVE_POP)))).toBe(15);
    // A routine this build does not bundle: the claim's own number.
    const other = {
      ...t,
      claim: 'Dance Off: Moonwalk, 27 seconds, higher match score wins, $10 each',
      success_criteria: ['Routine moonwalk v1 sha256:0000000000000000', t.success_criteria[1]!],
    };
    expect(danceRoundSeconds(other)).toBe(27);
    expect(danceRoundSeconds(Terms.parse(skillTerms()))).toBeNull();
  });

  it('a 32.6 s round at 30 fps (count-in too) parses, uploads and self-scores 100', () => {
    const r = BYE_BYE;
    // The phone's series: count-in frames from −1000 ms, then 30 fps to the end + the tail.
    const frames: PoseSeries['frames'] = [];
    for (let t = -1_000; t <= r.duration_ms + 600; t += 33) {
      let k = r.frames[0]!.k;
      for (const f of r.frames) if (f.t <= t) k = f.k;
      frames.push({ t, n: 2, a: [...k], b: [...k] });
    }
    expect(frames.length).toBeGreaterThan(1_000);
    expect(frames.length).toBeLessThanOrEqual(POSE_MAX_FRAMES);
    const series = PoseSeries.parse({
      schema_version: 1,
      w: r.w,
      h: r.h,
      fps_cap: 30,
      sync_offset_ms: 0,
      frames,
    });
    const res = scoreRound(r, series);
    expect(res.failed).toBeNull();
    expect(res.a.score_x10).toBeGreaterThanOrEqual(990);
    expect(res.b.score_x10).toBe(res.a.score_x10);
    const upload = {
      routine_id: r.id,
      routine_sha256: routineSha256(r),
      series,
      pose_sha256: poseSha256(series),
      client_scores: { a: res.a.score_x10, b: res.b.score_x10 },
      clip_sha256: null,
      frames: [0, 1, 2, 3].map((index) => ({
        index,
        t_ms: 3_000 + index * 8_000,
        sha256: 'a'.repeat(64),
        width: 288,
        height: 512,
        bytes: 40_000,
      })),
    };
    expect(DanceUpload.safeParse(upload).success).toBe(true);
    // The JSON part a 33 s round sends (two players at 30 fps): well under the server's 4 MiB.
    expect(JSON.stringify(upload).length).toBeLessThan(1_500_000);
  });
});

describe('import keeps the JSON duration_ms (§8)', () => {
  const json = (duration_ms: number | undefined) => ({
    id: 'long-take',
    bpm: 120,
    first_beat_ms: 0,
    w: WAVE_POP.w,
    h: WAVE_POP.h,
    duration_ms,
    frames: Array.from({ length: 31 }, (_, i) => ({
      t: i * 1_000,
      k: WAVE_POP.frames[i % WAVE_POP.frames.length]!.k,
    })),
  });

  it('a 30 s take stays 30 s with key moves inside it; no duration is 15 s', () => {
    // Every 4 beats at 120 bpm = every 2 s; beats past 15 s count now, up to 29.5 s.
    const long = routineFromImport(json(30_000), { every: '4' });
    expect(long.duration_ms).toBe(30_000);
    expect(long.frames.at(-1)!.t).toBe(30_000);
    expect(long.key_moves.map((m) => m.t)).toEqual(
      Array.from({ length: 14 }, (_, i) => 2_000 * (i + 1)),
    );
    const def = routineFromImport(json(undefined), { every: '2' });
    expect(def.duration_ms).toBe(15_000);
    expect(def.frames.at(-1)!.t).toBe(15_000);
    expect(routineFromImport(json(30_000), { every: '2', durationMs: '20000' }).duration_ms).toBe(
      20_000,
    );
    expect(() => routineFromImport(json(41_000), { every: '2' })).toThrow(/duration_ms/);
  });

  it('--audio / --video set the routine media', () => {
    const r = routineFromImport(json(30_000), { every: '4', audio: 'long-take.m4a' });
    expect(r.media).toEqual({ video: null, audio: 'long-take.m4a' });
  });
});
