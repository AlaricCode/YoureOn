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
    expect(out.why).toBe('came_to_rest_outside');
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

describe('throwOutcome: a miss that was picked up afterwards', () => {
  it('bet 84514bea: landed beside the bin, lay there four frames, then picked up -> out', () => {
    // the ruling had been a retake: the track "ended away from the target"
    const out = throwOutcome({
      n: 12,
      target: target(12, [523, 786, 655, 1030]),
      object: frames(12, {
        0: still(12, 272, 562),
        1: still(12, 588, 503),
        4: [
          [1, 79, 456],
          [2, 326, 718],
          [3, 477, 949],
          [4, 503, 944],
          [5, 514, 952],
          [6, 511, 950],
        ],
      }),
    });
    expect(out.call).toBe('out');
    expect(out.why).toBe('came_to_rest_outside');
    expect(out.frames).toEqual([3, 4, 5, 6]);
    expect(out.last_seen).toBe(6);
  });

  it('bet dfe60bb3: missed, lay on the floor, then carried to the bin and dropped in -> out', () => {
    // the track's last sighting is at the mouth of the bin, in the thrower's hand
    const out = throwOutcome({
      n: 12,
      target: target(12, [524, 760, 670, 984]),
      object: frames(12, {
        0: still(12, 529, 322),
        4: [
          [2, 169, 486],
          [3, 489, 898],
          [4, 459, 979],
          [5, 443, 1006],
          [6, 444, 1005],
          [7, 440, 1002],
          [8, 440, 1000],
          [9, 429, 997],
          [10, 443, 846],
          [11, 601, 795],
        ],
      }),
    });
    expect(out.call).toBe('out');
    expect(out.why).toBe('came_to_rest_outside');
    expect(out.frames).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('held low and still BEFORE the throw, then thrown in: not a miss', () => {
    const BIN = [500, 700, 640, 920] as const;
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          // in a lowered hand, level with the bin's body, for four frames
          [0, 120, 800],
          [1, 122, 802],
          [2, 121, 801],
          [3, 123, 800],
          // the throw
          [4, 300, 520],
          [5, 565, 690],
        ],
      }),
    });
    expect(out.call).toBe('in');
  });

  it('two frames on the floor are not yet at rest', () => {
    const BIN = [500, 700, 640, 920] as const;
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [3, 100, 400],
          [4, 380, 880],
          [5, 385, 882],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
  });
});

describe('throwOutcome: off the picture', () => {
  const BIN = [500, 700, 640, 920] as const;
  const SIZE = { w: 720, h: 1280 };

  it('flying out past the side of the frame, never seen again -> out', () => {
    const out = throwOutcome({
      n: 12,
      size: SIZE,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [3, 200, 500],
          [4, 450, 520],
          [5, 690, 560],
        ],
      }),
    });
    expect(out.call).toBe('out');
    expect(out.why).toBe('left_the_picture');
  });

  it('rolling out through the bottom of the frame -> out', () => {
    const out = throwOutcome({
      n: 12,
      size: SIZE,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [3, 200, 500],
          [4, 300, 1000],
          [5, 330, 1250],
        ],
      }),
    });
    expect(out.call).toBe('out');
  });

  it('heading into the bin wins over heading off the picture', () => {
    // fast, toward a bin near the right edge: its line reaches the mouth first
    const out = throwOutcome({
      n: 12,
      size: SIZE,
      target: target(12, [560, 700, 700, 920]),
      object: frames(12, {
        0: [
          [3, 100, 300],
          [4, 380, 500],
        ],
      }),
    });
    expect(out.call).toBe('in');
  });

  it('lost in the middle of the picture is still unknown (the frames skipped it)', () => {
    const out = throwOutcome({
      n: 12,
      size: SIZE,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [1, 98, 283],
          [2, 65, 222],
          [3, 152, 263],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
  });

  it('a lob out through the top is not a miss yet; no frame size, no call', () => {
    const lob = [
      [3, 200, 300],
      [4, 300, 40],
    ] as const;
    expect(
      throwOutcome({ n: 12, size: SIZE, target: target(12, BIN), object: frames(12, { 0: lob }) })
        .call,
    ).toBe('unknown');
    const side = [
      [3, 200, 500],
      [4, 450, 520],
      [5, 690, 560],
    ] as const;
    expect(
      throwOutcome({ n: 12, target: target(12, BIN), object: frames(12, { 0: side }) }).call,
    ).toBe('unknown');
  });
});

describe('throwOutcome: lost in mid-flight', () => {
  it('a make (bet e9ec7f78): last seen 150 px short of the bin and above it, heading in -> in', () => {
    // the tracker had said unknown, and the vision judge then wrote that it flew "toward the
    // counter"; the thrower confirmed it went in
    const bin = [518, 747, 661, 966] as const;
    const out = throwOutcome({
      n: 12,
      target: target(12, bin),
      object: frames(12, {
        // on the counter the whole time
        0: still(12, 276, 556),
        1: still(12, 394, 556),
        // came into view at the edge when the camera shifted, and never moved
        3: Array.from({ length: 7 }, (_, k) => [5 + k, 86 - k, 576 - k] as const),
        4: [
          [5, 185, 481],
          [6, 230, 469],
          [7, 434, 601],
        ],
      }),
    });
    expect(out.call).toBe('in');
    expect(out.why).toBe('heading_into_the_mouth');
    expect(out.last_seen).toBe(7);
  });

  it('heading wide of the bin, or over it, is not a make', () => {
    const BIN = [500, 700, 640, 920] as const;
    // its line comes down well to the left of the opening
    const wide = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [5, 100, 400],
          [6, 180, 520],
        ],
      }),
    });
    expect(wide.call).toBe('unknown');
    // fast and flat over the top: it would not reach the rim line for many frames
    const over = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [5, 200, 300],
          [6, 420, 310],
        ],
      }),
    });
    expect(over.call).toBe('unknown');
    // rising, not falling
    const up = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [5, 300, 600],
          [6, 420, 480],
        ],
      }),
    });
    expect(up.call).toBe('unknown');
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

  it('a ball seen rolling to rest beside the bin: out', () => {
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [8, 250, 430],
          [9, 310, 540],
          [10, 330, 560],
          [11, 332, 561],
        ],
      }),
    });
    expect(out.call).toBe('out');
  });

  it('something small and white that only comes into view (the camera shifted) is not the ball', () => {
    // seen on a real throw: a bottle at the edge of the counter, from frame 5, never moving
    const out = throwOutcome({
      n: 12,
      target: target(12, BIN),
      object: frames(12, {
        0: [
          [5, 330, 560],
          [6, 331, 560],
          [7, 331, 561],
          [8, 332, 561],
          [9, 332, 561],
          [10, 332, 561],
          [11, 332, 561],
        ],
      }),
    });
    expect(out.call).toBe('unknown');
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

  it('one track at the mouth and one on the floor at the end: out', () => {
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
    // the ball lying outside at the end settles it
    expect(out.call).toBe('out');
  });
});
