// Bearer sessions: `yo_s_<base64url 32 B>`, stored as sha256(token) only, 7-day lifetime.
// Spec: docs/planning/API-CONTRACT.md §1.3.
import { and, eq, isNull } from 'drizzle-orm';
import { apiSessions, devices, type Db } from '@youre-on/db';
import { SESSION_TTL_MS, SessionToken } from '@youre-on/shared/api';
import { randomB64Url, sha256Hex } from '../crypto';
import { HttpError } from '../errors';
import type { AuthContext } from '../context';

export const TOKEN_PREFIX = 'yo_s_';

export interface IssuedSession {
  token: string;
  session_id: string;
  expires_at: Date;
}

type Executor = Pick<Db, 'insert' | 'select' | 'update'>;

export async function issueAppSession(
  db: Executor,
  a: { user_id: string; device_id: string; now: number },
): Promise<IssuedSession> {
  const token = TOKEN_PREFIX + randomB64Url(32);
  const expires_at = new Date(a.now + SESSION_TTL_MS);
  const [row] = await db
    .insert(apiSessions)
    .values({
      token_sha256: sha256Hex(token),
      user_id: a.user_id,
      device_id: a.device_id,
      scopes: ['app'],
      created_at: new Date(a.now),
      expires_at,
    })
    .returning({ id: apiSessions.id });
  if (!row) throw new Error('session insert returned no row');
  return { token, session_id: row.id, expires_at };
}

/**
 * Resolves a bearer token. Throws AUTH_REQUIRED (unknown/revoked/malformed), SESSION_EXPIRED,
 * or DEVICE_REVOKED. Used by REST (requireSession) and the WS hello.
 */
export async function resolveSession(db: Db, token: string, now: number): Promise<AuthContext> {
  if (!SessionToken.safeParse(token).success) throw new HttpError('AUTH_REQUIRED');
  const [row] = await db
    .select({
      id: apiSessions.id,
      user_id: apiSessions.user_id,
      device_id: apiSessions.device_id,
      room_id: apiSessions.room_id,
      scopes: apiSessions.scopes,
      expires_at: apiSessions.expires_at,
      revoked_at: apiSessions.revoked_at,
      device_revoked_at: devices.revoked_at,
      device_pubkey: devices.device_pubkey,
    })
    .from(apiSessions)
    .leftJoin(devices, eq(devices.id, apiSessions.device_id))
    .where(eq(apiSessions.token_sha256, sha256Hex(token)))
    .limit(1);
  if (!row || row.revoked_at) throw new HttpError('AUTH_REQUIRED');
  if (row.expires_at.getTime() <= now) throw new HttpError('SESSION_EXPIRED');
  if (row.device_revoked_at) throw new HttpError('DEVICE_REVOKED');
  return {
    session_id: row.id,
    scopes: row.scopes.filter(
      (s): s is AuthContext['scopes'][number] => s === 'app' || s === 'stage' || s === 'demo',
    ),
    user_id: row.user_id,
    device_id: row.device_id,
    device_pubkey: row.device_pubkey,
    room_id: row.room_id,
    expires_at: row.expires_at,
  };
}

export async function revokeSession(db: Db, session_id: string, now: number): Promise<void> {
  await db
    .update(apiSessions)
    .set({ revoked_at: new Date(now) })
    .where(and(eq(apiSessions.id, session_id), isNull(apiSessions.revoked_at)));
}

/** Extracts the token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}
