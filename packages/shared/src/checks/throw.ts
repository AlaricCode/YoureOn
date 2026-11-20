// A throw at a target, decided from SAM 3.1's tracks (services/sam3: one result per text prompt,
// each object with an id it keeps from frame to frame). Pure TS: the server calls it with the
// reply of the attempt's SAM call, and it runs in node tests on replies captured from real throws.
//
// The camera checks' evaluator (./evaluate) reads the same reply one frame at a time and can only
// refuse a verdict. It never used the ids, so it could not tell the thrown ball from the paper
// towel roll on the counter, and with a prompt SAM cannot find ("paper ball") it saw nothing at
// all. Followed as a track, the ball is unmistakable: it is the small object that MOVES. Where
// that track ends is the result:
//
//   out      the ball is still in the picture at the end of the clip, outside the target and
//            below its rim (on the floor): it missed, or bounced out and stayed out.
//   in       the ball moved, was last seen at the target's mouth (over the opening, at or above
//            the rim), and is in none of the frames after that: it went in.
//   unknown  anything else: no moving track, a track that ends in the air away from the target
//            (the frames skipped the rest of the flight, or it left the picture), two tracks that
//            disagree, or no target. The judge's own reading of the frames then stands.
//
// Thresholds are in units of the target's own width and height, so they hold at any frame size
// and camera distance.
import type { SamSegmentReply } from './sam-reply';

type PromptFrames = SamSegmentReply['results'][number]['frames'];
type Box = readonly [number, number, number, number];

export const THROW = {
  /** A detection counts from this score (SAM reports -10000 for an object it no longer sees). */
  MIN_SCORE: 0.3,
  /** The target is the best box at or above this score. */
  TARGET_MIN_SCORE: 0.5,
  /** A track moved if its centre covered at least this many target widths. */
  MOVED: 0.6,
  /** A track that was not there in the first frames arrived (it is not part of the room). */
  ARRIVED_AFTER: 2,
  /** out: seen in the last frame and in at least this many of the last three. */
  END_SEEN: 2,
  /** out: its box is clear of the target's by this many target widths… */
  OUT_GAP: 0.12,
  /** …and its centre is below the rim by this many target heights (on the floor, not in a hand). */
  OUT_BELOW_RIM: 0.15,
  /** in: gone from at least this many frames at the end. */
  GONE_FRAMES: 2,
  /** in: last seen within this many target widths of the target's centre line… */
  MOUTH_X: 0.75,
  /** …no higher above the rim than this many target heights… */
  MOUTH_ABOVE: 1.25,
  /** …and no lower below it than this many (a ball dropping past the rim into the opening). */
  MOUTH_BELOW: 0.4,
} as const;

export type ThrowCall = 'in' | 'out' | 'unknown';

export interface ThrowOutcome {
  call: ThrowCall;
  /** Why, for the log and the tests: one of the rule names above or what was missing. */
  why: string;
  /** The frames that show it (the track's last frames), for the ruling's cited frames. */
  frames: number[];
  /** The last frame the object was seen on (null: never). */
  last_seen: number | null;
}

interface Point {
  f: number;
  box: Box;
  cx: number;
  cy: number;
}

const usable = (o: {
  score: number;
  box_xyxy: Box | null;
}): o is { score: number; box_xyxy: Box } => o.box_xyxy !== null && o.score >= THROW.MIN_SCORE;

/** The target's box on each frame (the best-scoring object), carried over frames it is missing on. */
function targetBoxes(frames: PromptFrames, n: number): (Box | null)[] {
  const seen: (Box | null)[] = Array.from({ length: n }, () => null);
  for (const f of frames) {
    let best: { score: number; box: Box } | null = null;
    for (const o of f.objects) {
      if (o.box_xyxy === null || o.score < THROW.TARGET_MIN_SCORE) continue;
      if (!best || o.score > best.score) best = { score: o.score, box: o.box_xyxy };
    }
    if (f.index < n) seen[f.index] = best?.box ?? null;
  }
  // nearest earlier box, else nearest later one (the camera is held still enough for that)
  const out = [...seen];
  let prev: Box | null = null;
  for (let i = 0; i < n; i++) {
    if (out[i]) prev = out[i] as Box;
    else out[i] = prev;
  }
  let next: Box | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if (seen[i]) next = seen[i] as Box;
    else if (!out[i]) out[i] = next;
  }
  return out;
}

