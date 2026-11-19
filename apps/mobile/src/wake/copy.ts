// Every fixed string of "Jarvis" listening, with its copy role (ui/copyRule), checked by
// ./__tests__/copy.test.ts. The heard challenge itself is data.
import type { CopyRole } from '../ui/copyRule';
import type { WakeStatus } from './controller';

type Line = readonly [text: string, role: CopyRole];

export const WAKE_COPY = {
  // Idle hint on a screen that listens.
  hint: ['Say “Jarvis”', 'label'],
  listening: ['Listening', 'label'],
  // "Jarvis" heard; the rainbow loop is running.
  capturing: ['Go ahead', 'label'],
  // The challenge came through (shown above the heard text, which is data).
  heard: ['Heard you', 'label'],
  youSaid: ['You said', 'label'],
  // Only "Jarvis" was said.
  noChallenge: ['Say the challenge', 'label'],
  // Home: "Jarvis" heard but there is no one obvious to challenge (no face scan, several people).
  pickOpponent: ['Pick an opponent', 'label'],
  // Fallbacks when wake listening can't run.
  tapToTalk: ['Tap to talk', 'label'],
  denied: ['Mic access off', 'error'],
  openSettings: ['Open Settings', 'label'],
  unavailable: ['Voice unavailable', 'error'],
  failed: ['Voice stopped', 'error'],
} as const satisfies Record<string, Line>;

export const wt = (line: Line): string => line[0];

/** The status line per status; null where the screen shows nothing extra. */
export const STATUS_COPY: Readonly<Record<WakeStatus, Line | null>> = {
  off: null,
  unavailable: WAKE_COPY.unavailable,
  denied: WAKE_COPY.denied,
  listening: WAKE_COPY.hint,
  capturing: WAKE_COPY.capturing,
  heard: WAKE_COPY.heard,
  error: WAKE_COPY.failed,
};
