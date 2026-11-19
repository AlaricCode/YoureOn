// expo-file-system adapters for the Dance Off's local files: the settings JSON and the saved
// calibration sessions (documents directory), and reading the native snapshot JPEGs (caches).
// The logic that uses them (settings.ts, recordings.ts, model/upload.ts) is pure and tested.
import { Directory, File, Paths } from 'expo-file-system';

import { createDanceSettingsStore, DANCE_SETTINGS_FILE, type TextFile } from './settings';
import { createDanceSessionStore, DANCE_SESSIONS_DIR, type SessionDir } from './recordings';

/** A JSON/text file in the app's documents directory. */
export function documentTextFile(name: string): TextFile {
  return {
    async read() {
      const f = new File(Paths.document, name);
      return f.exists ? await f.text() : null;
    },
    async write(text) {
      const f = new File(Paths.document, name);
      if (!f.exists) f.create({ intermediates: true });
      await f.write(text);
    },
  };
}

function sessionsDirectory(): Directory {
  const dir = new Directory(Paths.document, DANCE_SESSIONS_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** documentDirectory/dance-sessions. */
export function documentSessionDir(): SessionDir {
  return {
    async list() {
      return sessionsDirectory()
        .list()
        .filter((e): e is File => e instanceof File)
        .map((f) => f.name);
    },
    async read(name) {
      const f = new File(sessionsDirectory(), name);
      return f.exists ? await f.text() : null;
    },
    async write(name, text) {
      const f = new File(sessionsDirectory(), name);
      if (!f.exists) f.create();
      await f.write(text);
    },
    async remove(name) {
      const f = new File(sessionsDirectory(), name);
      if (f.exists) f.delete();
    },
  };
}

/** A file:// URI's bytes (a snapshot JPEG). */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/** The app's documents directory URI (../device/simulator reads where iOS put the sandbox). */
export function appDocumentsUri(): string | null {
  try {
    return Paths.document.uri;
  } catch {
    return null;
  }
}

/** The app-wide settings store (one per JS runtime). */
export const danceSettings = createDanceSettingsStore(documentTextFile(DANCE_SETTINGS_FILE));

/** The app-wide session store. */
export const danceSessions = createDanceSessionStore(documentSessionDir());

/**
 * Deletes a file the pose view wrote to Caches (the face still, once its faces are embedded).
 * Best effort: the native module prunes Caches/dance-pose after a day anyway.
 */
export function deleteCacheFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // already gone, or not ours to delete
  }
}
