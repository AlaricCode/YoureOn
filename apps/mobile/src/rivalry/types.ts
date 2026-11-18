// The live rivalry scan's types (docs: the live rivalry scan design, §5 group B). Structural on
// purpose: they compile against packages/shared before and after the HeadToHead / FaceMatchMode
// additions land, so nothing here imports a field the shared package may not have yet.
//
// Coordinates: every Box here is in the camera VIEW's points (the preview the user sees), unless
// a name says "still" (the upright photo the embedder reads).
import type { FaceMatchRequest } from '@youre-on/shared/face';

import type { ScanMatch } from '../app/scan';
import type { Box } from '../face/pipeline';

/** The face-match body with the live/tap mode (optional: absent = 'tap'). */
export type LiveFaceMatchRequest = FaceMatchRequest & { readonly mode?: 'tap' | 'live' };

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** One face from the live detector, copied out of the native object, in view coordinates. */
export interface RawDetection {
  readonly trackingId?: number | undefined;
  readonly bounds: Box;
  readonly yawAngle: number;
}

/** The head-to-head as the overlay shows it (src/rivalry/format statsOf). */
export interface RivalryStats {
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  /** Signed micro-USDC, as the server sends it. */
  readonly net: string;
  /** "−$7.00", "+$9.00", "$0". */
  readonly netDisplay: string;
  readonly total: number;
  readonly streak: { readonly holder: 'me' | 'them'; readonly length: number } | null;
  readonly rival: boolean;
  readonly lastResult: 'win' | 'loss' | 'push' | null;
}

/** A face the server matched: the challenge ticket plus the stats shown over it. No score. */
export interface LiveMatch extends ScanMatch {
  readonly stats: RivalryStats;
  /** Engine clock (ms) of the match; the cache refreshes it after LIVE_TUNING.knownTtlMs. */
  readonly matchedAtMs: number;
}

export type TrackStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'known'; readonly match: LiveMatch; readonly refreshing: boolean }
  | { readonly kind: 'unknown'; readonly attempts: number; readonly retryAtMs: number | null }
  | { readonly kind: 'too_far' }
  | { readonly kind: 'error'; readonly attempts: number; readonly retryAtMs: number | null };

/** One face followed across detector frames (src/face/liveTracker). */
export interface Track {
  /** `t<trackingId>` from the detector, or `i<n>` when it gave none (IoU matched). */
  readonly key: string;
  /** Smoothed (EMA) box. */
  readonly box: Box;
  readonly yawAngle: number;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  /** Detections this track has had. */
  readonly hits: number;
  /** Since when the box centre has stayed within STABLE_DRIFT x width of `anchor`. */
  readonly stableSinceMs: number | null;
  /** The box centre at `stableSinceMs` (tracker internal; absent on hand-built tracks). */
  readonly anchor?: { readonly x: number; readonly y: number } | undefined;
  readonly status: TrackStatus;
}

/**
 * idle: not started. point: running, nobody in view. closer: the focused face is too small.
 * live: faces in view. paused: backing off after a 429 (silent). not_in_room: the room is gone
 * (matching stopped). stopped: stop() was called.
 */
export type LiveStatus =
  'idle' | 'point' | 'closer' | 'live' | 'paused' | 'not_in_room' | 'stopped';

export interface LiveSnapshot {
  readonly tracks: readonly Track[];
  readonly focusedKey: string | null;
  readonly status: LiveStatus;
  readonly view: Size;
}

/** What the overlay draws for one face (src/rivalry/geometry overlayItems). */
export type OverlayItem =
  | {
      readonly key: string;
      readonly kind: 'known';
      readonly focused: boolean;
      readonly box: Box;
      /** Top-left of the card (focused) or pill (others), in view points. */
      readonly anchor: {
        readonly x: number;
        readonly y: number;
        readonly placement: 'above' | 'below';
      };
      readonly name: string;
      readonly record: string;
      readonly net: string;
      readonly streakLabel: string | null;
      readonly rival: boolean;
      readonly firstBet: boolean;
      readonly refreshing: boolean;
      /** A pill under the focused card: not drawn (kept so its animation state survives). */
      readonly hidden: boolean;
    }
  | {
      readonly key: string;
      readonly kind: 'checking' | 'too_far' | 'unknown';
      readonly focused: boolean;
      readonly box: Box;
    };
