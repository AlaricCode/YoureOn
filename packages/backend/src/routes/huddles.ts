/**
 * Huddle / drafts / compiler / acceptance routes (§12.3):
 *  POST /huddles, POST /huddles/join, GET /huddles/:id, POST /huddles/:id/scan,
 *  DELETE /huddles/:id/members/:user_id,
 *  POST /bets/compile, GET|PATCH /drafts/:id, GET /drafts/:id/readback.mp3,
 *  GET /drafts/:id/questions/:qid/audio (question audio, see errata),
 *  GET /drafts/:id/accept/challenge, POST /drafts/:id/accept, POST /agent/session
 * The ElevenLabs compile tool webhook is wired through ctx.hooks.compileTool.
 */
import type { FastifyReply } from 'fastify';
import { ApiError } from '../errors.js';
import { decodeB64 } from '../drafts/service.js';
import type { DraftOverrides } from '../drafts/records.js';
import { identityHuddleServices } from '../huddles/services.js';
import { userView } from '../persistence/records.js';
import type { AudioBlob } from '../providers/types.js';
import { requestHints } from './identity.js';
import { badRequest, bodyObject, currentUser, optString, param, reqString, type RouteModule } from './util.js';
import { FailureCounter, RateLimiter } from '../util/rateLimit.js';

function sendAudio(reply: FastifyReply, a: AudioBlob): FastifyReply {
  return reply.header('content-type', a.mime).header('cache-control', 'private, max-age=300').send(Buffer.from(a.bytes));
}

function bbox(v: unknown, i: number): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4 || v.some((x) => !Number.isInteger(x) || x < 0 || x > 10000)) {
    throw badRequest(`faces[${i}].bbox must be 4 integers in 0..10000`);
  }
  const [x0, y0, x1, y1] = v as number[];
  if (x1! < x0! || y1! < y0!) throw badRequest(`faces[${i}].bbox is inverted`);
  return v as [number, number, number, number];
}

function parseOverrides(b: Record<string, unknown>): DraftOverrides {
  const o: DraftOverrides = {};
  if (b['stake_each_units'] !== undefined) {
    if (!Number.isSafeInteger(b['stake_each_units'])) throw new ApiError('BAD_STAKE');
    o.stake_each_units = b['stake_each_units'] as number;
  }
  if (b['time_limit_s'] !== undefined) {
    if (!Number.isSafeInteger(b['time_limit_s'])) throw badRequest('time_limit_s must be an integer');
    o.time_limit_s = b['time_limit_s'] as number;
  }
  if (b['participants'] !== undefined) {
    const p = b['participants'];
    if (!Array.isArray(p) || p.length > 10 || p.some((x) => typeof x !== 'string')) throw badRequest('participants must be user ids');
    o.participants = p as string[];
  }
  if (b['sides'] !== undefined) {
    const s = b['sides'];
    if (typeof s !== 'object' || s === null || Array.isArray(s) || Object.values(s).some((x) => x !== 0 && x !== 1)) {
      throw badRequest('sides must map user_id → 0|1');
    }
    o.sides = s as Record<string, 0 | 1>;
  }
  return o;
}

/** POST /huddles/join attempts per minute per user. */
export const JOIN_RATE = 10;
/** … and per IP (friends on one Wi-Fi share an address). */
export const JOIN_RATE_IP = 30;
/** Wrong codes per user per hour before RATE_LIMITED. */
export const JOIN_FAILURES = 20;

