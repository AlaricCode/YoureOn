// Helpers shared by the auth handlers (routes.ts, demo-claim.ts).
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { Db } from '@youre-on/db';
import type { Session } from '@youre-on/shared/api';
import { Pubkey, type UserRef } from '@youre-on/shared/primitives';
import { HttpError } from '../errors';
import { BUCKETS } from '../http/rate-limit';
import type { AppEnv } from '../context';
import type { Challenge } from './challenges';

export function clientIp(c: Context<AppEnv>): string {
  const fly = c.req.header('Fly-Client-IP');
  if (fly) return fly;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // app.request() in tests has no socket
  }
}

/**
 * Auth buckets, per IP and per device key. Runs before the body is validated, so the device
 * bucket is keyed only on a well-formed key: any other string (up to the 64 KB body cap) would be
 * a fresh map entry per request. The request then fails validation (422) under the IP bucket alone.
 */
export function limitAuth(c: Context<AppEnv>, device_pubkey?: string) {
  const rl = c.get('deps').rateLimit;
  if (!rl) return;
  rl.take('auth/ip', clientIp(c), BUCKETS.auth);
  if (device_pubkey && Pubkey.safeParse(device_pubkey).success)
    rl.take('auth/device', device_pubkey, BUCKETS.auth);
}

export function consumeChallenge(
  c: Context<AppEnv>,
  challenge_id: string,
  device_pubkey: string,
): Challenge {
  const r = c.get('deps').challenges.consume(challenge_id);
  if (!r.ok) throw new HttpError('CHALLENGE_EXPIRED');
  // Bound to the key it was issued for: a different key is the "wrong key" case.
  if (r.challenge.device_pubkey !== device_pubkey) throw new HttpError('SIGNATURE_INVALID');
  return r.challenge;
}

export function userRef(u: {
  id: string;
  wallet_pubkey: string | null;
  display_name: string;
}): UserRef {
  // wallet_pubkey is NOT NULL for every non-demo user (users_wallet_required CHECK); a demo user
  // binds its wallet through demo-claim before it can log in.
  if (!u.wallet_pubkey)
    throw new HttpError('INVALID_STATE', 'This account has no wallet yet.', {
      reason: 'no_wallet',
    });
  return {
    user_id: u.id,
    pubkey: u.wallet_pubkey as UserRef['pubkey'], // validated by the users_wallet_pubkey_fmt CHECK
    display_name: u.display_name,
    avatar_url: null, // no avatars: the server has no object storage
  };
}

export function sessionBody(
  s: { token: string; session_id: string; expires_at: Date },
  user: UserRef,
  device_id: string,
  now: number,
): Session {
  return {
    token: s.token,
    session_id: s.session_id,
    user,
    device_id,
    expires_at: s.expires_at.toISOString(),
    server_time: new Date(now).toISOString(),
  };
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Postgres unique_violation, possibly wrapped by Drizzle ("Failed query", cause = pg error). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
