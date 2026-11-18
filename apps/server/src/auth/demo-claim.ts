// POST /v1/auth/demo-claim (API-CONTRACT §1.3, §2.1; DEMO_MODE only, else 404).
//
//   {challenge_id?, claim_token, device_pubkey, device_sig} -> 200 Session + wallet_seed_b64
//
// Decision D-A: phones A and B import the custodial demo-a / demo-b seeds (env DEMO_A_SECRET_KEY /
// DEMO_B_SECRET_KEY), so phone-signed locks and the server's custodial locks use the same party
// keys. The phone scans the stage QR (src/demo/claim-tokens.ts), signs the challenge with its
// device key (purpose 'demo-claim', wallet '-'), and gets back the session of the user whose
// wallet_pubkey is that party's pubkey (found, or created on first claim) plus the 32-byte seed,
// which it imports as its wallet.
//
// The device key is bound to the demo user even when it belongs to another user (a teammate's
// phone that signed up first): the device row moves over, that device's open sessions are revoked
// and both sides are audited. The demo user's other devices stay bound (cp1-drive, a 2nd phone).
//
// Order: DEMO_MODE -> rate limit -> body -> challenge (single use) -> device signature -> claim
// token (single use; a bad signature never burns it) -> DB. The seed is never logged or audited.
import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { apiSessions, auditLog, devices, users, type Db } from '@youre-on/db';
import {
  AppVersion,
  authChallengeMessage,
  DemoClaimRequest,
  HDR,
  type DemoClaimResponse,
  type DemoParty,
} from '@youre-on/shared/api';
import { decodeBase64, toBase64, verifyEd25519 } from '../crypto';
import { HttpError } from '../errors';
import { parseWith, readJsonBody } from '../http/body';
import type { BucketSpec } from '../http/rate-limit';
import type { AppEnv } from '../context';
import { claimTokensOf, demoPartyKey, type ClaimTokenEntry } from '../demo/claim-tokens';
import type { Challenge } from './challenges';
import {
  clientIp,
  consumeChallenge,
  isUniqueViolation,
  limitAuth,
  sessionBody,
  userRef,
  type Tx,
} from './common';
import { issueAppSession } from './sessions';

/** On top of the §1.7 auth buckets: a claim hands out a wallet seed, so keep guessing slow. */
export const DEMO_CLAIM_BUCKET = { limit: 5, windowMs: 60_000 } as const satisfies BucketSpec;

const DEFAULT_NAME: Record<DemoParty, string> = { a: 'Demo A', b: 'Demo B' };

function challengeFor(
  c: Context<AppEnv>,
  challenge_id: string | undefined,
  device_pubkey: string,
): Challenge {
  if (challenge_id) return consumeChallenge(c, challenge_id, device_pubkey);
  const r = c.get('deps').challenges.consumeLatestFor(device_pubkey);
  if (!r.ok) throw new HttpError('CHALLENGE_EXPIRED');
  return r.challenge;
}

interface ClaimResult {
  user: { id: string; wallet_pubkey: string | null; display_name: string };
  device_id: string;
  session: Awaited<ReturnType<typeof issueAppSession>>;
  revokedSessionIds: string[];
}

async function claimTx(
  db: Db,
  a: {
    party: DemoParty;
    pubkey: string;
    token: ClaimTokenEntry;
    device_pubkey: string;
    app_version: string | null;
    now: number;
    requestId: string;
  },
): Promise<ClaimResult> {
  return db.transaction(async (tx: Tx) => {
    const nowDate = new Date(a.now);
    // 1. The demo party's user: whoever holds its wallet (cp1-drive may have signed it up), else new.
    const [found] = await tx
      .select({
        id: users.id,
        wallet_pubkey: users.wallet_pubkey,
        display_name: users.display_name,
        deleted_at: users.deleted_at,
      })
      .from(users)
      .where(eq(users.wallet_pubkey, a.pubkey))
      .limit(1);
    if (found?.deleted_at) {
      throw new HttpError('INVALID_STATE', 'This demo account was deleted.', {
        reason: 'demo_account_deleted',
      });
    }
    let user: ClaimResult['user'];
    let createdUser = false;
    if (!found) {
      const [u] = await tx
        .insert(users)
        .values({
          display_name: a.token.display_name ?? DEFAULT_NAME[a.party],
          wallet_pubkey: a.pubkey,
          wallet_kind: 'device_keypair',
          is_demo: true,
          // The team's demo accounts are attested at seed time (DATA-MODEL §11).
          age_attested_18plus: true,
          attested_at: nowDate,
        })
        .returning({
          id: users.id,
          wallet_pubkey: users.wallet_pubkey,
          display_name: users.display_name,
        });
      if (!u) throw new Error('user insert returned no row');
      user = u;
      createdUser = true;
    } else if (a.token.display_name && a.token.display_name !== found.display_name) {
      await tx
        .update(users)
        .set({ display_name: a.token.display_name })
        .where(eq(users.id, found.id));
      user = { ...found, display_name: a.token.display_name };
    } else {
      user = found;
    }

    // 2. Bind this device key to the demo user.
    const [dev] = await tx
      .select({ id: devices.id, user_id: devices.user_id, revoked_at: devices.revoked_at })
      .from(devices)
      .where(eq(devices.device_pubkey, a.device_pubkey))
      .limit(1);
    let device_id: string;
    let reboundFrom: string | null = null;
    let revokedSessionIds: string[] = [];
    if (!dev) {
      const [d] = await tx
        .insert(devices)
        .values({
          user_id: user.id,
          platform: 'ios',
          device_pubkey: a.device_pubkey,
          app_version: a.app_version,
        })
        .returning({ id: devices.id });
      if (!d) throw new Error('device insert returned no row');
      device_id = d.id;
    } else {
      device_id = dev.id;
      if (dev.user_id !== user.id) reboundFrom = dev.user_id;
      if (reboundFrom || dev.revoked_at) {
        // Sessions minted for the previous owner (or before a revoke) must not survive the move.
        const revoked = await tx
          .update(apiSessions)
          .set({ revoked_at: nowDate })
          .where(and(eq(apiSessions.device_id, dev.id), isNull(apiSessions.revoked_at)))
          .returning({ id: apiSessions.id });
        revokedSessionIds = revoked.map((r) => r.id);
      }
      await tx
        .update(devices)
        .set({
          user_id: user.id,
          revoked_at: null,
          last_seen_at: nowDate,
          ...(reboundFrom ? { role: 'phone' as const, judge_room_id: null, push_token: null } : {}),
          ...(a.app_version ? { app_version: a.app_version } : {}),
        })
        .where(eq(devices.id, dev.id));
    }

    // 3. Audit (never the seed or the token).
    if (reboundFrom) {
      await tx.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: user.id,
        subject_user_id: reboundFrom,
        action: 'device.rebound',
        request_id: a.requestId,
        details: {
          device_id,
          from_user_id: reboundFrom,
          to_user_id: user.id,
          via: 'demo-claim',
          revoked_sessions: revokedSessionIds.length,
        },
      });
    }
    await tx.insert(auditLog).values({
      actor_kind: 'user',
      actor_user_id: user.id,
      subject_user_id: user.id,
      action: 'user.demo_claimed',
      request_id: a.requestId,
      details: {
        party: a.party,
        wallet_pubkey: a.pubkey,
        device_id,
        device_pubkey: a.device_pubkey,
        word: a.token.word,
        created_user: createdUser,
        rebound_from_user_id: reboundFrom,
        unrevoked: !!dev?.revoked_at && !reboundFrom,
        revoked_sessions: revokedSessionIds.length,
      },
    });

    const session = await issueAppSession(tx, { user_id: user.id, device_id, now: a.now });
    return { user, device_id, session, revokedSessionIds };
  });
}

