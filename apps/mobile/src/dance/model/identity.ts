// Who is who before the round starts (DANCE-OFF §3), pure. The face assignment answers about the
// people of ONE frame (the still's); the round's tracker starts at the count-in, seconds later.
// This bridges the two: it keeps the last few seconds of framing frames, and once identify()
// names A and B in the still's frame it follows them from that frame on with the shared tracker
// (seeded with where each stood), so at the count-in `start()` says where A and B stand NOW,
// even if they moved (or crossed) in between. The round pipeline seeds its own tracker with that.
//
// Lost: when the follow loses either player for longer than LOST_MS, the identity is dropped
// (the left / right rule again, and the phone may try the faces once more).
import {
  createTracker,
  hipCenter,
  type Tracker,
  type TrackerStart,
} from '@youre-on/shared/dance/track';

export const IDENTITY = {
  /** Framing frames kept for the replay from the still's frame. */
  RING_MS: 4_000,
  /** The still's frame must be within this of a kept frame's ts. */
  MATCH_TS_MS: 80,
  /** A player the follow has not seen for this long: the identity is dropped. */
  LOST_MS: 1_500,
} as const;

export interface IdentityFrame {
  /** Session ms (onPoses `ts`, else `t`). */
  ts: number;
  people: readonly (readonly number[])[];
}

export interface PlayerIdentity {
  /**
   * A framing frame. Returns A's and B's arrays in it (identity, from `people`) once identified,
   * else null.
   */
  observe(
    frame: IdentityFrame,
  ): { a: readonly number[] | null; b: readonly number[] | null } | null;
  /** The kept frame nearest `ts` (within MATCH_TS_MS), for pairing a still with its poses. */
  frameAt(ts: number): IdentityFrame | null;
  /**
   * A and B are these people of the frame at `ts` (person indices). Replays the kept frames from
   * there; false (nothing changes) when that frame is gone or the people have no hip centres.
   */
  identify(ts: number, aPerson: number, bPerson: number): boolean;
  identified(): boolean;
  /** Where A and B stand now (hip centres), for the round's tracker; null when not identified. */
  start(): TrackerStart | null;
  clear(): void;
}

interface Follow {
  tracker: Tracker;
  /** Last ts each was seen. */
  seenA: number;
  seenB: number;
  /** Last ts pushed (frames are pushed once, in order). */
  at: number;
}

export function createPlayerIdentity(size: { w: number; h: number }): PlayerIdentity {
  let ring: IdentityFrame[] = [];
  let follow: Follow | null = null;

  const push = (f: Follow, frame: IdentityFrame) => {
    if (frame.ts <= f.at) return null;
    f.at = frame.ts;
    const out = f.tracker.push(frame.ts, frame.people);
    if (out.a) f.seenA = frame.ts;
    if (out.b) f.seenB = frame.ts;
    return out;
  };

  const self: PlayerIdentity = {
    observe(frame) {
      ring.push({ ts: frame.ts, people: frame.people });
      const keepFrom = frame.ts - IDENTITY.RING_MS;
      if (ring[0]!.ts < keepFrom) ring = ring.filter((f) => f.ts >= keepFrom);
      if (!follow) return null;
      const out = push(follow, frame);
      if (
        frame.ts - follow.seenA > IDENTITY.LOST_MS ||
        frame.ts - follow.seenB > IDENTITY.LOST_MS
      ) {
        follow = null;
        return null;
      }
      return out ? { a: out.a, b: out.b } : null;
    },
    frameAt(ts) {
      let best: IdentityFrame | null = null;
      for (const f of ring) {
        const d = Math.abs(f.ts - ts);
        if (d <= IDENTITY.MATCH_TS_MS && (!best || d < Math.abs(best.ts - ts))) best = f;
      }
      return best;
    },
    identify(ts, aPerson, bPerson) {
      const at = self.frameAt(ts);
      if (!at || aPerson === bPerson) return false;
      const ka = at.people[aPerson];
      const kb = at.people[bPerson];
      const ha = ka ? hipCenter(ka) : null;
      const hb = kb ? hipCenter(kb) : null;
      if (!ha || !hb) return false;
      const f: Follow = {
        tracker: createTracker({ w: size.w, h: size.h, start: { a: ha, b: hb } }),
        seenA: at.ts,
        seenB: at.ts,
        at: Number.NEGATIVE_INFINITY,
      };
      for (const fr of ring) if (fr.ts >= at.ts) push(f, fr);
      const last = ring[ring.length - 1];
      if (last && (last.ts - f.seenA > IDENTITY.LOST_MS || last.ts - f.seenB > IDENTITY.LOST_MS))
        return false;
      follow = f;
      return true;
    },
    identified: () => follow !== null,
    start() {
      if (!follow) return null;
      const { a, b } = follow.tracker.last();
      return a && b ? { a, b } : null;
    },
    clear() {
      follow = null;
    },
  };
  return self;
}
