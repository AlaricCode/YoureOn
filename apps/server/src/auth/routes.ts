// POST /v1/auth/challenge, /v1/auth/signup, /v1/auth/session; DELETE /v1/auth/session
// (API-CONTRACT §1.3, §2.1). TASKS D0-M4 (server side).
//
// /v1/auth/demo-claim is PENDING (needs the stage claim-token issuer, §2.17); until then it
// falls through to the 404 NOT_FOUND handler, which is also its spec'd answer when
// DEMO_MODE=false.
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { auditLog, devices, users, type Db } from '@youre-on/db';
import {
  AuthChallengeRequest,
  authChallengeMessage,
  LoginRequest,
  SignupRequest,
  walletBindMessage,
  type AuthChallengeResponse,
  type Session,
} from '@youre-on/shared/api';
import type { UserRef } from '@youre-on/shared/primitives';
import { decodeBase64, verifyEd25519 } from '../crypto';
import { HttpError } from '../errors';
import { parseWith, readJsonBody } from '../http/body';
import { BUCKETS } from '../http/rate-limit';
import type { AppEnv, RouteModule } from '../context';
import type { Challenge } from './challenges';
import { issueAppSession, revokeSession } from './sessions';
import { requireSession } from './middleware';

function clientIp(c: Context<AppEnv>): string {
  const fly = c.req.header('Fly-Client-IP');
  if (fly) return fly;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // app.request() in tests has no socket
  }
}

function limitAuth(c: Context<AppEnv>, device_pubkey?: string) {
  const rl = c.get('deps').rateLimit;
  if (!rl) return;
  rl.take('auth/ip', clientIp(c), BUCKETS.auth);
  if (device_pubkey) rl.take('auth/device', device_pubkey, BUCKETS.auth);
}

function consumeChallenge(
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

function userRef(u: { id: string; wallet_pubkey: string | null; display_name: string }): UserRef {
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
    avatar_url: null, // presigned avatar URLs land with POST /v1/me/avatar (PENDING: S3)
  };
}

function sessionBody(
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Postgres unique_violation, possibly wrapped by Drizzle ("Failed query", cause = pg error). */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs the signup transaction. Two concurrent signups for the same wallet or device key race
 * on the UNIQUE indexes; the loser gets 409 INVALID_STATE (as a sequential repeat would),
 * not a 500.
 */
async function signupTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(
        'INVALID_STATE',
        'This wallet or device is already registered. Sign in instead.',
        { reason: 'already_registered' },
      );
    }
    throw err;
  }
}

async function signup(c: Context<AppEnv>) {
  const deps = c.get('deps');
  const raw = await readJsonBody(c);
  const pre = (raw ?? {}) as {
    device_pubkey?: unknown;
    age_attestation?: { is_18_plus?: unknown } | null;
  };
  limitAuth(c, typeof pre.device_pubkey === 'string' ? pre.device_pubkey : undefined);

  // BRIEF 5c guardrail: a missing or false 18+ attestation is AGE_REQUIRED, before any other check.
  if (pre.age_attestation?.is_18_plus !== true) throw new HttpError('AGE_REQUIRED');
  const body = parseWith(SignupRequest, raw);

  const ch = consumeChallenge(c, body.challenge_id, body.device_pubkey);
  const deviceOk = verifyEd25519(
    body.device_pubkey,
    authChallengeMessage({
      purpose: 'signup',
      nonce: ch.nonce,
      device_pubkey: body.device_pubkey,
      wallet_pubkey: body.wallet_pubkey,
    }),
    decodeBase64(body.device_sig),
  );
  const walletOk = verifyEd25519(
    body.wallet_pubkey,
    walletBindMessage({
      wallet_pubkey: body.wallet_pubkey,
      device_pubkey: body.device_pubkey,
      nonce: ch.nonce,
    }),
    decodeBase64(body.wallet_sig),
  );
  if (!deviceOk || !walletOk) throw new HttpError('SIGNATURE_INVALID');
  if (body.wallet_pubkey === body.device_pubkey) {
    throw new HttpError(
      'VALIDATION_FAILED',
      'The device key must be separate from the wallet key.',
      {
        issues: [{ path: 'device_pubkey', message: 'must differ from wallet_pubkey' }],
      },
    );
  }

  const now = deps.now();
  const requestId = c.get('requestId');
  const result = await signupTx(deps.db, async (tx: Tx) => {
    const [existingUser] = await tx
      .select({
        id: users.id,
        wallet_pubkey: users.wallet_pubkey,
        display_name: users.display_name,
      })
      .from(users)
      .where(eq(users.wallet_pubkey, body.wallet_pubkey))
      .limit(1);
    const [existingDevice] = await tx
      .select({ id: devices.id, user_id: devices.user_id, revoked_at: devices.revoked_at })
      .from(devices)
      .where(eq(devices.device_pubkey, body.device_pubkey))
      .limit(1);

    if (existingUser || existingDevice) {
      // Idempotent repeat (e.g. reinstall, lost response): same wallet AND same device key.
      if (existingUser && existingDevice && existingDevice.user_id === existingUser.id) {
        if (existingDevice.revoked_at) throw new HttpError('DEVICE_REVOKED');
        const s = await issueAppSession(tx, {
          user_id: existingUser.id,
          device_id: existingDevice.id,
          now,
        });
        return { user: existingUser, device_id: existingDevice.id, session: s, created: false };
      }
      throw new HttpError(
        'INVALID_STATE',
        'This wallet or device is already registered. Sign in instead.',
        {
          reason: existingUser ? 'wallet_registered' : 'device_registered',
        },
      );
    }

    const [u] = await tx
      .insert(users)
      .values({
        display_name: body.display_name,
        wallet_pubkey: body.wallet_pubkey,
        wallet_kind: 'device_keypair',
        age_attested_18plus: true,
        attested_at: new Date(body.age_attestation.attested_at),
      })
      .returning({
        id: users.id,
        wallet_pubkey: users.wallet_pubkey,
        display_name: users.display_name,
      });
    if (!u) throw new Error('user insert returned no row');
    const [d] = await tx
      .insert(devices)
      .values({
        user_id: u.id,
        platform: 'ios',
        device_pubkey: body.device_pubkey,
        app_version: body.app_version,
      })
      .returning({ id: devices.id });
    if (!d) throw new Error('device insert returned no row');
    await tx.insert(auditLog).values({
      actor_kind: 'user',
      actor_user_id: u.id,
      subject_user_id: u.id,
      action: 'user.signed_up',
      request_id: requestId,
      details: { device_id: d.id, wallet_kind: 'device_keypair', app_version: body.app_version },
    });
    const s = await issueAppSession(tx, { user_id: u.id, device_id: d.id, now });
    return { user: u, device_id: d.id, session: s, created: true };
  });

  deps.log.info('auth.signup', {
    user_id: result.user.id,
    created: result.created,
    request_id: requestId,
  });
  return c.json(sessionBody(result.session, userRef(result.user), result.device_id, now), 201);
}

