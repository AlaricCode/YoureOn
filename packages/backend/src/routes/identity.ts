/**
 * Identity / enroll / pay routes (§12.3, §8):
 *  GET  /enroll/challenge, POST /enroll/face, POST /enroll/voice,
 *  POST /enroll/complete, DELETE /enroll,
 *  GET  /pay/challenge, POST /pay/scan, POST /pay/voice, POST /pay
 */
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { identityHuddleServices } from '../huddles/services.js';
import type { RequestHints } from '../identity/service.js';
import { badRequest, bodyObject, currentUser, reqBase64, type RouteModule } from './util.js';
import { fromBase64 } from '../util/bytes.js';

function header(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s !== '' ? s : null;
}

/** Mock-only request hints (ignored by real providers). */
export function requestHints(req: FastifyRequest): RequestHints {
  return { mockSubject: header(req, 'x-mock-subject'), mockTranscript: header(req, 'x-mock-transcript') };
}

export function b64List(o: Record<string, unknown>, k: string, min: number, max: number): Uint8Array[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length < min || v.length > max) throw badRequest(`${k} must have ${min}..${max} items`);
  return v.map((x, i) => {
    if (typeof x !== 'string') throw badRequest(`${k}[${i}] must be base64`);
    try {
      return fromBase64(x);
    } catch {
      throw badRequest(`${k}[${i}] must be base64`);
    }
  });
}

export const identityRoutes: RouteModule = (app, ctx) => {
  const svc = () => identityHuddleServices(ctx).identity;

  app.get('/v1/enroll/challenge', async (req) => svc().enrollChallenge(currentUser(ctx, req)));

  app.post('/v1/enroll/face', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return svc().enrollFace(user, b['challenge_id'], b64List(b, 'frames_b64', 3, 5), requestHints(req));
  });

  app.post('/v1/enroll/voice', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return svc().enrollVoice(user, b['challenge_id'], b64List(b, 'clips_b64', 3, 3), requestHints(req));
  });

  app.post('/v1/enroll/complete', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return svc().completeEnrollment(user, b['consent'], b['display_name']);
  });

  app.delete('/v1/enroll', async (req) => svc().deleteEnrollment(currentUser(ctx, req)));

  app.get('/v1/pay/challenge', async (req) => svc().payChallenge(currentUser(ctx, req)));

  app.post('/v1/pay/scan', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return svc().payScan(user, b['challenge_id'], b64List(b, 'faces_b64', 2, 2), requestHints(req));
  });

  app.post('/v1/pay/voice', async (req) => {
    const user = currentUser(ctx, req);
    return svc().payVoice(user, reqBase64(bodyObject(req), 'audio_b64'), requestHints(req));
  });

  app.post('/v1/pay', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    if (b['to_user_id'] === undefined) throw new ApiError('WRONG_STATE', 'to_user_id required', 400);
    return svc().pay(user, b['to_user_id'], b['amount_units']);
  });
};
