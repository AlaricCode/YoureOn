// The hidden Dance Off settings (DANCE-OFF §6.4), persisted on this phone: the A/V sync offset
// (−500..500 ms; the scorer subtracts it from every pose time, DANCE-OFF §4.4) and the debug
// overlay on the live dance screen. Stored as a small JSON file in the documents directory (the
// same place the calibration sessions live; dance/fs.ts is the expo-file-system adapter). Pure:
// the store takes a text read/write pair, so the clamp and the parsing are tested in node.
import { SYNC_OFFSET_MAX_MS } from '@youre-on/shared/dance/pose';

export interface DanceSettings {
  /** ms, int, −500..500: how late the reference reaches the dancers' eyes (display + mirroring). */
  syncOffsetMs: number;
  /** Raw scores, limbs, lag and FPS over the live dance screen. */
  debugOverlay: boolean;
}

export const DANCE_SETTINGS_FILE = 'dance-settings.json';
export const DEFAULT_DANCE_SETTINGS: DanceSettings = { syncOffsetMs: 0, debugOverlay: false };
/** The calibration stepper's steps. */
export const SYNC_STEPS_MS = [-50, -10, 10, 50] as const;

/** An int in −500..500 (non-numbers are 0). */
export function clampSyncOffset(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const r = Math.round(v) + 0;
  return Math.max(-SYNC_OFFSET_MAX_MS, Math.min(SYNC_OFFSET_MAX_MS, r));
}

/** Whatever was on disk → valid settings (unknown keys dropped, bad values defaulted). */
export function parseDanceSettings(raw: unknown): DanceSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ...DEFAULT_DANCE_SETTINGS };
  const o = raw as Record<string, unknown>;
  return {
    syncOffsetMs: clampSyncOffset(o.syncOffsetMs),
    debugOverlay: o.debugOverlay === true,
  };
}

export function parseDanceSettingsText(text: string | null): DanceSettings {
  if (text === null) return { ...DEFAULT_DANCE_SETTINGS };
  try {
    return parseDanceSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_DANCE_SETTINGS };
  }
}

export interface TextFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface DanceSettingsStore {
  /** The current value (defaults until load() resolves). */
  get(): DanceSettings;
  load(): Promise<DanceSettings>;
  /** Clamps, applies at once, then writes (a failed write keeps the value for this session). */
  set(patch: Partial<DanceSettings>): Promise<DanceSettings>;
  subscribe(listener: () => void): () => void;
}

export function createDanceSettingsStore(file: TextFile): DanceSettingsStore {
  let value: DanceSettings = { ...DEFAULT_DANCE_SETTINGS };
  let loading: Promise<DanceSettings> | null = null;
  let touched = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return {
    get: () => value,
    load() {
      loading ??= file.read().then(
        (text) => {
          // A set() before the file was read wins over what was on disk.
          if (!touched) {
            value = parseDanceSettingsText(text);
            notify();
          }
          return value;
        },
        () => value,
      );
      return loading;
    },
    async set(patch) {
      touched = true;
      value = parseDanceSettings({ ...value, ...patch });
      notify();
      try {
        await file.write(JSON.stringify(value));
      } catch {
        // Kept in memory for this session.
      }
      return value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
