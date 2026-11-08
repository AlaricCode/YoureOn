/**
 * Bet-lifecycle routes (§12.3): scene check, calibration, fund, witnesses,
 * start (+ beacon/start-sound downloads for the WS `start` message), chunk
 * hash records and bodies, end, consent and dispute. Services live in
 * src/lifecycle/.
 */
import { BET_STATE } from '@verdict/engine';
import type { FastifyReply } from 'fastify';
import { ApiError } from '../errors.js';
import { chainBet, loadBetInfo, requireMember, requireState } from '../lifecycle/betInfo.js';
import { parseChunkPost, registerChunk, storeChunkBody } from '../lifecycle/evidence.js';
import { beaconBlobKey, BLOB_NS_START, registerWitness, sfxBlobKey, startBet, witnessList } from '../lifecycle/live.js';
import { validateCalibration } from '../lifecycle/scene.js';
import { lifecycleService } from '../lifecycle/service.js';
import { consentSign, disputeSign, fundSign } from '../lifecycle/userTx.js';
import { COLLECTIONS } from '../persistence/records.js';
import { isPubkey } from '../util/bytes.js';
import { badRequest, bodyObject, currentUser, param, reqBase64, reqInt, reqString, type RouteModule } from './util.js';

/** Max scene crop size (JPEG). */
const MAX_CROP_BYTES = 2 * 1024 * 1024;

function rawBody(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  throw badRequest('expected a raw body (application/octet-stream / image/jpeg)');
}

function betIdParam(req: Parameters<typeof param>[0]): string {
  const id = param(req, 'id');
  if (!isPubkey(id)) throw new ApiError('NOT_FOUND', `bet ${id}`);
  return id;
}

function sendBytes(reply: FastifyReply, bytes: Uint8Array, type: string): FastifyReply {
  return reply.header('content-type', type).header('cache-control', 'no-store').send(Buffer.from(bytes));
}

