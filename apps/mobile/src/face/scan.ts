// Beat 1, challenge by face (TASKS D4-M1; ARCHITECTURE §3.1; API-CONTRACT §2.4): one still →
// the biggest face in it → embedding → POST /v1/rooms/:room_id/face-match → "Challenge Jake?".
//
// Only the embedding leaves the phone, never the photo, and the server keeps nothing from a scan.
// No confident match shows nothing about anyone: the screen only says "No match". Pure logic
// here (tested in node); the camera and the model are passed in.
import type { FaceMatchRequest, FaceMatchResponse } from '@youre-on/shared/face';

import type { DetectedFace } from '../enroll/flow';
import { plainEmbedding } from '../enroll/flow';
import { FACE_MODEL, l2NormalizeInPlace } from './model';

/**
 * A face must fill at least this share of the photo's width. The scan stands at about 1 m
 * (ARCHITECTURE §3.1), where a face is roughly a tenth of a 4:3 frame; any smaller and the crop
 * is too blurry to match.
 */
export const MIN_SCAN_FACE_SHARE = 0.08;

export type ScanProblem = 'no_face' | 'too_far' | 'no_match' | 'failed';

export const SCAN_PROBLEM_LABEL: Readonly<Record<ScanProblem, string>> = {
  no_face: 'No face found',
  too_far: 'Move closer',
  no_match: 'No match',
  failed: 'Try again',
};

/** The biggest face in the still (the person the phone is pointed at), or why there is none. */
export function pickScanFace<F extends DetectedFace>(
  faces: readonly F[],
): { ok: true; face: F } | { ok: false; problem: ScanProblem } {
  if (faces.length === 0) return { ok: false, problem: 'no_face' };
  let best = faces[0] as F;
  for (const f of faces) {
    if (f.bounds.width * f.bounds.height > best.bounds.width * best.bounds.height) best = f;
  }
  if (best.frameWidth > 0 && best.bounds.width / best.frameWidth < MIN_SCAN_FACE_SHARE) {
    return { ok: false, problem: 'too_far' };
  }
  return { ok: true, face: best };
}

/** The face-match request for one normalised probe (plain-v0 while sealing is not built). */
export function buildFaceMatchRequest(
  probe: Float32Array,
  face: DetectedFace,
  capturedAt: Date,
): FaceMatchRequest {
  return {
    probe: plainEmbedding(probe),
    model: { name: FACE_MODEL.name, version: FACE_MODEL.version, dim: FACE_MODEL.dim },
    capture: {
      captured_at: capturedAt.toISOString(),
      eye_distance_px: null,
      yaw_deg: Number.isFinite(face.yawAngle) ? Math.max(-90, Math.min(90, face.yawAngle)) : null,
    },
  };
}

/** What a scan found: someone to challenge (with the 60 s ticket), or a fix-it line. */
export type ScanOutcome =
  | {
      kind: 'match';
      user: { user_id: string; display_name: string };
      matchTicket: string;
      headToHead: { wins: number; losses: number; net: string };
    }
  | { kind: 'problem'; problem: ScanProblem; label: string };

const problem = (p: ScanProblem): ScanOutcome => ({
  kind: 'problem',
  problem: p,
  label: SCAN_PROBLEM_LABEL[p],
});

export interface FaceScannerDeps<F extends DetectedFace> {
  /** On-device detection on the still (react-native-vision-camera-face-detector). */
  detect: (photoUrl: string) => readonly F[] | Promise<readonly F[]>;
  /** The embedding for one face (enroll/embedder.ts createModelEmbedder, unit length). */
  embed: (photoUrl: string, face: F) => Promise<Float32Array>;
  /** POST /v1/rooms/:room_id/face-match (net/api.ts faceMatch, bound to the room). */
  match: (req: FaceMatchRequest) => Promise<FaceMatchResponse>;
  now?: () => Date;
}

/** One scan of one still. Never throws: every failure is a fix-it line for the screen. */
export function createFaceScanner<F extends DetectedFace>(deps: FaceScannerDeps<F>) {
  return async (photoUrl: string): Promise<ScanOutcome> => {
    try {
      const picked = pickScanFace(await deps.detect(photoUrl));
      if (!picked.ok) return problem(picked.problem);
      const v = await deps.embed(photoUrl, picked.face);
      l2NormalizeInPlace(v); // already unit length from the embedder; cheap insurance
      const res = await deps.match(
        buildFaceMatchRequest(v, picked.face, (deps.now ?? (() => new Date()))()),
      );
      v.fill(0);
      if (!res.match) return problem('no_match');
      return {
        kind: 'match',
        user: { user_id: res.match.user.user_id, display_name: res.match.user.display_name },
        matchTicket: res.match.match_ticket,
        headToHead: {
          wins: res.match.head_to_head.wins,
          losses: res.match.head_to_head.losses,
          net: res.match.head_to_head.net,
        },
      };
    } catch {
      return problem('failed');
    }
  };
}
