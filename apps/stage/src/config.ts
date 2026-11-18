// How the stage page is told what to show, without typing on the projector laptop:
//
//   https://<app>.fly.dev/stage/?room=ABC234#key=<STAGE_KEY>&demo=<DEMO_ADMIN_TOKEN>
//
// Query (not secret): room (6-char code or uuid), bet (a bet already in progress), preview[=step]
// (sample data, no server), nopreload. Fragment (secret, never sent to any server or written to its
// logs): key (STAGE_KEY), token (a ready stage token), demo (DEMO_ADMIN_TOKEN, enables the health
// strip). Secrets are read from the fragment only (a ?key= has already reached the server's and
// the proxy's request logs, so it is ignored and the form says so), then removed from the address
// bar. server (another API origin) is honoured only on localhost / in Vite dev: on the deployed
// page a crafted ?server= link would send the typed stage key and demo admin key to another host.
// The session (stage token, room, demo key, the bets on screen) is kept in sessionStorage so a
// reload of the same tab reconnects to the same card without the URL.
import { parseRoomCode } from '@youre-on/shared/api';

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
  /** A secret (key / token / demo) was in the query, where it is ignored. */
  secretInQuery: boolean;
  /** A server was given but this page does not honour one (not localhost / dev). */
  serverIgnored: boolean;
}

const SECRET_KEYS = ['key', 'token', 'demo'] as const;

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** Pages that may talk to another API origin: a local server or the Vite dev server. */
export function serverOverrideAllowed(hostname: string, dev: boolean): boolean {
  const h = hostname.toLowerCase();
  return (
    dev ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1'
  );
}

export function parseLaunch(
  search: string,
  hash: string,
  opts: { allowServer?: boolean } = {},
): LaunchParams {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const f = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const pick = (k: string) => clean(f.get(k)) ?? clean(q.get(k));
  const server = pick('server');
  const allowServer = opts.allowServer ?? false;
  return {
    preview: q.has('preview') ? (q.get('preview') ?? '').trim().toLowerCase() : null,
    room: pick('room'),
    bet: pick('bet'),
    server: allowServer ? server : null,
    key: clean(f.get('key')),
    token: clean(f.get('token')),
    demo: clean(f.get('demo')),
    noPreload: q.has('nopreload'),
    secretInQuery: SECRET_KEYS.some((k) => clean(q.get(k)) !== null),
    serverIgnored: !allowServer && server !== null,
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

/**
 * The API origin to talk to. '' (or nothing) means this page's own origin: the server that
 * served it. A bare host gets https:// (http:// for localhost). Throws on anything that is not an
 * http(s) URL, so a typo fails at Connect instead of inside the socket.
 */
export function resolveServer(serverUrl: string | null | undefined, origin: string): string {
  let s = (serverUrl?.trim() || origin).replace(/\/+$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s))
    s = `${/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(s) ? 'http' : 'https'}://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Server "${serverUrl ?? ''}" is not a URL (like https://youre-on.fly.dev).`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error(`Server "${serverUrl ?? ''}" must be an http(s) URL.`);
  return s;
}

/** The server's origin when it is not `origin` (the form then shows it, prominently). */
export function foreignServer(serverUrl: string | null | undefined, origin: string): string | null {
  try {
    const s = new URL(resolveServer(serverUrl, origin)).origin;
    return s === new URL(origin).origin ? null : s;
  } catch {
    return serverUrl?.trim() || null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s.trim());

/** The header's room label: the canonical code (upper case), or a uuid's first block. */
export function roomLabelOf(room: string): string {
  const r = room.trim();
  if (isUuid(r)) return r.slice(0, 8);
  return parseRoomCode(r) ?? r;
}

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
  /** ?bet= / the form's bet id: pinned while it is live. */
  betId: string | null;
  /** ISO; the stage token's expiry (12 h). */
  expiresAt: string | null;
  roomLabel?: string;
  /** What the big card showed, and the other bets the page knew (newest first). */
  focusBetId?: string | null;
  bets?: string[];
}

/** How many bets a reload re-subscribes (each replays from seq 0). */
export const MAX_REMEMBERED_BETS = 8;

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
  return {
    ...s,
    focusBetId: typeof s.focusBetId === 'string' ? s.focusBetId : null,
    bets: Array.isArray(s.bets)
      ? s.bets.filter((b): b is string => typeof b === 'string').slice(0, MAX_REMEMBERED_BETS)
      : [],
  };
}

/**
 * The bets a reload of this session should come back to: the focus first, then the newest of
 * the others (`known` in arrival order, newest last).
 */
export function rememberedBets(focus: string | null, known: readonly string[]): string[] {
  const out = focus ? [focus] : [];
  for (let i = known.length - 1; i >= 0 && out.length < MAX_REMEMBERED_BETS; i--)
    if (!out.includes(known[i]!)) out.push(known[i]!);
  return out;
}

/** Writes the focus and the known bets into the saved session (no-op without one). */
export function rememberBets(focus: string | null, known: readonly string[]): void {
  const s = readJson<SavedSession>('session', SESSION_KEY);
  if (!s || typeof s.token !== 'string') return;
  const bets = rememberedBets(focus, known);
  if (s.focusBetId === focus && JSON.stringify(s.bets ?? []) === JSON.stringify(bets)) return;
  writeJson('session', SESSION_KEY, { ...s, focusBetId: focus, bets });
}
