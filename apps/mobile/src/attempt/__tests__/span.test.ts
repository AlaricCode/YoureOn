import { describe, expect, it } from 'vitest';

import { frameTimesMs } from '../frames';
import { recordedSpan } from '../span';

const MAX = 6000;

describe('recordedSpan: the real recording span, not the wall clock around recordAsync', () => {
  // A 3.0 s clip: recordAsync at 0, the camera writes from 150 ms (the first progress event,
  // 100 ms of media, comes in at 250), Stop at 3150, the file is finalized at 3400.
  const marks = {
    requestedAtMs: 0,
    firstProgress: { atMs: 250, durationS: 0.1 },
    stopAtMs: 3150,
    finishedAtMs: 3400,
    maxMs: MAX,
  };

  it('leaves out the start delay and the finalize wait', () => {
    expect(recordedSpan(marks)).toEqual({ durationMs: 3000, endedAtMs: 3150 });
  });

  it('an overstated length samples past the end of the clip; the real span does not', () => {
    const realMs = 3000;
    const wallClock = marks.finishedAtMs - marks.requestedAtMs; // what PlayScreens used to send
    expect(wallClock).toBe(3400);
    const past = frameTimesMs(wallClock).filter((t) => t >= realMs);
    expect(past.length).toBeGreaterThanOrEqual(3); // copies of the last frame, as "landing" frames
    const { durationMs } = recordedSpan(marks);
    expect(frameTimesMs(durationMs).every((t) => t < realMs)).toBe(true);
    // the landing window still ends at the real end (the last frame 80 ms before it)
    expect(frameTimesMs(durationMs).at(-1)).toBe(realMs - 80);
  });

  it('no progress event came in: the span starts at the recordAsync call', () => {
    expect(recordedSpan({ ...marks, firstProgress: null }).durationMs).toBe(3150);
    expect(recordedSpan({ ...marks, firstProgress: undefined }).durationMs).toBe(3150);
  });

  it('a progress mark that would start before the call is ignored (start = the call)', () => {
    expect(recordedSpan({ ...marks, firstProgress: { atMs: 50, durationS: 0.4 } }).durationMs).toBe(
      3150,
    );
    expect(
      recordedSpan({ ...marks, firstProgress: { atMs: 250, durationS: Number.NaN } }).durationMs,
    ).toBe(3150);
  });

  it('the camera ended the clip itself (maxDuration): never longer than the ceiling', () => {
    // recordAsync resolved at 6400 (6 s of media + finalize); the JS timer fired later.
    const r = recordedSpan({ ...marks, stopAtMs: 6500, finishedAtMs: 6400 });
    expect(r.durationMs).toBe(MAX);
    expect(r.endedAtMs).toBe(150 + MAX);
  });

  it('a finish mark after Stop (the normal case) does not lengthen the clip', () => {
    expect(recordedSpan({ ...marks, finishedAtMs: 9999 }).durationMs).toBe(3000);
    expect(recordedSpan({ ...marks, finishedAtMs: null }).durationMs).toBe(3000);
  });

  it('at least 1 ms', () => {
    expect(recordedSpan({ ...marks, stopAtMs: 100 }).durationMs).toBe(1);
  });
});