async function login(c: Context<AppEnv>) {
  const deps = c.get('deps');
  const raw = await readJsonBody(c);
  const pre = (raw ?? {}) as { device_pubkey?: unknown };
  limitAuth(c, typeof pre.device_pubkey === 'string' ? pre.device_pubkey : undefined);
  const body = parseWith(LoginRequest, raw);

  const ch = consumeChallenge(c, body.challenge_id, body.device_pubkey);
  const ok = verifyEd25519(
    body.device_pubkey,
    authChallengeMessage({
      purpose: 'login',
      nonce: ch.nonce,
      device_pubkey: body.device_pubkey,
      wallet_pubkey: null,
    }),
    decodeBase64(body.device_sig),
  );
  if (!ok) throw new HttpError('SIGNATURE_INVALID');

  // Any registered device key logs in, including after a reinstall (Keychain survives it).
  const [row] = await deps.db
    .select({
      device_id: devices.id,
      revoked_at: devices.revoked_at,
      user_id: users.id,
      wallet_pubkey: users.wallet_pubkey,
      display_name: users.display_name,
    })
    .from(devices)
    .innerJoin(users, and(eq(users.id, devices.user_id), isNull(users.deleted_at)))
    .where(eq(devices.device_pubkey, body.device_pubkey))
    .limit(1);
  if (!row) {
    throw new HttpError('SIGNATURE_INVALID', "This device isn't registered. Sign up first.", {
      reason: 'unknown_device',
    });
  }
  if (row.revoked_at) throw new HttpError('DEVICE_REVOKED');
  // Build the UserRef first: a wallet-less (unclaimed demo) user must not get a session row.
  const user = userRef({
    id: row.user_id,
    wallet_pubkey: row.wallet_pubkey,
    display_name: row.display_name,
  });

  const now = deps.now();
  const s = await issueAppSession(deps.db, { user_id: row.user_id, device_id: row.device_id, now });
  await deps.db
    .update(devices)
    .set({ last_seen_at: new Date(now) })
    .where(eq(devices.id, row.device_id));
  return c.json(sessionBody(s, user, row.device_id, now), 200);
}

export const authRoutes: RouteModule = {
  name: 'auth',
  register(app) {
    app.post('/v1/auth/challenge', async (c) => {
      const raw = await readJsonBody(c);
      const pre = (raw ?? {}) as { device_pubkey?: unknown };
      limitAuth(c, typeof pre.device_pubkey === 'string' ? pre.device_pubkey : undefined);
      const body = parseWith(AuthChallengeRequest, raw);
      const deps = c.get('deps');
      const ch = deps.challenges.issue(body.device_pubkey);
      const res: AuthChallengeResponse = {
        challenge_id: ch.challenge_id,
        nonce: ch.nonce,
        expires_at: new Date(ch.expires_at).toISOString(),
        server_time: new Date(deps.now()).toISOString(),
      };
      return c.json(res, 200);
    });

    app.post('/v1/auth/signup', signup);
    app.post('/v1/auth/session', login);

    app.delete('/v1/auth/session', requireSession, async (c) => {
      const deps = c.get('deps');
      const { session_id } = c.get('auth');
      await revokeSession(deps.db, session_id, deps.now());
      deps.hub.closeSession(session_id); // its open sockets stop receiving events
      return c.body(null, 204);
    });
  },
};
