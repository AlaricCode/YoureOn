// "Jarvis, <the challenge>": the React binding of ./controller to the native WakeWord module
// (modules/wake-word, Apple SFSpeechRecognizer on device) and AppState.
//
//   const wake = useWakeWord({
//     enabled: canChallenge && !judgeLive,   // false while the judge session owns the mic
//     onWake: () => setLoop(true),           // at once: show the rainbow loop
//     onUtterance: (text) => startJudge(text), // the mic is already released here
//     onCancel: () => setLoop(false),
//   });
//   wake.status: 'off' | 'unavailable' | 'denied' | 'listening' | 'capturing' | 'heard' | 'error'
//
// Mount it once (one recognizer per app). The native module is loaded lazily through
// importSafely, so a binary without it (simulator, an older build) reports 'unavailable' instead
// of crashing. Listening stops in the background and resumes when the app is active again. After
// an utterance it stays 'heard' (mic off) until `enabled` goes false -> true or resume() is called.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { importSafely } from '../app/importSafely';
import {
  createWakeController,
  type NativeStateEvent,
  type Subscription,
  type WakeController,
  type WakeNative,
  type WakePermissions,
  type WakeStartOptions,
  type WakeStartResult,
  type WakeStatus,
} from './controller';
import type { TranscriptInput, WakeTiming } from './detector';

export interface UseWakeWordOptions {
  /** Listen for "Jarvis" (still subject to permissions, availability and the app being active). */
  enabled: boolean;
  /** "Jarvis" heard: show the loop now. */
  onWake(): void;
  /** The challenge said after "Jarvis" ('' if nothing followed). The mic is already released. */
  onUtterance(text: string): void;
  /** A capture ended without an utterance (disabled, backgrounded, interrupted): hide the loop. */
  onCancel?(): void;
  onError?(message: string): void;
  /** Read once, at mount. */
  timing?: Partial<WakeTiming>;
}

export interface WakeWordState {
  status: WakeStatus;
  /** The native module exists in this binary (the recognizer itself is checked on each start). */
  available: boolean;
  /** Listen again after 'heard' or 'error'. */
  resume(): void;
}

/**
 * The parts of modules/wake-word this hook uses: its never-rejecting wrappers around the native
 * module (assigning the real module to this type checks the contract at compile time).
 */
interface WakeWordBinding {
  /** null in a binary without the native module. */
  WakeWord: object | null;
  requestWakeWordPermissions(): Promise<WakePermissions>;
  startWakeWord(options?: WakeStartOptions): Promise<WakeStartResult>;
  stopWakeWord(): Promise<void>;
  addTranscriptListener(fn: (e: TranscriptInput) => void): Subscription;
  addStateListener(fn: (e: NativeStateEvent) => void): Subscription;
}

async function loadWakeNative(): Promise<WakeNative | null> {
  const mod: WakeWordBinding = await importSafely(() => import('../../modules/wake-word'));
  if (!mod.WakeWord) return null;
  return {
    requestPermissions: () => mod.requestWakeWordPermissions(),
    start: (options) => mod.startWakeWord(options),
    stop: () => mod.stopWakeWord(),
    addTranscriptListener: (fn) => mod.addTranscriptListener(fn),
    addStateListener: (fn) => mod.addStateListener(fn),
  };
}

// At launch AppState can briefly be 'unknown' (or null on old RN typings) in the foreground.
const isForeground = (s: AppStateStatus | string | null | undefined) =>
  s === 'active' || s === 'unknown' || s == null;

export function useWakeWord(options: UseWakeWordOptions): WakeWordState {
  const [status, setStatus] = useState<WakeStatus>('off');
  const [available, setAvailable] = useState(false);
  // Latest callbacks, so the controller (created once) never calls a stale closure.
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<WakeController | null>(null);

  useEffect(() => {
    const c = createWakeController({
      load: loadWakeNative,
      timing: latest.current.timing,
      callbacks: {
        onWake: () => latest.current.onWake(),
        onUtterance: (text) => latest.current.onUtterance(text),
        onCancel: () => latest.current.onCancel?.(),
        onError: (message) => latest.current.onError?.(message),
        onStatus: setStatus,
        onAvailable: setAvailable,
      },
    });
    controller.current = c;
    c.setForeground(isForeground(AppState.currentState));
    const sub = AppState.addEventListener('change', (s) => c.setForeground(s === 'active'));
    return () => {
      sub.remove();
      c.dispose();
      if (controller.current === c) controller.current = null;
    };
  }, []);

  // Declared after the controller effect, so on mount (and a StrictMode re-mount) it runs
  // against the controller that effect just created.
  const { enabled } = options;
  useEffect(() => {
    controller.current?.setEnabled(enabled);
  }, [enabled]);

  const resume = useCallback(() => controller.current?.resume(), []);

  return { status, available, resume };
}
