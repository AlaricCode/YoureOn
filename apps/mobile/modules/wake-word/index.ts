// WakeWord: on-device "Jarvis" wake phrase listener (SFSpeechRecognizer + AVAudioEngine).
// Contract: README.md. Importing never throws: in a binary without the native module (an old
// build, Expo Go) `WakeWord` is null, the listeners are no-ops and start() resolves
// { ok: false, reason: 'unavailable' }.
//
//   const sub = addTranscriptListener(({ text, segment }) => ...);
//   const res = await startWakeWord({ contextualStrings: ['Jarvis'] });
//   ...
//   await stopWakeWord(); // the mic is free for LiveKit / ElevenLabs once this resolves
//   sub.remove();
import { requireOptionalNativeModule } from 'expo';

import {
  STATE_EVENT,
  TRANSCRIPT_EVENT,
  WAKE_WORD_MODULE,
  normalizeStartOptions,
  startFailure,
  toPermissions,
  toStartResult,
  toStateEvent,
  toTranscriptEvent,
} from './src/payload';
import type {
  WakeWordModule,
  WakeWordPermissions,
  WakeWordStartOptions,
  WakeWordStartResult,
  WakeWordStateEvent,
  WakeWordSubscription,
  WakeWordTranscriptEvent,
} from './src/types';

export {
  DEFAULT_CONTEXTUAL_STRINGS,
  DEFAULT_LOCALE,
  STATE_EVENT,
  TRANSCRIPT_EVENT,
  WAKE_WORD_MODULE,
  normalizeStartOptions,
  permissionsGranted,
  toPermissions,
  toStartResult,
  toStateEvent,
  toTranscriptEvent,
} from './src/payload';
export type { ResolvedStartOptions } from './src/payload';
export type {
  MicPermission,
  SpeechPermission,
  WakeWordEvents,
  WakeWordModule,
  WakeWordPermissions,
  WakeWordStartOptions,
  WakeWordStartResult,
  WakeWordState,
  WakeWordStateEvent,
  WakeWordSubscription,
  WakeWordTranscriptEvent,
} from './src/types';

function loadNativeModule(): WakeWordModule | null {
  try {
    return requireOptionalNativeModule<WakeWordModule>(WAKE_WORD_MODULE);
  } catch {
    return null;
  }
}

/** The native module, or null when this binary does not have it. */
export const WakeWord: WakeWordModule | null = loadNativeModule();

const NOOP_SUBSCRIPTION: WakeWordSubscription = { remove() {} };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Validated onTranscript events. Returns a no-op subscription without the native module. */
export function addTranscriptListener(
  listener: (event: WakeWordTranscriptEvent) => void,
): WakeWordSubscription {
  if (!WakeWord) return NOOP_SUBSCRIPTION;
  try {
    return WakeWord.addListener(TRANSCRIPT_EVENT, (raw: unknown) => {
      const event = toTranscriptEvent(raw);
      if (event) listener(event);
    });
  } catch {
    return NOOP_SUBSCRIPTION;
  }
}

/** Validated onState events. Returns a no-op subscription without the native module. */
export function addStateListener(
  listener: (event: WakeWordStateEvent) => void,
): WakeWordSubscription {
  if (!WakeWord) return NOOP_SUBSCRIPTION;
  try {
    return WakeWord.addListener(STATE_EVENT, (raw: unknown) => {
      const event = toStateEvent(raw);
      if (event) listener(event);
    });
  } catch {
    return NOOP_SUBSCRIPTION;
  }
}

/** True when the native module exists and the recognizer is available for the locale. */
export function isWakeWordAvailable(locale?: string): boolean {
  if (!WakeWord) return false;
  try {
    return WakeWord.isAvailable(normalizeStartOptions({ locale }).locale) === true;
  } catch {
    return false;
  }
}

/** Asks for speech + mic permission as needed. Never rejects. */
export async function requestWakeWordPermissions(): Promise<WakeWordPermissions> {
  if (!WakeWord) return toPermissions(null);
  try {
    return toPermissions(await WakeWord.requestPermissions());
  } catch {
    return toPermissions(null);
  }
}

/** Starts listening with defaults filled in. Never rejects. */
export async function startWakeWord(options?: WakeWordStartOptions): Promise<WakeWordStartResult> {
  if (!WakeWord) return startFailure('unavailable');
  try {
    return toStartResult(await WakeWord.start(normalizeStartOptions(options)));
  } catch (e) {
    return startFailure(`native-error: ${errorMessage(e)}`);
  }
}

/** Stops listening; resolves once the microphone and audio session are released. Never rejects. */
export async function stopWakeWord(): Promise<void> {
  if (!WakeWord) return;
  try {
    await WakeWord.stop();
  } catch {
    // Nothing to release that a failed stop could still hold; native tears down unconditionally.
  }
}
