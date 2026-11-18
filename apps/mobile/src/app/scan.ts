// Beat 1 on A's phone: "point the camera at a friend" (TASKS D4-M1; ARCHITECTURE §3.1). Pure TS:
// the scan screen's state machine, the scan itself (photo -> embedding -> POST face-match) and the
// challenge-error mapping, with the camera, model and network injected, so vitest runs it all.
//
// A match only ADDRESSES the challenge: the card names the person ("Challenge Jake?"), the tap
// sends POST /v1/bets with challenge_method 'face' and the 60 s match ticket, and Jake still
// reviews and authorizes his own stake on his own phone. No confident match shows nothing but a
// "No match" line and the room list (the face_pick_list fallback), and the server stores
// nothing. The photo itself never leaves the phone (the screen deletes it after the scan).
import type { FaceMatchRequest, FaceMatchResponse } from '@youre-on/shared/face';

import type { FaceEmbedder, FaceStill } from '../enroll/embedder';
import { plainEmbedding } from '../enroll/flow';
import { FACE_MODEL } from '../face/model';
import { eyeDistance, pickProbeFace } from '../face/pipeline';

export interface ScanMatch {
  readonly user: { readonly user_id: string; readonly display_name: string };
  readonly ticket: string;
  /** Server clock (ms) at which the ticket stops addressing a challenge. */
  readonly expiresAtMs: number;
  readonly headToHead: { readonly wins: number; readonly losses: number; readonly net: string };
}

/** Why a scan (or the challenge after it) found nobody to address. */
export type ScanMiss =
  'no_face' | 'too_far' | 'no_match' | 'expired' | 'not_in_room' | 'busy' | 'pair_busy' | 'failed';

export type ScanOutcome =
  | { readonly kind: 'found'; readonly match: ScanMatch }
  | { readonly kind: 'miss'; readonly miss: ScanMiss };

// ---------------------------------------------------------------------------------------
// The screen's state machine
// ---------------------------------------------------------------------------------------

export interface ScanState {
  /** idle: camera live, shutter ready. checking: a scan is running. found: the match card.
   *  challenging: "Challenge" was tapped and POST /v1/bets is in flight. */
  readonly phase: 'idle' | 'checking' | 'found' | 'challenging';
  readonly match: ScanMatch | null;
  /** The last miss, shown as a red line until the next scan. */
  readonly miss: ScanMiss | null;
  /** Misses in a row since the last match. */
  readonly misses: number;
}

export type ScanEvent =
  | { readonly type: 'scan' }
  | { readonly type: 'result'; readonly outcome: ScanOutcome }
  | { readonly type: 'not_them' }
  | { readonly type: 'challenge' }
  | { readonly type: 'challenge_failed'; readonly miss: ScanMiss }
  | { readonly type: 'reset' };

export const initialScan: ScanState = { phase: 'idle', match: null, miss: null, misses: 0 };

export function scanReducer(s: ScanState, e: ScanEvent): ScanState {
  switch (e.type) {
    case 'scan':
      // One scan at a time (the server also allows only one in flight); a new scan from the
      // match card drops the card.
      return s.phase === 'idle' || s.phase === 'found'
        ? { ...s, phase: 'checking', match: null, miss: null }
        : s;
    case 'result':
      if (s.phase !== 'checking') return s; // stale (the screen moved on)
      return e.outcome.kind === 'found'
        ? { phase: 'found', match: e.outcome.match, miss: null, misses: 0 }
        : { phase: 'idle', match: null, miss: e.outcome.miss, misses: s.misses + 1 };
    case 'not_them':
      return s.phase === 'found' ? { ...s, phase: 'idle', match: null, miss: null } : s;
    case 'challenge':
      return s.phase === 'found' ? { ...s, phase: 'challenging' } : s;
    case 'challenge_failed':
      return s.phase === 'challenging'
        ? { phase: 'idle', match: null, miss: e.miss, misses: s.misses + 1 }
        : s;
    case 'reset':
      return initialScan;
  }
}

/**
 * The room list shows under the camera after a "No match" (the face_pick_list fallback), or
 * after two misses of any kind in a row.
 */
