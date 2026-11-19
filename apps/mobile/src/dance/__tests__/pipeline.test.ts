// The live round pipeline: tracker → live scorer → the PoseSeries that gets hashed (DANCE-OFF
// §3, §4.6), the clock switch at t0, the fps cap, the self test and the sync sweep.
import { PoseSeries } from '@youre-on/shared/dance/pose';
import { scoreRound } from '@youre-on/shared/dance/score';
import { hipCenter, seriesChecks } from '@youre-on/shared/dance/track';
import { describe, expect, it } from 'vitest';

import {
  bestSyncOffset,
  createRoundPipeline,
  minFrameGapMs,
  replayInputs,
  selfTestSeries,
  sweepSyncOffsets,
  type PipelineFrame,
} from '../model/pipeline';
import { frame, leftDancer, place, rightStill, WAVE_POP } from './helpers';
import { referencePoseAt } from '../model/reference';

/** Session clock: framing/count-in from ts 5000, startRound at 6500, t0 = ts 6520. */
const T0_TS = 6_520;

function dance(lagMs = 0) {
  const p = createRoundPipeline({ routine: WAVE_POP, syncOffsetMs: 0 });
  const outs: PipelineFrame[] = [];
  const both = (t: number) => [leftDancer(WAVE_POP, t - lagMs), rightStill(WAVE_POP)];
  for (let ts = 5_000; ts < 6_500; ts += 33) outs.push(p.push(frame(ts, ts, both(0))));
  p.beginRound();
  // A frame captured before t0 but delivered after the call: still on the session clock.
  outs.push(p.push(frame(6_510, 6_510, both(0))));
  const startedEarly = p.roundStarted();
  for (let t = 0; t <= 15_600; t += 33) outs.push(p.push(frame(t, T0_TS + t, both(t))));
  return { p, outs, startedEarly };
}

describe('round pipeline', () => {
  const { p, outs, startedEarly } = dance();
  const series = p.series();

  it('waits for the round clock, then records count-in frames at negative t', () => {
    expect(startedEarly).toBe(false);
    expect(p.roundStarted()).toBe(true);
    const first = series.frames[0]!;
    expect(first.t).toBe(5_000 - T0_TS);
    const pre = series.frames.filter((f) => f.t < 0);
    // 5000..6485 every 33 ms (46 frames) plus the late one at 6510.
    expect(pre).toHaveLength(47);
    expect(pre.at(-1)!.t).toBe(6_510 - T0_TS);
    expect(series.frames.some((f) => f.t >= 0)).toBe(true);
  });

  it('is a valid PoseSeries: times never decrease, within the caps', () => {
    expect(PoseSeries.safeParse(series).success).toBe(true);
    for (let i = 1; i < series.frames.length; i++)
      expect(series.frames[i]!.t).toBeGreaterThanOrEqual(series.frames[i - 1]!.t);
    expect(series.w).toBe(720);
    expect(series.h).toBe(1280);
    expect(series.fps_cap).toBe(30);
    expect(series.sync_offset_ms).toBe(0);
  });

  it('keeps the fps cap (frames closer than the gap are dropped from the series)', () => {
    const gap = minFrameGapMs(30);
    for (let i = 1; i < series.frames.length; i++)
      expect(series.frames[i]!.t - series.frames[i - 1]!.t).toBeGreaterThanOrEqual(gap);
    // t0 came 10 ms after the late count-in frame, so the t = 0 frame was dropped.
    expect(series.frames.find((f) => f.t === 0)).toBeUndefined();
  });

  it('A is the left dancer, B the right one, on every frame', () => {
    for (const f of series.frames) {
      expect(f.a).not.toBeNull();
      expect(f.b).not.toBeNull();
      expect(f.n).toBe(2);
      expect(f.a![0]!).toBeLessThan(f.b![0]!);
    }
    expect(p.tracking()?.max_people).toBe(2);
    expect(p.tracking()?.side_swaps).toBe(0);
  });

  it('hands back the same arrays it was given (the overlay tells A / B by identity)', () => {
    const k = leftDancer(WAVE_POP, 0);
    const q = createRoundPipeline({ routine: WAVE_POP, syncOffsetMs: 0 });
    const out = q.push(frame(0, 0, [k, rightStill(WAVE_POP)]));
    expect(out.a).toBe(k);
    expect(out.accepted).toBe(false);
  });

  it('pops every key move once per player, in order', () => {
    const events = outs.flatMap((o) => o.updates.flatMap((u) => u.events));
    const a = events.filter((e) => e.player === 'A');
    const b = events.filter((e) => e.player === 'B');
    expect(a.map((e) => e.key_move_id)).toEqual(WAVE_POP.key_moves.map((m) => m.id));
    expect(b.map((e) => e.key_move_id)).toEqual(WAVE_POP.key_moves.map((m) => m.id));
    expect(a.filter((e) => e.grade === 'PERFECT').length).toBeGreaterThan(8);
  });

  it('final(): the dancer beats the one standing still, the same as the server would score', () => {
    const { series: s, result } = p.final();
    expect(result.winner).toBe('A');
    expect(result.failed).toBeNull();
    expect(result.a.score_x10).toBeGreaterThanOrEqual(900);
    expect(result.b.score_x10).toBeLessThan(200);
    expect(scoreRound(WAVE_POP, s)).toEqual(result);
  });

  it('with no `ts` (an old payload) every frame after startRound is a round frame', () => {
    const q = createRoundPipeline({ routine: WAVE_POP, syncOffsetMs: 40 });
    const people = [leftDancer(WAVE_POP, 0), rightStill(WAVE_POP)];
    q.push({ t: 9_000, w: 720, h: 1280, fps: 30, people: people.map((k) => ({ k })) });
    q.beginRound();
    const out = q.push({ t: 0, w: 720, h: 1280, fps: 30, people: people.map((k) => ({ k })) });
    expect(out.accepted).toBe(true);
    expect(q.series().frames.map((f) => f.t)).toEqual([0]);
    expect(q.series().sync_offset_ms).toBe(40);
  });

  it('an empty round still scores (as failed: no frames)', () => {
    const q = createRoundPipeline({ routine: WAVE_POP, syncOffsetMs: 0 });
    const { series: s, result } = q.final();
    expect(s.frames).toEqual([]);
    expect(result.failed).toBe('no_frames');
    expect(result.winner).toBeNull();
  });

  it('replayInputs dequantizes a series back into live-scorer frames', () => {
    const inputs = replayInputs(series);
    expect(inputs).toHaveLength(series.frames.length);
    expect(inputs[0]!.t).toBe(series.frames[0]!.t);
    expect(inputs[0]!.a![0]).toBeCloseTo(series.frames[0]!.a![0]! / 10_000, 6);
    expect(inputs[0]!.w).toBe(720);
  });
});

