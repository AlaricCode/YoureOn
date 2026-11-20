// The DancePose native view's JS contract (docs/planning/DANCE-OFF.md §6.1). Types only.
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * One processed camera frame. `t` is ms since the round's first frame while a round runs
 * (startRound -> stopRound), else ms since the camera session's first frame. `w`/`h` are the
 * upright buffer size (720x1280 in portrait). Each person's `k` is the contract's raw person:
 * `[x, y, c] × 19` in JOINT_ORDER, x/y in [0,1] of the upright unmirrored image (top-left origin),
 * c in [0,1], and a missing joint is 0,0,0.
 */
export interface PoseFrameEvent {
  t: number;
  /**
   * ms since the camera session's first frame, always (the native view sends it; it is optional
   * so a saved or synthetic frame may omit it). With `t` of a round frame it maps pre-round
   * frames (framing, count-in) onto the round clock: t_round = ts − (ts₀ − t₀).
   */
  ts?: number;
  w: number;
  h: number;
  /** Measured pose rate (EMA), frames per second. */
  fps: number;
  people: { k: number[] }[];
}

export type DancePoseState = 'starting' | 'running' | 'recording' | 'error' | 'no_camera';

export interface StatusEvent {
  state: DancePoseState;
  message?: string;
}

export interface DanceSnapshot {
  /** ms since the round's first frame (the frame the JPEG was taken from), integer. */
  t_ms: number;
  /** file:// URI in the app's caches directory. */
  uri: string;
  width: number;
  height: number;
  bytes: number;
  /** Lowercase hex SHA-256 of the JPEG bytes. */
  sha256: string;
}

export interface StopRoundResult {
  /** file:// URI of the round's mp4 (H.264, same clock as the poses), null if recording failed. */
  clipUri: string | null;
  /** Lowercase hex SHA-256 of the clip file, null with clipUri. */
  clipSha256: string | null;
  snapshots: DanceSnapshot[];
}

export interface StartRoundOptions {
  /** ms since the round's first frame at which to keep a JPEG (<= 512 px, <= 200 KB). */
  snapshotAtMs: number[];
}

export interface StartRoundResult {
  ok: boolean;
  /** Why the round did not start (e.g. the camera is not running yet). */
  message?: string;
}

/**
 * captureStill(): one full-size upright JPEG (720x1280) of the next frame that goes to the pose
 * detector, for the face assignment (DANCE-OFF.md §3). `ts` is that frame's onPoses `ts`, so the
 * faces in the still pair with that frame's people. The caller deletes the file when done.
 */
export type StillResult =
  | { ok: true; uri: string; width: number; height: number; ts: number }
  | { ok: false; message?: string };

/** The ref handle of `<DancePoseView ref={...} />`. */
export interface DancePoseHandle {
  startRound(opts: StartRoundOptions): Promise<StartRoundResult>;
  stopRound(): Promise<StopRoundResult>;
  captureStill(): Promise<StillResult>;
}

export interface DancePoseViewProps {
  style?: StyleProp<ViewStyle>;
  /** Runs the camera. The camera also stops while the view is off screen. */
  active: boolean;
  /** Pose rate cap, 1..60, default 30. Recording always keeps every camera frame. */
  maxFps?: number;
  /**
   * Which camera: 'back' (default) or 'front', the selfie camera. The poses, the recording and
   * the stills are never mirrored; only the front camera's PREVIEW is a mirror image, so what is
   * drawn over it has to be flipped to match. Read when the camera first starts.
   */
  facing?: DanceCameraFacing;
  onPoses?(e: { nativeEvent: PoseFrameEvent }): void;
  onStatus?(e: { nativeEvent: StatusEvent }): void;
}

export type DanceCameraFacing = 'back' | 'front';
