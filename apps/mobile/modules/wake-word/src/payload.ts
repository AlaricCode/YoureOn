// Pure helpers for the WakeWord payloads. No React Native or Expo imports, so node tests can load
// it. Native payloads are validated here before app code sees them.
import type {
  MicPermission,
  SpeechPermission,
  WakeWordPermissions,
  WakeWordStartOptions,
  WakeWordStartResult,
  WakeWordState,
  WakeWordStateEvent,
  WakeWordTranscriptEvent,
} from './types';

/** The Expo module name (Name("WakeWord") in ios/WakeWordModule.swift). */
export const WAKE_WORD_MODULE = 'WakeWord';
export const TRANSCRIPT_EVENT = 'onTranscript';
export const STATE_EVENT = 'onState';

/** Defaults the native side applies too (WakeWordModule.defaultLocale / defaultContextualStrings). */
export const DEFAULT_LOCALE = 'en-US';
export const DEFAULT_CONTEXTUAL_STRINGS: readonly string[] = ['Jarvis'];

const STATES: readonly WakeWordState[] = [
  'listening',
  'stopped',
  'restarting',
  'error',
  'interrupted',
];
const SPEECH: readonly SpeechPermission[] = ['granted', 'denied', 'restricted', 'undetermined'];
const MIC: readonly MicPermission[] = ['granted', 'denied', 'undetermined'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Options with every default filled in, exactly what the native side ends up using. */
export interface ResolvedStartOptions {
  locale: string;
  contextualStrings: string[];
  onDevice: boolean;
}

/** Trims, drops empty and duplicate phrases (case-insensitive), and fills defaults. */
export function normalizeStartOptions(options?: WakeWordStartOptions): ResolvedStartOptions {
  const rawLocale: unknown = options?.locale;
  const locale =
    typeof rawLocale === 'string' && rawLocale.trim() !== '' ? rawLocale.trim() : DEFAULT_LOCALE;
  const rawList: unknown = options?.contextualStrings;
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const raw of Array.isArray(rawList) ? (rawList as unknown[]) : []) {
    if (typeof raw !== 'string') continue;
    const phrase = raw.trim();
    const key = phrase.toLowerCase();
    if (phrase === '' || seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  return {
    locale,
    contextualStrings: phrases.length > 0 ? phrases : [...DEFAULT_CONTEXTUAL_STRINGS],
    onDevice: options?.onDevice !== false,
  };
}

/** An onTranscript payload, or null when malformed. */
export function toTranscriptEvent(raw: unknown): WakeWordTranscriptEvent | null {
  if (!isObject(raw) || typeof raw.text !== 'string') return null;
  const segment = raw.segment;
  if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0) return null;
  return { text: raw.text, isFinal: raw.isFinal === true, segment };
}

/** An onState payload, or null when malformed. */
export function toStateEvent(raw: unknown): WakeWordStateEvent | null {
  if (!isObject(raw) || !oneOf(STATES, raw.state)) return null;
  const event: WakeWordStateEvent = { state: raw.state };
  if (typeof raw.message === 'string' && raw.message !== '') event.message = raw.message;
  return event;
}

/** A start() result; anything malformed reads as a failed start. */
export function toStartResult(raw: unknown): WakeWordStartResult {
  if (!isObject(raw) || typeof raw.ok !== 'boolean') {
    return { ok: false, onDevice: false, reason: 'bad-native-result' };
  }
  const result: WakeWordStartResult = { ok: raw.ok, onDevice: raw.onDevice === true };
  if (typeof raw.reason === 'string' && raw.reason !== '') result.reason = raw.reason;
  else if (!raw.ok) result.reason = 'unknown';
  return result;
}

/** A requestPermissions() result; unknown values read as 'undetermined'. */
export function toPermissions(raw: unknown): WakeWordPermissions {
  const o: Record<string, unknown> = isObject(raw) ? raw : {};
  return {
    speech: oneOf(SPEECH, o.speech) ? o.speech : 'undetermined',
    mic: oneOf(MIC, o.mic) ? o.mic : 'undetermined',
  };
}

/** Both permissions granted: start() can succeed. */
export function permissionsGranted(p: WakeWordPermissions): boolean {
  return p.speech === 'granted' && p.mic === 'granted';
}

/** A start() failure for when the call never reached native code. */
export function startFailure(reason: string): WakeWordStartResult {
  return { ok: false, onDevice: false, reason };
}
