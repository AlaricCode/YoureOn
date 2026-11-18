// How the stage page is told what to show, without typing on the projector laptop:
//
//   https://<app>.fly.dev/stage/?room=ABC234#key=<STAGE_KEY>&demo=<DEMO_ADMIN_TOKEN>
//
// Query (not secret): room (6-char code or uuid), bet (a bet already in progress), server (another
// API origin; default: this page's own), preview[=step] (sample data, no server). Fragment
// (secret, never sent to any server or written to its logs): key (STAGE_KEY), token (a ready stage
// token), demo (DEMO_ADMIN_TOKEN, enables the health strip). Secrets are read once, then removed
// from the address bar; the session (stage token, room, demo key) is kept in sessionStorage so a
// reload of the same tab reconnects without the URL.

export interface LaunchParams {
  /** null: live. '' : the looping sample sequence. Otherwise a step name to freeze on. */
  preview: string | null;
  room: string | null;
  bet: string | null;
  server: string | null;
  key: string | null;
  token: string | null;
  demo: string | null;
  /** ?nopreload: do not download the REPLAY clips in the background. */
  noPreload: boolean;
}

const SECRET_KEYS = ['key', 'token', 'demo'] as const;

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function parseLaunch(search: string, hash: string): LaunchParams {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const f = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const pick = (k: string) => clean(f.get(k)) ?? clean(q.get(k));
  return {
    preview: q.has('preview') ? (q.get('preview') ?? '').trim().toLowerCase() : null,
    room: pick('room'),
    bet: pick('bet'),
    server: pick('server'),
    key: pick('key'),
    token: pick('token'),
    demo: pick('demo'),
    noPreload: q.has('nopreload'),
  };
}

/** The address with every secret removed (query and fragment); null when nothing changes. */
export function scrubbedHref(href: string): string | null {
  const u = new URL(href);
  let changed = false;
  for (const k of SECRET_KEYS)
    if (u.searchParams.has(k)) {
      u.searchParams.delete(k);
      changed = true;
    }
  if (u.hash) {
    const f = new URLSearchParams(u.hash.slice(1));
    for (const k of SECRET_KEYS)
      if (f.has(k)) {
        f.delete(k);
        changed = true;
      }
    const rest = f.toString();
    u.hash = rest ? `#${rest}` : '';
  }
  return changed ? u.toString() : null;
}

/** '' (or nothing) means this page's own origin: the server that served it. */
export function resolveServer(serverUrl: string | null | undefined, origin: string): string {
  const s = serverUrl?.trim();
  return (s ? s : origin).replace(/\/+$/, '');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s.trim());

// ---- storage --------------------------------------------------------------------------------

/** localStorage: the non-secret form fields (server, room, bet). */
export const CONFIG_KEY = 'yo-stage-config';
/** sessionStorage (this tab only): the live session, so a reload reconnects. */
export const SESSION_KEY = 'yo-stage-session';

export interface SavedSession {
  serverUrl: string;
  roomId: string;
  token: string;
  demoKey: string | null;
  betId: string | null;
  /** ISO; the stage token's expiry (12 h). */
  expiresAt: string | null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(kind: 'local' | 'session'): StorageLike | null {
  try {
    return (kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage) ?? null;
  } catch {
    return null; // storage blocked (private mode, sandbox)
  }
}

export function readJson<T>(kind: 'local' | 'session', key: string): T | null {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(kind: 'local' | 'session', key: string, value: unknown | null): void {
  try {
    const s = storage(kind);
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or blocked: the page still works, a reload just asks again
  }
}

/** A saved session that has not expired (a minute of margin). */
export function loadSession(now: number): SavedSession | null {
  const s = readJson<SavedSession>('session', SESSION_KEY);
  if (!s || typeof s.token !== 'string' || typeof s.roomId !== 'string') return null;
  if (s.expiresAt && Date.parse(s.expiresAt) - 60_000 < now) return null;
  return s;
}
