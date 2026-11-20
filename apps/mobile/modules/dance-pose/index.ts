// DancePose: the Dance Off judge-cam native view (Apple Vision body pose + same-clock recording).
// Contract: docs/planning/DANCE-OFF.md §6.1. Load it only through importSafely:
//
//   const pose = await importSafely(() => import('../../modules/dance-pose'));
//   if (pose.isDancePoseAvailable()) ...
//
// Importing never throws, even in a binary without the native module.
export { DancePoseView } from './src/DancePoseView';
export { DANCE_POSE_MODULE, isDancePoseAvailable, mediaDurationMs } from './src/native';
export {
  DEFAULT_MAX_FPS,
  JOINT_ORDER,
  KEYPOINT_COUNT,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_LONG_SIDE,
  STILL_MAX_LONG_SIDE,
  clampMaxFps,
  emptyStopResult,
  joint,
  toKeypoints,
  toPoseFrame,
  toStatusEvent,
  toStillResult,
  toStopRoundResult,
} from './src/frame';
export type { JointName } from './src/frame';
export type {
  DancePoseHandle,
  DancePoseState,
  DancePoseViewProps,
  DanceSnapshot,
  PoseFrameEvent,
  StartRoundOptions,
  StartRoundResult,
  StatusEvent,
  StillResult,
  StopRoundResult,
} from './src/types';
