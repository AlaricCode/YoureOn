// "Jarvis" wake word: say "Jarvis, <the challenge>" and the judge hears the challenge.
//
// Nothing here imports the native module statically: ./useWakeWord loads modules/wake-word
// through importSafely when it mounts, so importing this barrel is safe in any binary.
export {
  WAKE_WORD,
  WAKE_SPELLINGS,
  LEADING_FILLERS,
  cleanTail,
  findWakes,
  hasWake,
  isWakeKey,
  normalizeTranscript,
  splitAfterWake,
} from './phrase';
export type { WakeMatch, WakeSplit } from './phrase';
export { DEFAULT_WAKE_TIMING, createWakeDetector } from './detector';
export type {
  TranscriptInput,
  UtteranceReason,
  WakeDetector,
  WakeEvent,
  WakePhase,
  WakeTiming,
} from './detector';
export { DEFAULT_TICK_MS, createWakeController } from './controller';
export type {
  NativeStateEvent,
  WakeCallbacks,
  WakeController,
  WakeNative,
  WakePermissions,
  WakeStatus,
} from './controller';
export { STATUS_COPY, WAKE_COPY, wt } from './copy';
export { useWakeWord } from './useWakeWord';
export type { UseWakeWordOptions, WakeWordState } from './useWakeWord';
