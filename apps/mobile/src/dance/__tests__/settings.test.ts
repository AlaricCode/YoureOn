// The persisted dance settings and the saved calibration sessions.
import { describe, expect, it } from 'vitest';

import { selfTestSeries } from '../model/pipeline';
import {
  buildSession,
  createDanceSessionStore,
  parseSessionText,
  sessionFileName,
  sessionId,
  sessionMetaFromName,
  type SessionDir,
} from '../recordings';
import {
  clampSyncOffset,
  createDanceSettingsStore,
  DEFAULT_DANCE_SETTINGS,
  parseDanceSettings,
  parseDanceSettingsText,
  type TextFile,
} from '../settings';
import { WAVE_POP } from './helpers';

describe('sync offset clamp', () => {
  it('is an int in −500..500', () => {
    expect(clampSyncOffset(120)).toBe(120);
    expect(clampSyncOffset(12.6)).toBe(13);
    expect(clampSyncOffset(600)).toBe(500);
    expect(clampSyncOffset(-501.4)).toBe(-500);
    expect(clampSyncOffset(-0.2)).toBe(0);
    expect(Object.is(clampSyncOffset(-0.2), -0)).toBe(false);
    expect(clampSyncOffset(Number.NaN)).toBe(0);
    expect(clampSyncOffset('5')).toBe(0);
    expect(clampSyncOffset(undefined)).toBe(0);
  });
});

describe('parsing what is on disk', () => {
  it('keeps good values, drops the rest', () => {
    expect(parseDanceSettings({ syncOffsetMs: 80, debugOverlay: true, extra: 1 })).toEqual({
      syncOffsetMs: 80,
      debugOverlay: true,
    });
    expect(parseDanceSettings({ syncOffsetMs: 9_000, debugOverlay: 'yes' })).toEqual({
      syncOffsetMs: 500,
      debugOverlay: false,
    });
    expect(parseDanceSettings(null)).toEqual(DEFAULT_DANCE_SETTINGS);
    expect(parseDanceSettings([1, 2])).toEqual(DEFAULT_DANCE_SETTINGS);
  });

  it('a missing or broken file is the defaults', () => {
    expect(parseDanceSettingsText(null)).toEqual(DEFAULT_DANCE_SETTINGS);
    expect(parseDanceSettingsText('{not json')).toEqual(DEFAULT_DANCE_SETTINGS);
    expect(parseDanceSettingsText('{"syncOffsetMs":-40}')).toEqual({
      syncOffsetMs: -40,
      debugOverlay: false,
    });
  });
});

function memoryFile(initial: string | null, failWrites = false) {
  const state = { text: initial, writes: 0 };
  const file: TextFile = {
    read: async () => state.text,
    write: async (text) => {
      state.writes += 1;
      if (failWrites) throw new Error('disk full');
      state.text = text;
    },
  };
  return { file, state };
}

describe('settings store', () => {
  it('loads, clamps on set, writes JSON, and notifies', async () => {
    const { file, state } = memoryFile('{"syncOffsetMs":30,"debugOverlay":true}');
    const store = createDanceSettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_DANCE_SETTINGS);
    let calls = 0;
    store.subscribe(() => (calls += 1));
    expect(await store.load()).toEqual({ syncOffsetMs: 30, debugOverlay: true });
    expect(calls).toBe(1);
    await store.set({ syncOffsetMs: 30 + 900 });
    expect(store.get()).toEqual({ syncOffsetMs: 500, debugOverlay: true });
    expect(JSON.parse(state.text!)).toEqual({ syncOffsetMs: 500, debugOverlay: true });
    expect(calls).toBe(2);
  });

  it('a set before the file was read wins over the file', async () => {
    const { file } = memoryFile('{"syncOffsetMs":30}');
    const store = createDanceSettingsStore(file);
    const loading = store.load();
    await store.set({ debugOverlay: true });
    await loading;
    expect(store.get()).toEqual({ syncOffsetMs: 0, debugOverlay: true });
  });

  it('a failed write keeps the value for this session', async () => {
    const { file, state } = memoryFile(null, true);
    const store = createDanceSettingsStore(file);
    await store.set({ syncOffsetMs: -120 });
    expect(store.get().syncOffsetMs).toBe(-120);
    expect(state.writes).toBe(1);
  });

  it('loads once', async () => {
    const { file } = memoryFile(null);
    const store = createDanceSettingsStore(file);
    expect(store.load()).toBe(store.load());
  });
});

describe('calibration sessions', () => {
  const at = new Date(2026, 10, 18, 14, 5, 9);

  it('names a session by local time and routine', () => {
    expect(sessionId(at, 'wave-pop')).toBe('20261118-140509-wave-pop');
    expect(sessionFileName('20261118-140509-wave-pop')).toBe('20261118-140509-wave-pop.json');
    expect(sessionMetaFromName('20261118-140509-wave-pop.json')).toEqual({
      id: '20261118-140509-wave-pop',
      routine_id: 'wave-pop',
      label: '2026-11-18 14:05:09',
      stamp: '20261118140509',
    });
    expect(sessionMetaFromName('notes.txt')).toBeNull();
    expect(sessionMetaFromName('20261118-140509-Wave.json')).toBeNull();
  });

  it('round-trips a session through the store, newest first', async () => {
    const files = new Map<string, string>([['junk.txt', 'x']]);
    const dir: SessionDir = {
      list: async () => [...files.keys()],
      read: async (name) => files.get(name) ?? null,
      write: async (name, text) => {
        files.set(name, text);
      },
      remove: async (name) => {
        files.delete(name);
      },
    };
    const store = createDanceSessionStore(dir);
    const series = selfTestSeries(WAVE_POP);
    const older = buildSession({
      at: new Date(2026, 10, 18, 9, 0, 0),
      routineId: 'wave-pop',
      series,
      clientScores: { a: 1_000, b: 1_000 },
      fps: 29.94,
    });
    const newer = buildSession({ at, routineId: 'wave-pop', series, clientScores: null, fps: 30 });
    await store.save(older);
    await store.save(newer);
    expect((await store.list()).map((m) => m.id)).toEqual([newer.id, older.id]);
    const back = await store.load(older.id);
    expect(back).toEqual(older);
    expect(back?.fps).toBe(29.9);
    await store.remove(older.id);
    expect((await store.list()).map((m) => m.id)).toEqual([newer.id]);
    expect(await store.load('20000101-000000-gone')).toBeNull();
  });

  it('refuses a malformed file', () => {
    expect(parseSessionText('{"schema_version":1}')).toBeNull();
    expect(parseSessionText('nope')).toBeNull();
  });
});
