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
//   out      the ball came to rest outside the target, below its rim (on the floor): it missed,
//            or bounced out and stayed out. Still there at the end of the clip, or lying there
//            for several frames before someone picked it up: the throw had already missed.
//   in       the ball moved, was last seen at the target's mouth (over the opening, at or above
//            the rim), and is in none of the frames after that: it went in.
//            Or it left the picture (off a side or the bottom): wherever it went, it is not in
//            the target.
//   unknown  anything else: no moving track, a track that ends in the air away from the target
//            with the picture still around it (the frames skipped the rest of the flight), or
//            no target. That is a retake: nobody guesses.
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
  /**
   * Or it is this far below the rim, whatever the gap: a ball seen level with the target's body
   * is outside it (nothing inside shows through the wall), even touching it in the picture.
   */
  OUT_BESIDE_BODY: 0.35,
  /** out, mid-clip: it lay still for at least this many frames in a row… */
  REST_FRAMES: 3,
  /** …moving no more than this many target widths from one to the next. */
  REST_STEP: 0.35,
  /** in: gone from at least this many frames at the end. */
  GONE_FRAMES: 2,
  /** in: last seen within this many target widths of the target's centre line… */
  MOUTH_X: 0.75,
  /** …no higher above the rim than this many target heights… */
  MOUTH_ABOVE: 1.25,
  /** …and no lower below it than this many (a ball dropping past the rim into the opening). */
  MOUTH_BELOW: 0.3,
  /**
   * in, when it was lost in mid-flight: its line of travel reaches the rim within this many
   * frames' worth of the travel it had just made…
   */
  HEADING_FRAMES: 2,
  /** …inside the opening, widened by this many target widths each side. */
  HEADING_X: 0.25,
  /** out, off the picture: last seen within this share of the frame from a side or the bottom… */
  EDGE: 0.04,
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