export const showsFallbackList = (s: ScanState): boolean =>
  s.phase === 'idle' && (s.miss === 'no_match' || s.misses >= 2);

/** The camera runs only while there is something to scan (it is off on the match card). */
export const cameraActive = (s: ScanState): boolean => s.phase === 'idle' || s.phase === 'checking';

/** A ticket this close to expiry is not worth sending: scan again instead. */
export const TICKET_MARGIN_MS = 3_000;

export const ticketFresh = (m: ScanMatch, serverNowMs: number): boolean =>
  serverNowMs < m.expiresAtMs - TICKET_MARGIN_MS;

// ---------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------

export interface ScanDeps {
  embedder: FaceEmbedder;
  /** POST /v1/rooms/:room_id/face-match for the current room. */
  faceMatch(req: FaceMatchRequest): Promise<FaceMatchResponse>;
  /** Server-corrected clock (ms), for `capture.captured_at`. */
  now(): number;
}

const codeOf = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

/** A face-match error -> the miss shown. */
export function matchErrorMiss(e: unknown): ScanMiss {
  switch (codeOf(e)) {
    case 'NOT_IN_ROOM':
    case 'ROOM_EXPIRED':
      return 'not_in_room';
    case 'RATE_LIMITED':
      return 'busy';
    default:
      return 'failed';
  }
}

/**
 * One scan of the photo at `photoUrl`: the face being pointed at (pickProbeFace), its embedding
 * (on the phone), then the room-scoped match on the server. Never throws: every failure is a
 * miss. The embedding is zeroed once the request is built.
 */
export async function runScan(deps: ScanDeps, photoUrl: string): Promise<ScanOutcome> {
  const miss = (m: ScanMiss): ScanOutcome => ({ kind: 'miss', miss: m });
  let still: FaceStill | null = null;
  let req: FaceMatchRequest;
  try {
    still = await deps.embedder.open(photoUrl);
    const pick = pickProbeFace(still.faces, still);
    if (!pick.ok) return miss(pick.problem);
    const embedding = await still.embed(pick.face);
    const eyes = eyeDistance(pick.face.landmarks);
    req = {
      probe: plainEmbedding(embedding),
      model: { name: FACE_MODEL.name, version: FACE_MODEL.version, dim: FACE_MODEL.dim },
      capture: {
        captured_at: new Date(deps.now()).toISOString(),
        ...(eyes !== null ? { eye_distance_px: Math.round(eyes) } : {}),
        yaw_deg: Math.round(pick.face.yawAngle),
      },
    };
    embedding.fill(0);
  } catch {
    return miss('failed');
  } finally {
    still?.close();
  }
  let res: FaceMatchResponse;
  try {
    res = await deps.faceMatch(req);
  } catch (e) {
    return miss(matchErrorMiss(e));
  }
  const m = res.match;
  if (!m) return miss('no_match');
  return {
    kind: 'found',
    match: {
      user: { user_id: m.user.user_id, display_name: m.user.display_name },
      ticket: m.match_ticket,
      expiresAtMs: Date.parse(m.ticket_expires_at),
      headToHead: {
        wins: m.head_to_head.wins,
        losses: m.head_to_head.losses,
        net: m.head_to_head.net,
      },
    },
  };
}

/** What POST /v1/bets (challenge_method 'face') said, for the scan screen. */
export type ChallengeResult = 'ok' | 'expired' | 'pair_busy' | 'not_in_room' | 'busy' | 'failed';

export function challengeErrorResult(e: unknown): Exclude<ChallengeResult, 'ok'> {
  const details = (e as { details?: { reason?: unknown } } | null)?.details;
  switch (codeOf(e)) {
    case 'VALIDATION_FAILED':
      return details?.reason === 'match_ticket_invalid' ? 'expired' : 'failed';
    case 'INVALID_STATE':
      return details?.reason === 'pair_busy' ? 'pair_busy' : 'failed';
    case 'NOT_IN_ROOM':
    case 'ROOM_EXPIRED':
      return 'not_in_room';
    case 'RATE_LIMITED':
      return 'busy';
    default:
      return 'failed';
  }
}
