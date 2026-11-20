// The face assignment on the recording phone (DANCE-OFF §3), orchestrated: one still of the
// camera when the framing check passes → faces → the two framed players' faces embedded with the
// face-match model → POST /v1/bets/:bet_id/dance/identify → A and B as people of the still's
// frame. Every native and network step is injected (the engine passes the pose view, the app the
// embedder and the API), so this runs in node tests.
//
// It never blocks the round and never fails it: the whole attempt is time-boxed
// (FACE_ID_TIMEOUT_MS), and anything that goes wrong (no still, no faces, faces not on the
// players, nobody enrolled, masks, a simulator build without the ML Kit detector, the network)
// resolves null, which means the left / right rule. The still is deleted and the embeddings are
// zeroed whatever happens; only embeddings ever leave the phone.
import { framingCheck } from '@youre-on/shared/dance/track';
import type { DanceIdentifyRequest, DanceIdentifyResponse } from '@youre-on/shared/api';

import type { StillResult } from '../../modules/dance-pose';
import type { FaceStill } from '../enroll/embedder';
import { plainEmbedding } from '../enroll/flow';
import { FACE_MODEL } from '../face/model';
import {
  associateFaces,
  facesToSend,
  normalizeBox,
  resolveIdentity,
  type IdentifyAssignment,
} from './model/faceId';
import type { IdentityFrame } from './model/identity';

/**
 * The whole attempt, still to answer. It was 2.5 s, when the round started the moment the
 * framing held; on a real device the first attempt also loads the face model, and no attempt
 * ever finished in time (the names stayed on fixed sides). The round now waits for a countdown,
 * so an attempt has the time it needs.
 */
export const FACE_ID_TIMEOUT_MS = 7_000;

/** What the app provides: the face embedder and the identify call for this bet. */
export interface DanceFaceId {
  /** Opens a still with the on-device face embedder (src/enroll/embedder FaceEmbedder.open). */
  open(uri: string): Promise<FaceStill>;
  /** Loads the face model ahead of the first attempt (the dance screen calls it on mount). */
  prewarm?: (() => Promise<void>) | undefined;
  /** POST /v1/bets/:bet_id/dance/identify. */
  identify(req: DanceIdentifyRequest): Promise<Pick<DanceIdentifyResponse, 'assignments'>>;
}

export interface FaceIdDeps extends DanceFaceId {
  captureStill(): Promise<StillResult>;
  /** The pose frame the still was taken from (model/identity frameAt). */
  frameAt(ts: number): IdentityFrame | null;
  /** Best-effort delete of the still's file. */
  deleteFile(uri: string): void;
  /** Image size of the pose frames (the framing check takes it). */
  size: { w: number; h: number };
}

export interface FaceIdResult {
  /** The still's frame (session ms). */
  ts: number;
  aPerson: number;
  bPerson: number;
}

/** Why an attempt ended without an identity (diagnostics only; every one means left / right). */
export type FaceIdMiss =
  'no_still' | 'no_frame' | 'framing' | 'faces' | 'unknown' | 'error' | 'timeout';

/** Resolves `p`, or `onTimeout` after `ms` (the inner work keeps running and cleans up). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(onTimeout), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(onTimeout);
      },
    );
  });
}

async function attempt(deps: FaceIdDeps): Promise<FaceIdResult | FaceIdMiss> {
  const shot = await deps.captureStill();
  if (!shot.ok) return 'no_still';
  let still: FaceStill | null = null;
  const vectors: Float32Array[] = [];
  try {
    const frame = deps.frameAt(shot.ts);
    if (!frame) return 'no_frame';
    const fr = framingCheck(frame.people, deps.size.w, deps.size.h);
    if (!fr.ok || fr.a === undefined || fr.b === undefined) return 'framing';
    still = await deps.open(shot.uri);
    const boxes = still.faces.map((f) => normalizeBox(f.bounds, still!));
    const owners = associateFaces(boxes, frame.people, still.width / still.height);
    const send = facesToSend(owners, { a: fr.a, b: fr.b });
    // Both players must be identified; one face cannot tell A from B on its own.
    if (send.length < 2) return 'faces';
    for (const s of send) vectors.push(await still.embed(still.faces[s.face]!));
    const res = await deps.identify({
      model: FACE_MODEL,
      faces: vectors.map((v) => ({ embedding: plainEmbedding(v) })),
    });
    const who = resolveIdentity(res.assignments as IdentifyAssignment[], send, {
      a: fr.a,
      b: fr.b,
    });
    return who ? { ts: frame.ts, ...who } : 'unknown';
  } finally {
    for (const v of vectors) v.fill(0);
    still?.close();
    try {
      deps.deleteFile(shot.uri);
    } catch {
      // the cache prune removes it later
    }
  }
}

/**
 * One face assignment attempt, time-boxed: the identity, or why not (never throws).
 */
export function identifyPlayers(
  deps: FaceIdDeps,
  timeoutMs: number = FACE_ID_TIMEOUT_MS,
): Promise<FaceIdResult | FaceIdMiss> {
  const run = Promise.resolve()
    .then(() => attempt(deps))
    .catch((): FaceIdMiss => 'error');
  return withTimeout<FaceIdResult | FaceIdMiss>(run, timeoutMs, 'timeout');
}

export const isFaceIdResult = (r: FaceIdResult | FaceIdMiss): r is FaceIdResult =>
  typeof r === 'object';

export const FACE_ID_RETRY = {
  /** Attempts per framing session (a run of the round engine). */
  MAX_TRIES: 8,
  /** Between two attempts (a new still each time: a turned head or a blink is not final). */
  GAP_MS: 1_000,
} as const;

/** Whether the engine may start a face attempt now. */
export function mayTryFaces(s: {
  enabled: boolean;
  framingOk: boolean;
  identified: boolean;
  inFlight: boolean;
  tries: number;
  lastTryAt: number | null;
  now: number;
}): boolean {
  if (!s.enabled || !s.framingOk || s.identified || s.inFlight) return false;
  if (s.tries >= FACE_ID_RETRY.MAX_TRIES) return false;
  return s.lastTryAt === null || s.now - s.lastTryAt >= FACE_ID_RETRY.GAP_MS;
}