describe('a long count-in (a bet round counts in from go_at)', () => {
  // The pipeline starts 4.5 s before t0 (GO_DELAY_MS + 3 beats), and the series keeps t ≥ −3000.
  // The two players swap places between ts 500 and 1100, before the series window opens, then
  // stand still; t0 is ts 4500.
  const T0 = 4_500;
  const pose = referencePoseAt(WAVE_POP, 0);
  const x = (from: number, ts: number) => {
    const u = Math.min(1, Math.max(0, (ts - 500) / 600));
    return from + (-from - from) * u;
  };
  /** P starts on the left, Q on the right. */
  const people = (ts: number) => [place(pose, 0.5, x(-0.22, ts)), place(pose, 0.5, x(0.22, ts))];
  const run = (start: { a: [number, number]; b: [number, number] } | null) => {
    const p = createRoundPipeline({ routine: WAVE_POP, syncOffsetMs: 0, start });
    const firstA: (number[] | null)[] = [];
    for (let ts = 0; ts < T0; ts += 33) firstA.push(p.push(frame(ts, ts, people(ts))).a);
    p.beginRound();
    for (let t = 0; t <= 2_000; t += 33) p.push(frame(t, T0 + t, people(T0 + t)));
    return { p, series: p.series(), firstA };
  };

  it('left / right: A is the one on the left when the series opens; phone and server agree', () => {
    const { p, series, firstA } = run(null);
    // The count-in preview called P (left at ts 0) A.
    expect(hipCenter(firstA[0]!)![0]).toBeLessThan(0.5);
    expect(series.frames[0]!.t).toBeGreaterThanOrEqual(-3_000);
    // The series: A = whoever is on the left there (Q), no swap, on both sides.
    const s = seriesChecks(PoseSeries.parse(series));
    expect(s).toMatchObject({ side_swaps: 0, a_start: 'left' });
    expect(p.tracking()?.side_swaps).toBe(0);
    for (const f of series.frames) expect(f.a![0]!).toBeLessThan(f.b![0]!);
  });

  it('face-identified: the round tracker follows the identified players through the swap', () => {
    // P was identified as A at the count-in, standing on the left.
    const start = { a: [0.28, 0.5] as [number, number], b: [0.72, 0.5] as [number, number] };
    const { p, series } = run(start);
    // P ends up on the right: A starts the series on the right, and that is no swap (byFace).
    expect(seriesChecks(PoseSeries.parse(series), { byFace: true })).toMatchObject({
      side_swaps: 0,
      a_start: 'right',
    });
    expect(p.tracking()?.side_swaps).toBe(0);
    for (const f of series.frames) expect(f.a![0]!).toBeGreaterThan(f.b![0]!);
  });
});

describe('self test', () => {
  it('the reference against itself is 100.0 for both, under identity', () => {
    const s = selfTestSeries(WAVE_POP);
    expect(PoseSeries.safeParse(s).success).toBe(true);
    const r = scoreRound(WAVE_POP, s);
    expect(r.a.score_x10).toBe(1_000);
    expect(r.b.score_x10).toBe(1_000);
    expect(r.a.convention).toBe('identity');
    expect(r.too_close).toBe(true);
    expect(r.winner).toBeNull();
  });
});

describe('sync sweep', () => {
  it('a late dancer scores better with a positive offset than a negative one', () => {
    const { p: late } = dance(200);
    const rows = sweepSyncOffsets(WAVE_POP, late.series());
    const at = (o: number) => rows.find((r) => r.offsetMs === o)!;
    expect(at(200).a).toBeGreaterThan(at(-200).a);
    expect(at(200).a).toBeGreaterThanOrEqual(at(0).a);
    expect(bestSyncOffset(rows)).not.toBeNull();
    expect(bestSyncOffset(rows)!).toBeGreaterThanOrEqual(0);
  });

  it('picks the best combined score, the smallest offset on a tie', () => {
    expect(
      bestSyncOffset([
        { offsetMs: -50, a: 500, b: 500 },
        { offsetMs: 0, a: 500, b: 500 },
        { offsetMs: 100, a: 600, b: 500 },
        { offsetMs: 50, a: 550, b: 550 },
      ]),
    ).toBe(50);
    expect(bestSyncOffset([])).toBeNull();
  });
});
