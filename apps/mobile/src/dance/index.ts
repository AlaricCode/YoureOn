// Dance Off on the phone (docs/planning/DANCE-OFF.md §6). What the bet flow uses:
// - DanceOffScreen: the judge-cam phone's round (framing → count-in → dance → result → upload).
//   It loads the native pose module lazily (importSafely), so importing this file is safe.
// - DanceWatchScreen / DanceResultBreakdown: the other phone, and the server's verdict.
// - DANCE_ROUTINE_CHOICES: the negotiate panel's routine cards (also from ./routines alone).
// The hidden calibration screen is NOT exported here: diagnostics loads
// ./DanceCalibrationScreen lazily, so it never rides the boot path.
export { DanceOffScreen, resultFromRound } from './DanceOffScreen';
export type { DanceOffScreenProps } from './DanceOffScreen';
export type { DanceUploadBundle } from './model/upload';
export { DanceWatchScreen } from './DanceWatchScreen';
export type { DanceWatchScreenProps } from './DanceWatchScreen';
export { DanceResultBreakdown, resultFromScored } from './DanceResultBreakdown';
export { DANCE_ROUTINE_CHOICES } from './routines';
export type { DanceRoutineChoice } from './routines';
export { DANCE_COPY } from './copy';
