// Face enrollment and face match (TASKS D3-M3, D4-M1):
//   GET    /v1/face/consent                 (B)          -> FaceConsentResponse
//   POST   /v1/face/enrollment              (S)          -> 201 {status:'active', enrolled_at}
//   PATCH  /v1/face/enrollment              (S)          -> 200 {status}
//   DELETE /v1/face/enrollment              (S)          -> 204 (also when nothing was enrolled)
//   POST   /v1/rooms/:room_id/face-match    (S, member)  -> {match: {...} | null}
//   GET    /v1/me                           (B)          -> MeResponse (§2.1; the face settings
//                                                          page reads face.status from it)
//
// Biometric rules (DATA-MODEL §10, API-CONTRACT §2.2, §2.4):
//  - Embeddings only, never images. At rest: AES-256-GCM with the KEK (./crypto.ts).
//  - A probe lives in memory for one request: no row, no log, no cache. No score is returned.
//  - "No confident match" returns {match:null} and stores nothing.
//  - audit_log rows carry no vector, ciphertext or nonce (a CHECK enforces it).
//  - Request bodies on these routes are never logged (the app logs no bodies at all).
import { and, eq, isNull, sql } from 'drizzle-orm';
import { auditLog, devices, faceEnrollments, users } from '@youre-on/db';
import { REQUEST_CLOCK_SKEW_MS } from '@youre-on/shared/api';
import {
  ACCEPTED_FACE_MODELS,
  decideFaceMatch,
  FACE_CONSENT_V1,
  FACE_CONSENT_V1_SHA256,
  FaceEnrollmentPatch,
  FaceEnrollmentRequest,
  FaceMatchRequest,
  isAcceptedModel,
  type FaceConsentResponse,
  type FaceEnrollmentResponse,
  type FaceMatchResponse,
  type MeResponse,
} from '@youre-on/shared/face';

import type { RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireAppSession, requireSignedRequest } from '../auth/middleware';
import { userRef } from '../auth/common';
import { configureMatchTicketSecret, issueMatchTicket } from '../bets/match-ticket';
import { assertRoomLive, getRoomOr404, isActiveMember } from '../rooms/service';
import { keyringFrom, openAtRest, sealAtRest } from './crypto';
import { openEmbedding } from './probe';
import { faceStatusOf, headToHead, roomCandidates } from './service';

/** Face match: 30 scans a minute per user is plenty for a demo and stops a brute-force sweep. */
const FACE_MATCH_BUCKET = { limit: 30, windowMs: 60_000 };
/** Enrollment writes: a handful per minute. */
const FACE_WRITE_BUCKET = { limit: 10, windowMs: 60_000 };

