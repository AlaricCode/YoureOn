// throwOutcome (src/checks/throw.ts) on tracks SAM 3.1 returned for real throws on the night of
// 2026-11-20 (prompts "bin" and "small white object"), and on the cases that must stay unknown.
import { describe, expect, it } from 'vitest';

import { throwOutcome } from '../../src/checks/throw';
import type { SamSegmentReply } from '../../src/checks/sam-reply';

type Frames = SamSegmentReply['results'][number]['frames'];
type Path = readonly (readonly [f: number, cx: number, cy: number])[];

/** `n` frames with one object per track id on the frames its path names (a box `r` px around). */
function frames(n: number, tracks: Record<number, Path>, r = 8, score = 0.75): Frames {
  return Array.from({ length: n }, (_, index) => ({
    index,
    objects: Object.entries(tracks).flatMap(([id, path]) =>
      path
        .filter(([f]) => f === index)
        .map(([, cx, cy]) => ({
          id: Number(id),
          score,
          box_xyxy: [cx - r, cy - r, cx + r, cy + r] as [number, number, number, number],
          box_all_xyxy: [cx - r, cy - r, cx + r, cy + r] as [number, number, number, number],
          components: 1,
          mask_area: 4 * r * r,
        })),
    ),
  }));
}

/** The target in the same place on every frame. */
const target = (n: number, box: readonly [number, number, number, number]): Frames =>
  Array.from({ length: n }, (_, index) => ({
    index,
    objects: [
      {
        id: 0,
        score: 0.95,
        box_xyxy: [...box] as [number, number, number, number],
        box_all_xyxy: [...box] as [number, number, number, number],
        components: 1,
        mask_area: 1000,
      },
    ],
  }));

const still = (n: number, cx: number, cy: number): Path =>
  Array.from({ length: n }, (_, f) => [f, cx, cy] as const);

describe('throwOutcome: real tracks', () => {
  it('a make (bet f2818e1e #3): from the hand to the rim, then gone -> in', () => {
    // the judge had voided this one: "I never see it land inside"
    const out = throwOutcome({
      n: 12,
      target: target(12, [129, 266, 199, 386]),
      object: frames(12, {
        // the paper towel roll on the counter, there the whole time
        0: still(12, 183, 164),
        1: [
          [1, 72, 156],
          [2, 78, 196],
          [3, 93, 184],
          [4, 119, 115],
          [5, 143, 165],
          [6, 165, 264],
        ],
      }),
    });
    expect(out.call).toBe('in');
    expect(out.why).toBe('gone_at_the_mouth');
    expect(out.last_seen).toBe(6);
    expect(out.frames).toEqual([5, 6]);
  });

  it('a miss (bet de97651e #3): off the rim, onto the floor, still there at the end -> out', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, [261, 439, 328, 555]),
      object: frames(12, {
        0: still(12, 247, 338),
        1: still(12, 168, 333),
        2: [
          [5, 273, 397],
          [6, 335, 459],
          [7, 355, 473],
          [8, 375, 518],
          [9, 380, 561],
          [10, 395, 565],
          [11, 407, 566],
        ],
      }),
    });
    expect(out.call).toBe('out');
    expect(out.why).toBe('rests_outside');
    expect(out.frames).toEqual([9, 10, 11]);
  });

  it('a throw the frames lost sight of (bet de97651e #2): last seen far from the bin -> unknown', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, [246, 457, 353, 656]),
      object: frames(12, {
        0: [
          [1, 98, 283],
          [2, 65, 222],
          [3, 152, 263],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
    expect(out.why).toBe('lost_away_from_target');
    expect(out.last_seen).toBe(3);
  });
});

describe('throwOutcome: what must stay unknown', () => {
  const BIN = [200, 400, 280, 520] as const;

  it('nothing found, no target, or too few frames', () => {
    expect(throwOutcome({ n: 12, target: target(12, BIN), object: frames(12, {}) }).why).toBe(
      'object_never_seen',
    );
    expect(
      throwOutcome({ n: 12, target: frames(12, {}), object: frames(12, { 0: [[3, 10, 10]] }) }).why,
    ).toBe('no_target');
    expect(throwOutcome({ n: 2, target: target(2, BIN), object: frames(2, {}) }).why).toBe(
      'too_few_frames',
    );
  });

  it('only things that never move (the room) -> unknown', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, { 0: still(12, 90, 200), 1: still(12, 350, 610) }),
    });
    expect(out.call).toBe('unknown');
  });

  it('the ball still in the hand at the end (no throw in the clip): not a miss', () => {
    // waved about, above the rim line the whole time, in view on the last frame
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: Array.from({ length: 12 }, (_, f) => [f, 90 + 8 * f, 250 + (f % 2) * 20] as const),
      }),
    });
    expect(out.call).toBe('unknown');
    expect(out.why).toBe('still_in_view');
  });

  it('the clip ends with the ball in the air above the bin: not a make yet', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [8, 100, 200],
          [9, 150, 180],
          [10, 200, 250],
          [11, 235, 330],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
  });

  it('gone on the very last frame only: one frame is not enough to call it in', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [8, 100, 200],
          [9, 180, 250],
          [10, 238, 398],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
  });

  it('a ball that rises past the mouth and is lost is not a make', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [3, 100, 300],
          [4, 180, 380],
          [5, 240, 330],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
  });

  it('an object SAM tracks but no longer sees (score -10000) is not a detection', () => {
    const lost = frames(12, { 0: still(12, 400, 600) }, 8, -10000);
    expect(throwOutcome({ n: 12, target: target(12, BIN), object: lost }).why).toBe(
      'object_never_seen',
    );
  });
});

describe('throwOutcome: synthetic makes and misses', () => {
  const BIN = [200, 400, 280, 520] as const;

  it('a ball that lands late and lies beside the bin: out, even if it barely moved in view', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [9, 330, 560],
          [10, 332, 561],
          [11, 332, 561],
        ],
      }),
    });
    expect(out.call).toBe('out');
  });

  it('dropping past the rim into the opening, then gone: in', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [4, 60, 260],
          [5, 130, 200],
          [6, 200, 290],
          [7, 238, 420],
        ],
      }),
    });
    expect(out.call).toBe('in');
  });

  it('one track into the bin and one on the floor: the tracks disagree', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [4, 60, 260],
          [5, 130, 200],
          [6, 238, 395],
        ],
        1: [
          [8, 320, 500],
          [9, 340, 560],
          [10, 345, 562],
          [11, 345, 562],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
    expect(out.why).toBe('tracks_disagree');
  });
});