function tracksOf(frames: PromptFrames): Point[][] {
  const byId = new Map<number, Point[]>();
  for (const f of [...frames].sort((a, b) => a.index - b.index)) {
    for (const o of f.objects) {
      if (!usable(o)) continue;
      const b = o.box_xyxy;
      const list = byId.get(o.id) ?? [];
      // one detection per id per frame (the service never sends two; be safe)
      if (list.at(-1)?.f === f.index) continue;
      list.push({ f: f.index, box: b, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2 });
      byId.set(o.id, list);
    }
  }
  return [...byId.values()];
}

const extent = (pts: readonly Point[]): number => {
  const xs = pts.map((p) => p.cx);
  const ys = pts.map((p) => p.cy);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

/** The gap between two boxes (0 when they touch or overlap). */
const gap = (a: Box, b: Box): number =>
  Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));

/**
 * `target` and `object` are the two prompts' results over the same `n` frames (frame index 0 is
 * the first frame sent).
 */
export function throwOutcome(i: {
  target: PromptFrames;
  object: PromptFrames;
  n: number;
}): ThrowOutcome {
  const none = (why: string, last_seen: number | null = null): ThrowOutcome => ({
    call: 'unknown',
    why,
    frames: [],
    last_seen,
  });
  const n = i.n;
  if (n < 3) return none('too_few_frames');
  const bins = targetBoxes(i.target, n);
  if (!bins[n - 1]) return none('no_target');
  const tracks = tracksOf(i.object);
  if (tracks.length === 0) return none('object_never_seen');

  const verdicts: ThrowOutcome[] = [];
  let lastSeen: number | null = null;
  for (const pts of tracks) {
    const first = pts[0] as Point;
    const last = pts.at(-1) as Point;
    lastSeen = Math.max(lastSeen ?? -1, last.f);
    const bin = bins[last.f] as Box;
    const bw = bin[2] - bin[0];
    const bh = bin[3] - bin[1];
    if (bw <= 0 || bh <= 0) continue;
    const moved = extent(pts) >= THROW.MOVED * bw;
    const arrived = first.f >= THROW.ARRIVED_AFTER;
    // Part of the room: there from the start and never moved (a roll of paper towel, a mug).
    if (!moved && !arrived) continue;

    const end = pts.filter((p) => p.f >= n - 3);
    if (last.f === n - 1 && end.length >= THROW.END_SEEN) {
      const onFloor = end.every((p) => {
        const b = bins[p.f] as Box;
        const h = b[3] - b[1];
        const w = b[2] - b[0];
        return gap(p.box, b) >= THROW.OUT_GAP * w && p.cy >= b[1] + THROW.OUT_BELOW_RIM * h;
      });
      if (onFloor) {
        verdicts.push({
          call: 'out',
          why: 'rests_outside',
          frames: end.map((p) => p.f),
          last_seen: last.f,
        });
        continue;
      }
      // still in the picture at the end but not on the floor: in a hand, or in the air
      verdicts.push(none('still_in_view', last.f));
      continue;
    }

    if (moved && last.f <= n - 1 - THROW.GONE_FRAMES) {
      const binCx = (bin[0] + bin[2]) / 2;
      const atMouth =
        Math.abs(last.cx - binCx) <= THROW.MOUTH_X * bw &&
        last.cy >= bin[1] - THROW.MOUTH_ABOVE * bh &&
        last.cy <= bin[1] + THROW.MOUTH_BELOW * bh;
      // it was coming down toward the opening, not rising past it
      const prev = pts.at(-2);
      const falling = !prev || last.cy >= prev.cy;
      if (atMouth && falling) {
        verdicts.push({
          call: 'in',
          why: 'gone_at_the_mouth',
          frames: pts.slice(-2).map((p) => p.f),
          last_seen: last.f,
        });
        continue;
      }
      verdicts.push(none('lost_away_from_target', last.f));
      continue;
    }
    verdicts.push(none('track_too_short', last.f));
  }

  const ins = verdicts.filter((v) => v.call === 'in');
  const outs = verdicts.filter((v) => v.call === 'out');
  if (ins.length > 0 && outs.length > 0) return none('tracks_disagree', lastSeen);
  if (outs.length > 0) return outs[0] as ThrowOutcome;
  if (ins.length === 1) return ins[0] as ThrowOutcome;
  if (ins.length > 1) return none('two_objects_went_in', lastSeen);
  const why = verdicts.find((v) => v.why !== 'track_too_short')?.why ?? verdicts[0]?.why;
  return none(why ?? 'no_moving_object', lastSeen);
}