export const faceRoutes: RouteModule = {
  name: 'face',
  register(app, deps) {
    configureMatchTicketSecret(deps.env.MATCH_TICKET_SECRET);

    app.get('/v1/me', requireAppSession, async (c) => {
      const me = appAuth(c);
      const [u] = await deps.db
        .select({
          id: users.id,
          wallet_pubkey: users.wallet_pubkey,
          display_name: users.display_name,
          age: users.age_attested_18plus,
        })
        .from(users)
        .where(eq(users.id, me.user_id))
        .limit(1);
      if (!u) throw new HttpError('NOT_FOUND', 'No such user.');
      const devs = await deps.db
        .select({
          device_id: devices.id,
          role: devices.role,
          app_version: devices.app_version,
          last_seen_at: devices.last_seen_at,
        })
        .from(devices)
        .where(and(eq(devices.user_id, me.user_id), isNull(devices.revoked_at)));
      const out: MeResponse = {
        user: userRef(u),
        age_attested_18plus: u.age,
        face: await faceStatusOf(deps.db, me.user_id),
        devices: devs.map((d) => ({
          device_id: d.device_id,
          role: d.role,
          app_version: d.app_version,
          last_seen_at: d.last_seen_at.toISOString(),
        })),
      };
      return c.json(out, 200);
    });

    app.get('/v1/face/consent', requireAppSession, (c) => {
      const out: FaceConsentResponse = {
        consent_version: FACE_CONSENT_V1.consent_version,
        text: FACE_CONSENT_V1.text,
        text_sha256: FACE_CONSENT_V1_SHA256,
        retention_summary: FACE_CONSENT_V1.retention_summary,
        face_seal_pubkey: null, // plain-v0 only for now (./probe.ts)
        accepted_models: [...ACCEPTED_FACE_MODELS],
      };
      return c.json(out, 200);
    });

    app.post('/v1/face/enrollment', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      deps.rateLimit?.take('face/write', me.user_id, FACE_WRITE_BUCKET);
      const body = await readBody(c, FaceEnrollmentRequest);
      const now = deps.now();

      // Consent before capture (DATA-MODEL §10): the exact text this server serves.
      const consentAt = Date.parse(body.consent.consent_at);
      if (
        body.consent.consent_version !== FACE_CONSENT_V1.consent_version ||
        body.consent.consent_text_sha256 !== FACE_CONSENT_V1_SHA256 ||
        consentAt > now + REQUEST_CLOCK_SKEW_MS
      ) {
        throw new HttpError('FACE_CONSENT_REQUIRED', 'Agree to the current consent first.');
      }
      if (!isAcceptedModel(body.model)) {
        throw new HttpError('FACE_MODEL_UNSUPPORTED', 'Update the app to enroll.', {
          accepted_models: ACCEPTED_FACE_MODELS,
        });
      }
      const vector = openEmbedding(deps.env, body.embedding, body.model);
      const ring = keyringFrom(deps.env);
      const sealed = sealAtRest(ring, me.user_id, body.model, vector);
      vector.fill(0);

      const created = new Date(now);
      // The phone's clock may run a little ahead: never store consent after creation.
      const consentStored = new Date(Math.min(consentAt, now));
      const passedAt = new Date(Math.min(Date.parse(body.liveness.passed_at), now));
      const requestId = c.get('requestId');
      await deps.db.transaction(async (tx) => {
        await tx.insert(auditLog).values({
          actor_kind: 'user',
          actor_user_id: me.user_id,
          subject_user_id: me.user_id,
          action: 'face.consented',
          request_id: requestId,
          details: {
            consent_version: body.consent.consent_version,
            consent_text_sha256: body.consent.consent_text_sha256,
          },
        });
        await tx.delete(faceEnrollments).where(eq(faceEnrollments.user_id, me.user_id));
        await tx.insert(faceEnrollments).values({
          user_id: me.user_id,
          status: 'active',
          ...sealed,
          embedding_dim: body.model.dim,
          model_name: body.model.name,
          model_version: body.model.version,
          consent_version: body.consent.consent_version,
          consent_text_sha256: body.consent.consent_text_sha256,
          consent_at: consentStored,
          liveness_method: body.liveness.method,
          liveness_passed_at: passedAt,
          created_at: created,
        });
        await tx.insert(auditLog).values({
          actor_kind: 'user',
          actor_user_id: me.user_id,
          subject_user_id: me.user_id,
          action: 'face.enrolled',
          request_id: requestId,
          details: {
            model_name: body.model.name,
            model_version: body.model.version,
            liveness_method: body.liveness.method,
            shots: body.shots,
          },
        });
      });
      const out: FaceEnrollmentResponse = { status: 'active', enrolled_at: created.toISOString() };
      return c.json(out, 201);
    });

    app.patch('/v1/face/enrollment', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      deps.rateLimit?.take('face/write', me.user_id, FACE_WRITE_BUCKET);
      const body = await readBody(c, FaceEnrollmentPatch);
      const now = new Date(deps.now());
      const updated = await deps.db
        .update(faceEnrollments)
        .set(
          body.status === 'disabled'
            ? { status: 'disabled', disabled_at: now }
            : { status: 'active', disabled_at: null },
        )
        .where(eq(faceEnrollments.user_id, me.user_id))
        .returning({ id: faceEnrollments.id });
      if (updated.length === 0) throw new HttpError('FACE_NOT_ENROLLED', 'No face is saved.');
      await deps.db.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: me.user_id,
        subject_user_id: me.user_id,
        action: body.status === 'disabled' ? 'face.disabled' : 'face.enabled',
        request_id: c.get('requestId'),
      });
      return c.json({ status: body.status }, 200);
    });

    app.delete('/v1/face/enrollment', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      const gone = await deps.db
        .delete(faceEnrollments)
        .where(eq(faceEnrollments.user_id, me.user_id))
        .returning({
          model_name: faceEnrollments.model_name,
          model_version: faceEnrollments.model_version,
          created_at: faceEnrollments.created_at,
        });
      const row = gone[0];
      if (row) {
        await deps.db.insert(auditLog).values({
          actor_kind: 'user',
          actor_user_id: me.user_id,
          subject_user_id: me.user_id,
          action: 'face.deleted',
          request_id: c.get('requestId'),
          details: {
            reason: 'user',
            model_name: row.model_name,
            model_version: row.model_version,
            enrolled_at: row.created_at.toISOString(),
          },
        });
      }
      return c.body(null, 204);
    });

    app.post('/v1/rooms/:room_id/face-match', requireSignedRequest, async (c) => {
      const me = appAuth(c);
      deps.rateLimit?.take('face/match', me.user_id, FACE_MATCH_BUCKET);
      const body = await readBody(c, FaceMatchRequest);
      const now = deps.now();
      const room = await getRoomOr404(deps.db, c.req.param('room_id'));
      if (!(await isActiveMember(deps.db, room.id, me.user_id))) {
        throw new HttpError('NOT_IN_ROOM', 'Join the room first.');
      }
      assertRoomLive(room, now);
      if (!isAcceptedModel(body.model)) {
        throw new HttpError('FACE_MODEL_UNSUPPORTED', 'Update the app to scan.', {
          accepted_models: ACCEPTED_FACE_MODELS,
        });
      }
      const probe = openEmbedding(deps.env, body.probe, body.model);
      try {
        const rows = await roomCandidates(deps.db, room.id, me.user_id, body.model, now);
        let matchId: string | null = null;
        if (rows.length > 0) {
          const ring = keyringFrom(deps.env);
          const candidates: { id: string; embedding: Float32Array }[] = [];
          for (const r of rows) {
            const e = openAtRest(ring, r.user_id, body.model, r);
            // A row that no longer opens (rotated key, tampered) is skipped, never logged.
            if (e) candidates.push({ id: r.user_id, embedding: e });
          }
          matchId = decideFaceMatch(probe, candidates);
          for (const cand of candidates) cand.embedding.fill(0);
        }
        if (!matchId) {
          const none: FaceMatchResponse = { match: null };
          return c.json(none, 200);
        }
        await deps.db
          .update(faceEnrollments)
          .set({ last_used_at: sql`date_trunc('day', now())` })
          .where(and(eq(faceEnrollments.user_id, matchId)));
        const [u] = await deps.db
          .select({
            id: users.id,
            wallet_pubkey: users.wallet_pubkey,
            display_name: users.display_name,
          })
          .from(users)
          .where(eq(users.id, matchId))
          .limit(1);
        if (!u) {
          const none: FaceMatchResponse = { match: null };
          return c.json(none, 200);
        }
        const t = issueMatchTicket({
          scanner_user_id: me.user_id,
          candidate_user_id: matchId,
          room_id: room.id,
          now_ms: now,
        });
        const out: FaceMatchResponse = {
          match: {
            user: userRef(u),
            match_ticket: t.ticket,
            ticket_expires_at: new Date(t.expires_at_ms).toISOString(),
            head_to_head: await headToHead(deps.db, me.user_id, matchId),
          },
        };
        return c.json(out, 200);
      } finally {
        probe.fill(0);
      }
    });
  },
};