/** The frames' size, from any mask the reply carries (COCO RLE size is [h, w]). */
function frameSize(frames: PromptFrames): { w: number; h: number } | null {
  for (const f of frames) {
    for (const o of f.objects) {
      if (o.mask_rle) return { w: o.mask_rle.size[1], h: o.mask_rle.size[0] };
    }
  }
  return null;
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
  /** The frames' size in px. Read from the masks when not given; without either, a ball that
   *  left the picture cannot be told from one the frames skipped (unknown). */
  size?: { w: number; h: number } | undefined;
}): ThrowOutcome {
  const none = (why: string, last_seen: number | null = null): ThrowOutcome => ({
    call: 'unknown',
    why,
    frames: [],
    last_seen,
  });
  const n = i.n;
  if (n < 3) return none('too_few_frames');
  const size = i.size ?? frameSize(i.target) ?? frameSize(i.object);
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
    // Measured against the target, not the picture: when the camera pans, everything in the
    // room slides across the frame together (seen on a real throw: the bin's box moved 90 px,
    // and so did the bottles on the counter, which then looked like moving objects). Only the
    // ball changes its place relative to the bin.
    const rel = pts.map((q) => {
      const b = bins[q.f] as Box;
      return { ...q, cx: q.cx - b[0], cy: q.cy - b[1] };
    });
    const moved = extent(rel) >= THROW.MOVED * bw;
    const arrived = first.f >= THROW.ARRIVED_AFTER;
    // Part of the room: there from the start and never moved (a roll of paper towel, a mug).
    if (!moved && !arrived) continue;

    /** Outside the target and down on the floor (not in a hand, not at the opening). */
    const outside = (p: Point): boolean => {
      const b = bins[p.f] as Box;
      const h = b[3] - b[1];
      const w = b[2] - b[0];
      if (p.cy < b[1] + THROW.OUT_BELOW_RIM * h) return false;
      return gap(p.box, b) >= THROW.OUT_GAP * w || p.cy >= b[1] + THROW.OUT_BESIDE_BODY * h;
    };

    // It came to rest outside the target: a miss, whatever happens to it afterwards. Seen on
    // two real throws: the ball landed beside the bin, lay there for four to six frames, and
    // the thrower then walked over, picked it up and dropped it in. The track ends in a hand
    // or at the mouth, but the throw had already missed. Only after the flight (its biggest
    // step): a ball held low and still before the throw is not at rest on the floor.
    if (moved && pts.length > THROW.REST_FRAMES) {
      let run: Point[] = [];
      let rest: Point[] = [];
      // The rest must be somewhere it TRAVELLED to (it landed there): a ball held low and still
      // before the throw has no travel behind it. What it does after the rest does not matter
      // (on a real throw the pick-up was a bigger movement than the throw had been).
      const travelledTo = (k: number): boolean => {
        const here = rel[k] as Point;
        for (let m = 0; m < k; m++) {
          const then = rel[m] as Point;
          if (Math.hypot(here.cx - then.cx, here.cy - then.cy) >= THROW.MOVED * bw) return true;
        }
        return false;
      };
      for (let k = 1; k < pts.length; k++) {
        const q = pts[k] as Point;
        const r = rel[k] as Point;
        const prevK = run.length ? k - 1 : -1;
        const prevPt = run.at(-1);
        const prevRel = prevK >= 0 ? (rel[prevK] as Point) : undefined;
        const still =
          prevPt !== undefined &&
          prevRel !== undefined &&
          q.f === prevPt.f + 1 &&
          Math.hypot(r.cx - prevRel.cx, r.cy - prevRel.cy) <= THROW.REST_STEP * bw;
        if (!outside(q)) run = [];
        else if (still) run.push(q);
        else run = travelledTo(k) ? [q] : [];
        if (run.length > rest.length) rest = [...run];
      }
      if (rest.length >= THROW.REST_FRAMES) {
        verdicts.push({
          call: 'out',
          why: 'came_to_rest_outside',
          frames: rest.map((q) => q.f),
          last_seen: (rest.at(-1) as Point).f,
        });
        continue;
      }
    }

    const end = pts.filter((p) => p.f >= n - 3);
    if (last.f === n - 1 && end.length >= THROW.END_SEEN) {
      // Only a track that MOVED can be the ball on the floor: something small and white that
      // came into the picture when the camera shifted (seen on a real throw: a bottle at the
      // edge of the counter, from frame 5) arrived too, and never went anywhere.
      const onFloor = moved && end.every(outside);
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
      // Lost in mid-flight (the frames are up to a third of a second apart, and a thrown ball
      // covers a body length in that time): where was it heading? Seen on a real make: last
      // sighted 150 px short of the bin and above it, in no frame after. If the line from its
      // last two sightings comes down through the opening within the next frame or two, and it
      // is nowhere afterwards, it went in. (A ball that hits the rim and stays out is in view at
      // the end, and that track says `out`.)
      if (prev && prev.f < last.f) {
        const df = last.f - prev.f;
        const vx = (last.cx - prev.cx) / df;
        const vy = (last.cy - prev.cy) / df;
        const frames = vy > 0 ? (bin[1] - last.cy) / vy : Number.NaN;
        const xAtRim = last.cx + vx * frames;
        if (
          frames > 0 &&
          frames <= THROW.HEADING_FRAMES &&
          xAtRim >= bin[0] - THROW.HEADING_X * bw &&
          xAtRim <= bin[2] + THROW.HEADING_X * bw
        ) {
          verdicts.push({
            call: 'in',
            why: 'heading_into_the_mouth',
            frames: pts.slice(-2).map((p) => p.f),
            last_seen: last.f,
          });
          continue;
        }
      }
      // It left the picture: wherever it went, it is not in the target. Last seen at a side or
      // the bottom edge, or on a line that carries it out of the frame before the next one.
      // (Out through the top is not counted: a lob comes back down.)
      if (size && prev && prev.f < last.f) {
        const df = last.f - prev.f;
        const nx = last.cx + (last.cx - prev.cx) / df;
        const ny = last.cy + (last.cy - prev.cy) / df;
        const mx = THROW.EDGE * size.w;
        const my = THROW.EDGE * size.h;
        const atEdge = last.cx <= mx || last.cx >= size.w - mx || last.cy >= size.h - my;
        const leaving = nx < 0 || nx > size.w || ny > size.h;
        const outward =
          (last.cx <= mx && nx < last.cx) ||
          (last.cx >= size.w - mx && nx > last.cx) ||
          (last.cy >= size.h - my && ny > last.cy);
        if (leaving || (atEdge && outward)) {
          verdicts.push({
            call: 'out',
            why: 'left_the_picture',
            frames: pts.slice(-2).map((q) => q.f),
            last_seen: last.f,
          });
          continue;
        }
      }
      verdicts.push(none('lost_away_from_target', last.f));
      continue;
    }
    verdicts.push(none('track_too_short', last.f));
  }

  const ins = verdicts.filter((v) => v.call === 'in');
  const outs = verdicts.filter((v) => v.call === 'out');
  // A ball lying outside the target at the end settles it, whatever another track suggested.
  if (outs.length > 0) return outs[0] as ThrowOutcome;
  if (ins.length === 1) return ins[0] as ThrowOutcome;
  if (ins.length > 1) return none('two_objects_went_in', lastSeen);
  const why = verdicts.find((v) => v.why !== 'track_too_short')?.why ?? verdicts[0]?.why;
  return none(why ?? 'no_moving_object', lastSeen);
}
