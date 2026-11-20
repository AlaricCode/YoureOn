// Face addressing routes: the consent text, the caller's own enrollment (read, enroll, turn
// matching off or on, hard delete) and POST /v1/rooms/:room_id/face-match.
// Spec: docs/planning/API-CONTRACT.md §2.2, §2.4.
//
// Opt-in only: nothing is stored without a POST carrying the current consent. A match only
// addresses a challenge (POST /v1/bets challenge_method 'face' + match_ticket); it never
// authorizes anything. Request and response bodies on these routes are never logged (nothing in
// this server logs bodies; the face service also strips DB error messages).
//
// Rate limits: face-match 30/min per user (`face-match`, tap scans) plus 60/min for `mode:'live'`
// scans (`face-match/live`, the panning camera), with 1 in flight per user across both;
// enrollment writes 5/h per user. Turning matching off and deleting are never rate limited: the
// consent promises the user can do either at any time.
import type { Context } from 'hono';
import {
  ACCEPTED_FACE_MODELS,
  FACE_CONSENT_PATH,
  FACE_MATCH_BUCKETS,
  FACE_CONSENT_V1_RETENTION,
  FACE_CONSENT_V1_SHA256,
  FACE_CONSENT_V1_TEXT,
  FACE_CONSENT_VERSION,
  FACE_ENROLLMENT_PATH,
  FaceEnrollmentPatchRequest,
  FaceEnrollmentRequest,
  FaceMatchRequest,
  type FaceConsentResponse,
  type FaceMatchMode,
} from '@youre-on/shared/face';
import type { AppDeps, AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireAppSession, requireSignedRequest } from '../auth/middleware';
import { presenceFor } from '../rooms/routes';
import { faceConfigOf } from './config';
import { faceRetentionTask } from './retention';
import {
  enroll,
  enrollmentStatus,
  matchInRoom,
  removeEnrollment,
  setEnrollmentStatus,
} from './service';

/** `face-match`: tap scans (and any request without `mode`). */
export const FACE_MATCH_BUCKET = FACE_MATCH_BUCKETS.tap;
/** `face-match/live`: the live (panning) scan, so it can't use up the tap/Challenge path. */
export const FACE_MATCH_LIVE_BUCKET = FACE_MATCH_BUCKETS.live;
export const FACE_MATCH_LIVE_BUCKET_NAME = 'face-match/live';
export const FACE_ENROLL_BUCKET = { limit: 5, windowMs: 60 * 60_000 } as const;

export function createFaceRoutes(): RouteModule {
  const consent = (): FaceConsentResponse => ({
    consent_version: FACE_CONSENT_VERSION,
    text: FACE_CONSENT_V1_TEXT,
    text_sha256: FACE_CONSENT_V1_SHA256,
    retention_summary: FACE_CONSENT_V1_RETENTION,
    // Sealing is not built: plain-v0 over TLS only.
    face_seal_pubkey: null,
    accepted_models: [...ACCEPTED_FACE_MODELS],
  });

  const takeEnroll = (deps: AppDeps, userId: string) =>
    deps.rateLimit?.take('face/enrollment', userId, FACE_ENROLL_BUCKET);

  return {
    name: 'face',
    register(app, deps) {
      for (const problem of faceConfigOf(deps.env).warnings)
        deps.log.warn('face.config', { problem });
      deps.keeper?.register(faceRetentionTask(deps));
      const matchGate = faceMatchGate((userId, mode) =>
        mode === 'live'
          ? deps.rateLimit?.take(FACE_MATCH_LIVE_BUCKET_NAME, userId, FACE_MATCH_LIVE_BUCKET)
          : deps.rateLimit?.take('face-match', userId, FACE_MATCH_BUCKET),
      );

      app.get(FACE_CONSENT_PATH, requireAppSession, (c) => c.json(consent(), 200));

      app.get(FACE_ENROLLMENT_PATH, requireAppSession, async (c) => {
        const me = appAuth(c);
        return c.json(await enrollmentStatus(deps.db, me.user_id), 200);
      });

      app.post(FACE_ENROLLMENT_PATH, requireSignedRequest, async (c) => {
        const me = appAuth(c);
        takeEnroll(deps, me.user_id);
        const body = await readBody(c, FaceEnrollmentRequest);
        const out = await enroll(deps, me.user_id, body, c.get('requestId'));
        return c.json(out, 201);
      });

      app.patch(FACE_ENROLLMENT_PATH, requireSignedRequest, async (c) => {
        const me = appAuth(c);
        const body = await readBody(c, FaceEnrollmentPatchRequest);
        if (body.status === 'active') takeEnroll(deps, me.user_id);
        const out = await setEnrollmentStatus(deps, me.user_id, body.status, c.get('requestId'));
        return c.json(out, 200);
      });

      app.delete(FACE_ENROLLMENT_PATH, requireSignedRequest, async (c) => {
        const me = appAuth(c);
        await removeEnrollment(deps, me.user_id, c.get('requestId'));
        return c.body(null, 204);
      });

      app.post('/v1/rooms/:room_id/face-match', requireSignedRequest, async (c) => {
        const me = appAuth(c);
        return matchGate(
          me.user_id,
          async (body) =>
            c.json(
              await matchInRoom(deps, me.user_id, roomIdOf(c), body, {
                onlineUserIds: () => presenceFor(deps).onlineUserIds(),
              }),
              200,
            ),
          () => readBody(c, FaceMatchRequest),
        );
      });
    },
  };
}

const roomIdOf = (c: Context<AppEnv>): string => c.req.param('room_id') ?? '';

/** One call per key at a time; a second concurrent call is 429 RATE_LIMITED (Retry-After 1). */
export function oneInFlight() {
  const keys = new Set<string>();
  return async <T>(key: string, f: () => Promise<T>): Promise<T> => {
    if (keys.has(key)) throw busy();
    keys.add(key);
    try {
      return await f();
    } finally {
      keys.delete(key);
    }
  };
}

/**
 * face-match: one in flight per user (tap and live share it), then the bucket of the body's mode
 * (absent = tap). The body is read inside the guard, before the token: a concurrent call refused
 * with "One scan at a time" and an invalid body (422 VALIDATION_FAILED) spend none; a call the
 * bucket refuses frees the guard like any other failure. Without `read`, the call is a tap.
 */
export function faceMatchGate(take: (userId: string, mode: FaceMatchMode) => void) {
  const oneAtATime = oneInFlight();
  return <T, B extends { mode?: FaceMatchMode | undefined } = { mode?: undefined }>(
    userId: string,
    f: (body: B) => Promise<T>,
    read?: () => Promise<B>,
  ): Promise<T> =>
    oneAtATime(userId, async () => {
      const body = read ? await read() : ({} as B);
      take(userId, body.mode ?? 'tap');
      return f(body);
    });
}

const busy = () =>
  new HttpError(
    'RATE_LIMITED',
    'One scan at a time.',
    { bucket: 'face-match/in-flight' },
    { headers: { 'Retry-After': '1' } },
  );

export const faceRoutes: RouteModule = createFaceRoutes();