export const lifecycleRoutes: RouteModule = (app, ctx) => {
  const svc = lifecycleService(ctx);
  svc.register();
  const { s } = svc;

  // ---- scene check (§5.2, §12.10) ---------------------------------------------------

  app.post('/v1/bets/:id/scene/detect', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    requireMember(ctx, info, user);
    const jpeg = reqBase64(bodyObject(req), 'frame_b64');
    if (jpeg.length === 0) throw badRequest('frame_b64 is empty');
    return svc.scene.detectOnce(info, jpeg);
  });

  app.put('/v1/bets/:id/scene/crops/:entity', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    if (user.id !== info.creator_user_id) throw new ApiError('WRONG_STATE', 'only the creator edits the scene');
    const entity = param(req, 'entity');
    const ent = info.program.entities.find((e) => e.name === entity);
    if (!ent || ent.kind === 'region') throw new ApiError('NOT_FOUND', `entity ${entity}`);
    const body = rawBody(req.body);
    if (body.length === 0 || body.length > MAX_CROP_BYTES) throw badRequest('crop must be a JPEG ≤ 2 MiB');
    const crop_sha256 = ctx.blobs.putBlob('crops', `${info.id}-${entity}`, body);
    const now = ctx.clock.nowMs();
    const scene = s.scenes.get(info.id) ?? { bet: info.id, calibration: null, calibration_hash: null, crops: {}, updated_at_ms: now };
    s.scenes.set(info.id, { ...scene, crops: { ...scene.crops, [entity]: crop_sha256 }, updated_at_ms: now });
    return { crop_sha256 };
  });

  app.put('/v1/bets/:id/calibration', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    if (user.id !== info.creator_user_id) throw new ApiError('WRONG_STATE', 'only the creator calibrates');
    const bet = await chainBet(ctx, info.id);
    if (bet.funded_mask !== 0 || bet.state !== BET_STATE.Proposed) throw new ApiError('CALIBRATION_LOCKED');
    const { calibration, calibration_hash } = validateCalibration(info.program, req.body);
    const now = ctx.clock.nowMs();
    const prev = s.scenes.get(info.id);
    s.scenes.set(info.id, { bet: info.id, calibration, calibration_hash, crops: prev?.crops ?? {}, updated_at_ms: now });
    // Mirror into the shared bets record (BetView shows calibration + hash, §12.2).
    const mirror = ctx.store.collection<Record<string, unknown>>(COLLECTIONS.bets);
    if (mirror.has(info.id)) mirror.update(info.id, (r) => ({ ...r, calibration, calibration_hash }));
    return { calibration, calibration_hash };
  });

  // ---- fund (§9.4 #3) ------------------------------------------------------------------

  app.post('/v1/bets/:id/fund', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    return fundSign(ctx, s, info, user);
  });

  // ---- witnesses + start (§7.1, §7.5) ------------------------------------------------

  app.post('/v1/bets/:id/witnesses', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    const b = bodyObject(req);
    const kind = reqString(b, 'kind', 16);
    if (kind !== 'camera' && kind !== 'audio' && kind !== 'detections') throw badRequest('kind must be camera|audio|detections');
    return svc.lock.run(info.id, () => registerWitness(ctx, s, info, user, reqString(b, 'witness_key', 64), kind));
  });

  app.post('/v1/bets/:id/start', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    await svc.lock.run(info.id, () => startBet(ctx, s, info, user));
    svc.scene.clear(info.id);
    return { ok: true };
  });

  app.get('/v1/bets/:id/beacon.wav', async (req, reply) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    requireMember(ctx, info, user);
    const wav = ctx.blobs.getBlob(BLOB_NS_START, beaconBlobKey(info.id));
    if (!wav) throw new ApiError('NOT_FOUND', 'beacon not generated yet');
    return sendBytes(reply, wav, 'audio/wav');
  });

  app.get('/v1/bets/:id/start-sound', async (req, reply) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    requireMember(ctx, info, user);
    const sfx = ctx.blobs.getBlob(BLOB_NS_START, sfxBlobKey(info.id));
    if (!sfx) throw new ApiError('NOT_FOUND', 'start sound not generated yet');
    const isWav = sfx.length >= 4 && Buffer.from(sfx.subarray(0, 4)).toString('ascii') === 'RIFF';
    return sendBytes(reply, sfx, isWav ? 'audio/wav' : 'audio/mpeg');
  });

  // ---- evidence (§7.2–§7.5) ------------------------------------------------------------

  app.post('/v1/bets/:id/chunks', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    const post = parseChunkPost(req.body);
    const cam = s.scenes.get(info.id)?.calibration?.scene.camera ?? null;
    const rec = await svc.lock.run(`chunks:${info.id}:${post.witness_key}`, () => registerChunk(ctx, s, info, user, post, cam));
    if (rec.final) await svc.onWitnessFinal(info);
    return {
      accepted: true,
      upload_url: `${ctx.config.publicUrl}/v1/bets/${info.id}/chunks/${rec.witness_key}/${rec.index}`,
    };
  });

  app.put('/v1/bets/:id/chunks/:witness_key/:index', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    const witness = param(req, 'witness_key');
    const index = Number(param(req, 'index'));
    if (!isPubkey(witness) || !Number.isSafeInteger(index) || index < 0) throw new ApiError('NOT_FOUND', 'chunk');
    const rec = storeChunkBody(ctx, s, info, user, witness, index, rawBody(req.body));
    if (rec.kind === 1) await svc.onAudioBody(info, witness);
    return { stored: true };
  });

  app.get('/v1/bets/:id/chunks/:witness_key/:index', async (req, reply) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    requireMember(ctx, info, user);
    const witness = param(req, 'witness_key');
    const index = Number(param(req, 'index'));
    if (!isPubkey(witness) || !Number.isSafeInteger(index) || index < 0) throw new ApiError('NOT_FOUND', 'chunk');
    if (!witnessList(s, info.id).witnesses.some((w) => w.witness_key === witness)) throw new ApiError('NOT_FOUND', 'witness');
    const body = ctx.blobs.getChunk(info.id, witness, index);
    if (!body) throw new ApiError('NOT_FOUND', 'chunk body');
    return sendBytes(reply, body, 'application/octet-stream');
  });

  app.post('/v1/bets/:id/end', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    await svc.requestEnd(info, user);
    return { ok: true };
  });

  // ---- pre-ruling responses (§9.4 #10, #11) --------------------------------------------

  app.post('/v1/bets/:id/consent', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    return consentSign(ctx, info, user);
  });

  app.post('/v1/bets/:id/dispute', async (req) => {
    const user = currentUser(ctx, req);
    const info = loadBetInfo(ctx, betIdParam(req));
    const reason = reqInt(bodyObject(req), 'reason', 1, 4);
    const bet = await chainBet(ctx, info.id);
    requireState(bet, BET_STATE.PreRuled);
    return disputeSign(ctx, info, user, reason);
  });
};