export const huddleRoutes: RouteModule = (app, ctx) => {
  const s = () => identityHuddleServices(ctx);
  // Eager wiring: WS snapshots and the Agent compile tool work before the first request.
  s();

  // ---- huddles -----------------------------------------------------------------

  app.post('/v1/huddles', async (req) => {
    const user = currentUser(ctx, req);
    const h = s().huddles.create(user.id);
    return { huddle_id: h.id, code: h.code };
  });

  // Code enumeration guard: ≤ JOIN_RATE attempts/min per user and per IP, and
  // ≤ JOIN_FAILURES wrong codes/hour per user (10^6 codes cannot be swept).
  const joinByUser = new RateLimiter(ctx.clock, JOIN_RATE, 60_000);
  const joinByIp = new RateLimiter(ctx.clock, JOIN_RATE_IP, 60_000);
  const joinFailures = new FailureCounter(ctx.clock, JOIN_FAILURES, 3_600_000);
  app.post('/v1/huddles/join', async (req) => {
    const user = currentUser(ctx, req);
    if (joinFailures.blocked(user.id) || !joinByUser.hit(user.id) || !joinByIp.hit(req.ip)) throw new ApiError('RATE_LIMITED');
    const { huddles } = s();
    try {
      return huddles.view(huddles.join(user.id, bodyObject(req)['code']));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CODE_INVALID') joinFailures.fail(user.id);
      throw e;
    }
  });

  app.get('/v1/huddles/:id', async (req) => {
    const user = currentUser(ctx, req);
    const { huddles } = s();
    return huddles.view(huddles.requireForMember(param(req, 'id'), user.id));
  });

  app.post('/v1/huddles/:id/scan', async (req) => {
    const user = currentUser(ctx, req);
    const { huddles, identity } = s();
    const h = huddles.requireForMember(param(req, 'id'), user.id);
    if (h.creator_user_id !== user.id) throw new ApiError('WRONG_STATE', 'only the creator scans');
    const faces = bodyObject(req)['faces'];
    if (!Array.isArray(faces) || faces.length === 0) throw badRequest('faces must be a non-empty array');
    const parsed = faces.map((f, i) => {
      if (typeof f !== 'object' || f === null) throw badRequest(`faces[${i}] must be an object`);
      const o = f as Record<string, unknown>;
      return { crop: decodeB64(o['crop_b64'], `faces[${i}].crop_b64`), bbox: bbox(o['bbox'], i) };
    });
    const results = await identity.scanHuddle(h, parsed);
    huddles.confirm(
      h.id,
      results.filter((r) => r.matched && r.user).map((r) => ({ user_id: r.user!.id, cos_bps: r.cos_bps })),
    );
    return { matches: results.map((r) => ({ bbox: r.bbox, user: r.user ? userView(r.user) : null, cos_bps: r.cos_bps, matched: r.matched })) };
  });

  app.delete('/v1/huddles/:id/members/:user_id', async (req) => {
    const user = currentUser(ctx, req);
    const { huddles } = s();
    return huddles.view(huddles.removeMember(param(req, 'id'), user.id, param(req, 'user_id')));
  });

  // ---- drafts ------------------------------------------------------------------

  app.post('/v1/bets/compile', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    const answersRaw = b['answers'];
    let answers: { question_id: string; answer: string }[] | undefined;
    if (answersRaw !== undefined) {
      if (!Array.isArray(answersRaw)) throw badRequest('answers must be an array');
      answers = answersRaw.map((a, i) => {
        const o = (a ?? {}) as Record<string, unknown>;
        if (typeof o['question_id'] !== 'string' || typeof o['answer'] !== 'string' || o['answer'].length > 500) {
          throw badRequest(`answers[${i}] must be {question_id, answer}`);
        }
        return { question_id: o['question_id'], answer: o['answer'] };
      });
    }
    const transcript = optString(b, 'transcript', 8000);
    const draftId = optString(b, 'draft_id', 64);
    return s().drafts.compile(
      user,
      {
        huddle_id: reqString(b, 'huddle_id', 64),
        ...(transcript !== undefined ? { transcript } : {}),
        ...(b['audio_b64'] !== undefined && b['audio_b64'] !== null ? { audio: decodeB64(b['audio_b64'], 'audio_b64') } : {}),
        ...(draftId !== undefined ? { draft_id: draftId } : {}),
        ...(answers ? { answers } : {}),
      },
      requestHints(req),
    );
  });

  app.get('/v1/drafts/:id', async (req) => {
    const user = currentUser(ctx, req);
    const { drafts } = s();
    return drafts.view(drafts.requireDraft(param(req, 'id'), user.id).d);
  });

  app.patch('/v1/drafts/:id', async (req) => {
    const user = currentUser(ctx, req);
    return s().drafts.patch(user, param(req, 'id'), parseOverrides(bodyObject(req)));
  });

  app.get('/v1/drafts/:id/readback.mp3', async (req, reply) => {
    const user = currentUser(ctx, req);
    return sendAudio(reply, await s().drafts.readbackAudio(user, param(req, 'id')));
  });

  app.get('/v1/drafts/:id/questions/:qid/audio', async (req, reply) => {
    const user = currentUser(ctx, req);
    return sendAudio(reply, await s().drafts.questionAudio(user, param(req, 'id'), param(req, 'qid')));
  });

  app.get('/v1/drafts/:id/accept/challenge', async (req) => {
    const user = currentUser(ctx, req);
    return s().drafts.acceptChallenge(user, param(req, 'id'));
  });

  app.post('/v1/drafts/:id/accept', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return s().drafts.accept(
      user,
      param(req, 'id'),
      { challenge_id: b['challenge_id'], audio: decodeB64(b['audio_b64'], 'audio_b64'), accept_sig: decodeB64(b['accept_sig_b64'], 'accept_sig_b64') },
      requestHints(req),
    );
  });

  app.post('/v1/agent/session', async (req) => {
    const user = currentUser(ctx, req);
    const b = bodyObject(req);
    return s().drafts.agentSession(user, reqString(b, 'huddle_id', 64), optString(b, 'draft_id', 64) ?? null);
  });
};
