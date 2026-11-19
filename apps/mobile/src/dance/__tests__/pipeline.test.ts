// The live round pipeline: tracker → live scorer → the PoseSeries that gets hashed (DANCE-OFF
// §3, §4.6), the clock switch at t0, the fps cap, the self test and the sync sweep.
import { PoseSeries } from '@youre-on/shared/dance/pose';
import { scoreRound } from '@youre-on/shared/dance/score';
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
import { frame, leftDancer, rightStill, WAVE_POP } from './helpers';

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
