// Saved calibration sessions (DANCE-OFF §6.4): a round's quantized PoseSeries plus the routine
// and a little metadata, as JSON under documentDirectory/dance-sessions/<id>.json. The
// calibration screen replays one through the same scorer (real time or fast). Pure: the store
// takes a small directory interface (dance/fs.ts adapts expo-file-system), so it is tested in
// node.
import { z } from 'zod/v4';

import { PoseSeries } from '@youre-on/shared/dance/pose';

export const DANCE_SESSIONS_DIR = 'dance-sessions';
export const DANCE_SESSION_SCHEMA = 1 as const;

export const DanceSession = z.object({
  schema_version: z.literal(DANCE_SESSION_SCHEMA),
  kind: z.literal('dance-session'),
  id: z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,32}$/),
  routine_id: z.string().min(1).max(32),
  /** ISO time it was saved. */
  saved_at: z.string(),
  series: PoseSeries,
  /** What the phone scored it at the time (tenths), for comparing after a scorer change. */
  client_scores: z.object({ a: z.number().int(), b: z.number().int() }).nullable(),
  /** Measured pose rate during the round. */
  fps: z.number().nonnegative(),
});
export type DanceSession = z.infer<typeof DanceSession>;

export interface DanceSessionMeta {
  id: string;
  routine_id: string;
  /** From the id: "2026-11-18 14:05:09". */
  label: string;
  /** For sorting (newest first). */
  stamp: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "20261118-140509-wave-pop" from a local time and the routine id. */
export function sessionId(at: Date, routineId: string): string {
  const d = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const t = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${d}-${t}-${routineId}`;
}

export const sessionFileName = (id: string): string => `${id}.json`;

const NAME_RE = /^([0-9]{8})-([0-9]{6})-([a-z0-9-]{1,32})\.json$/;

/** A session file name → its listing row, or null for anything else in the directory. */
export function sessionMetaFromName(name: string): DanceSessionMeta | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, d, t, routine] = m as unknown as [string, string, string, string];
  return {
    id: `${d}-${t}-${routine}`,
    routine_id: routine,
    label: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`,
    stamp: `${d}${t}`,
  };
}

export function buildSession(input: {
  at: Date;
  routineId: string;
  series: PoseSeries;
  clientScores: { a: number; b: number } | null;
  fps: number;
}): DanceSession {
  return {
    schema_version: DANCE_SESSION_SCHEMA,
    kind: 'dance-session',
    id: sessionId(input.at, input.routineId),
    routine_id: input.routineId,
    saved_at: input.at.toISOString(),
    series: input.series,
    client_scores: input.clientScores,
    fps: Math.max(0, Math.round(input.fps * 10) / 10),
  };
}

export function parseSessionText(text: string): DanceSession | null {
  try {
    const r = DanceSession.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The sessions directory, as the store needs it. */
export interface SessionDir {
  list(): Promise<string[]>;
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface DanceSessionStore {
  /** Newest first. */
  list(): Promise<DanceSessionMeta[]>;
  load(id: string): Promise<DanceSession | null>;
  save(session: DanceSession): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createDanceSessionStore(dir: SessionDir): DanceSessionStore {
  return {
    async list() {
      const names = await dir.list().catch(() => [] as string[]);
      return names
        .map(sessionMetaFromName)
        .filter((m): m is DanceSessionMeta => m !== null)
        .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
    },
    async load(id) {
      const text = await dir.read(sessionFileName(id)).catch(() => null);
      return text === null ? null : parseSessionText(text);
    },
    async save(session) {
      const ok = DanceSession.parse(session);
      await dir.write(sessionFileName(ok.id), JSON.stringify(ok));
    },
    async remove(id) {
      await dir.remove(sessionFileName(id));
    },
  };
}
