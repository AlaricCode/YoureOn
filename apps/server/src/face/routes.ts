// Face addressing routes (Beat 1; API-CONTRACT §2.2, §2.4; DATA-MODEL §10):
//   GET    /v1/face/consent                  (B) -> FaceConsentResponse (the exact consent text + hash)
//   GET    /v1/face/enrollment               (B) -> FaceEnrollmentStatusResponse (no vector data)
//   POST   /v1/face/enrollment               (S) -> 201 {status:'active', enrolled_at}
//   PATCH  /v1/face/enrollment               (S) -> 200 FaceEnrollmentStatusResponse
//   DELETE /v1/face/enrollment               (S) -> 204 (hard delete; idempotent)
//   POST   /v1/rooms/:room_id/face-match     (S, room member) -> {match: {...}} | {match: null}
//
// Opt-in only: nothing is stored without a POST carrying the current consent. A match only
// addresses a challenge (POST /v1/bets challenge_method 'face' + match_ticket); it never
// authorizes anything. Request and response bodies on these routes are never logged (nothing in
// this server logs bodies; the face service also strips DB error messages).
//
// Rate limits (§1.7): face-match 30/min per user and 1 in flight; enrollment writes 5/h per
// user. Turning matching off and deleting are never rate limited ("disable or delete it
// anytime", BRIEF 5e).
import type { Context } from 'hono';
import {
  ACCEPTED_FACE_MODELS,
  FACE_CONSENT_PATH,
  FACE_CONSENT_V1_RETENTION,
  FACE_CONSENT_V1_SHA256,
  FACE_CONSENT_V1_TEXT,
  FACE_CONSENT_VERSION,
  FACE_ENROLLMENT_PATH,
  FaceEnrollmentPatchRequest,
  FaceEnrollmentRequest,
  FaceMatchRequest,
  type FaceConsentResponse,
} from '@youre-on/shared/face';
import type { AppDeps, AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireAppSession, requireSignedRequest } from '../auth/middleware';
import { faceConfigOf } from './config';
import { faceRetentionTask } from './retention';
import {
  enroll,
  enrollmentStatus,
  matchInRoom,
  removeEnrollment,
  setEnrollmentStatus,
} from './service';

export const FACE_MATCH_BUCKET = { limit: 30, windowMs: 60_000 } as const;
export const FACE_ENROLL_BUCKET = { limit: 5, windowMs: 60 * 60_000 } as const;

export function createFaceRoutes(): RouteModule {
  const consent = (): FaceConsentResponse => ({
    consent_version: FACE_CONSENT_VERSION,
    text: FACE_CONSENT_V1_TEXT,
    text_sha256: FACE_CONSENT_V1_SHA256,
    retention_summary: FACE_CONSENT_V1_RETENTION,
    // Sealing (API-CONTRACT O8) is not built: plain-v0 over TLS only.
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
      // DATA-MODEL §10 retention schedule (hourly; see ./retention.ts).
      deps.keeper?.register(faceRetentionTask(deps));
      const matchGate = faceMatchGate((userId) =>
        deps.rateLimit?.take('face-match', userId, FACE_MATCH_BUCKET),
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
        return matchGate(me.user_id, async () => {
          const body = await readBody(c, FaceMatchRequest);
          return c.json(await matchInRoom(deps, me.user_id, roomIdOf(c), body), 200);
        });
      });
    },
  };
}

const roomIdOf = (c: Context<AppEnv>): string => c.req.param('room_id') ?? '';

/** Runs one call per key at a time; a second concurrent call is 429 RATE_LIMITED (Retry-After 1). */
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
 * §1.7 face-match: one in flight per user, then the 30/min bucket. The token is taken inside the
 * guard, so a concurrent call refused with "One scan at a time" does not spend one; a call the
 * bucket refuses frees the guard like any other failure.
 */
export function faceMatchGate(take: (userId: string) => void) {
  const oneAtATime = oneInFlight();
  return <T>(userId: string, f: () => Promise<T>): Promise<T> =>
    oneAtATime(userId, async () => {
      take(userId);
      return f();
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