export async function demoClaim(c: Context<AppEnv>) {
  const deps = c.get('deps');
  // The route does not exist outside the demo (§1.3).
  if (!deps.env.DEMO_MODE) throw new HttpError('NOT_FOUND', 'Not found.');

  const raw = await readJsonBody(c);
  const pre = (raw ?? {}) as { device_pubkey?: unknown };
  limitAuth(c, typeof pre.device_pubkey === 'string' ? pre.device_pubkey : undefined);
  deps.rateLimit?.take('auth/demo-claim', clientIp(c), DEMO_CLAIM_BUCKET);
  const body = parseWith(DemoClaimRequest, raw);

  const ch = challengeFor(c, body.challenge_id, body.device_pubkey);
  const ok = verifyEd25519(
    body.device_pubkey,
    authChallengeMessage({
      purpose: 'demo-claim',
      nonce: ch.nonce,
      device_pubkey: body.device_pubkey,
      wallet_pubkey: null,
    }),
    decodeBase64(body.device_sig),
  );
  if (!ok) throw new HttpError('SIGNATURE_INVALID');

  const requestId = c.get('requestId');
  const spent = claimTokensOf(deps).consume(body.claim_token);
  if (!spent.ok) {
    await deps.db.insert(auditLog).values({
      actor_kind: 'system',
      action: 'demo.claim_refused',
      request_id: requestId,
      details: { reason: spent.reason, device_pubkey: body.device_pubkey },
    });
    deps.log.warn('auth.demo_claim_refused', { reason: spent.reason, request_id: requestId });
    throw new HttpError('NOT_FOUND', "That demo code isn't valid any more. Ask for a new one.", {
      reason: `claim_token_${spent.reason}`,
    });
  }
  const { party } = spent.entry;
  const key = demoPartyKey(deps.env, party);
  if (!key) {
    throw new HttpError('INVALID_STATE', `Demo party ${party} has no key on this server.`, {
      reason: 'demo_key_missing',
      party,
    });
  }
  try {
    if (key.pubkey === body.device_pubkey) {
      throw new HttpError(
        'VALIDATION_FAILED',
        'The device key must be separate from the wallet key.',
        { issues: [{ path: 'device_pubkey', message: 'must differ from the demo wallet' }] },
      );
    }
    const av = AppVersion.safeParse(c.req.header(HDR.appVersion));
    const args = {
      party,
      pubkey: key.pubkey,
      token: spent.entry,
      device_pubkey: body.device_pubkey,
      app_version: av.success ? av.data : null,
      now: deps.now(),
      requestId,
    };
    let result: ClaimResult;
    try {
      result = await claimTx(deps.db, args);
    } catch (err) {
      // Two first claims of one party (or one device) raced on a UNIQUE index: the rerun finds
      // the winner's row and binds to it.
      if (!isUniqueViolation(err)) throw err;
      result = await claimTx(deps.db, { ...args, now: deps.now() });
    }
    for (const id of result.revokedSessionIds) deps.hub.closeSession(id);

    deps.log.info('auth.demo_claim', {
      party,
      user_id: result.user.id,
      device_id: result.device_id,
      rebound_sessions: result.revokedSessionIds.length,
      request_id: requestId,
    });
    const res: DemoClaimResponse = {
      ...sessionBody(result.session, userRef(result.user), result.device_id, args.now),
      wallet_seed_b64: toBase64(key.seed),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(res, 200);
  } finally {
    key.seed.fill(0);
  }
}
