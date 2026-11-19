// A locked Dance Off on the phones (docs/planning/DANCE-OFF.md §6.2): who records, how the round
// starts, and the signed upload. Pure TS over injected deps, tested in node; the screens are
// ../dance (DanceOffScreen on the recording phone, DanceWatchScreen on the other one).
//   recording phone  the room's judge cam when there is one, else A's phone (both players dance,
//                    so neither is "the performer": A's own phone films for both). Once the
//                    attempt is started the server's attempt.started names the recorder device.
//   start            POST /attempts asking for the judge cam first; 409 no_judge_cam (the room has
//                    none) means record yourself. A judge-cam device only ever asks for itself.
//   upload           POST /v1/bets/:id/attempts/:n/dance, multipart `upload` (DanceUpload JSON)
//                    + `frame` JPEGs in upload.frames order, signed over the raw bytes. The first
//                    build under an Idempotency-Key is the one every retry resends (a different
//                    body under the same key is 409 IDEMPOTENCY_KEY_REUSED); a 4xx is replayed
//                    for its key, so after one the next try mints a fresh key and rebuilds.
import type { BetState } from '@youre-on/shared/bet-state';
import { isDanceOff } from '@youre-on/shared/dance/terms';
import { DanceUpload } from '@youre-on/shared/evidence';
import type { Party } from '@youre-on/shared/primitives';
import type { Terms } from '@youre-on/shared/terms';

import { isNoJudgeCam, type Recorder } from '../attempt/recorder';
import type { BetModel } from '../bets/store';
import type { YoApi } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import { COPY, t } from '../screens/copy';

/** The bet's Terms say Dance Off. */
export const isDanceBet = (b: { envelope: { terms: Pick<Terms, 'type'> } | null }): boolean =>
  b.envelope !== null && isDanceOff(b.envelope.terms);

/** The states a dance round is on screen in (the ruling and payout are the usual screens). */
const DANCE_STATES: ReadonlySet<BetState> = new Set(['LOCKED', 'ATTEMPT', 'JUDGING']);
export const inDanceRound = (state: BetState | null): boolean =>
  state !== null && DANCE_STATES.has(state);

/**
 * Does this phone record the round (and so show the dance screen with the camera)? The room's
 * judge cam always; once an attempt names its recorder, only that device; before that, A's phone
 * (the challenger stands on the left of the display, and A hosts the round).
 */
export function recordsDance(
  app: { judgeCam: boolean; deviceId: string | null },
  b: Pick<BetModel, 'attempt' | 'my_party'>,
): boolean {
  if (app.judgeCam) return true;
  if (b.attempt) return app.deviceId !== null && b.attempt.recorder_device_id === app.deviceId;
  return b.my_party === 'A';
}

/** What the watching phone shows: before the round, during it, and while it is scored. */
export type DanceWatchPhase = 'waiting' | 'dancing' | 'judging';
export const danceWatchPhase = (state: BetState | null): DanceWatchPhase =>
  state === 'ATTEMPT' ? 'dancing' : state === 'JUDGING' ? 'judging' : 'waiting';

/**
 * The recorders a phone asks for, in order. A judge-cam device asks for the judge cam only; A's
 * phone asks for the judge cam, then (none in the room) itself. B never starts a dance round.
 */
export function danceRecorderOrder(judgeCam: boolean, me: Party | null): Recorder[] {
  if (judgeCam) return ['judge_cam'];
  return me === 'A' ? ['judge_cam', 'self'] : [];
}

/** Starts the round with the first recorder the server takes (no_judge_cam moves on). */
export async function startDanceAttemptVia<T>(
  start: (recorder: Recorder) => Promise<T>,
  judgeCam: boolean,
  me: Party | null,
): Promise<{ recorder: Recorder; result: T }> {
  const order = danceRecorderOrder(judgeCam, me);
  if (order.length === 0) throw new Error('NOT_RECORDER');
  for (let i = 0; ; i++) {
    const recorder = order[i] as Recorder;
    try {
      return { recorder, result: await start(recorder) };
    } catch (e) {
      if (i + 1 < order.length && isNoJudgeCam(e)) continue;
      throw e;
    }
  }
}

/** The short line the dance screen shows when the start failed (1-3 words). */
export function danceStartNote(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'NETWORK') return t(COPY.app.offline);
    if (isNoJudgeCam(e)) return t(COPY.live.noJudgeCam);
    if (e.code === 'RATE_LIMITED') return t(COPY.home.slowDown);
  }
  return t(COPY.app.failed);
}

// ---------------------------------------------------------------------------------------
// The upload
// ---------------------------------------------------------------------------------------

/** One key-frame JPEG the dance screen hands over (../dance DanceUploadBundle frames). */
export interface DanceFrameBytes {
  index: number;
  bytes: Uint8Array;
  sha256: string;
}

/** What the dance screen hands over: the upload record and the JPEG bytes it names. */
export interface DanceBundleIn {
  upload: DanceUpload;
  frames: readonly DanceFrameBytes[];
}

/** One upload, built once: a resend under the same key sends exactly these bytes. */
export interface PreparedDance {
  upload: DanceUpload;
  frames: Uint8Array[];
}

export type DanceUploadResult =
  | { ok: true }
  /** `freshKey`: the server answered a 4xx (replayed for its key): the next try needs a new one. */
  | { ok: false; message: string; freshKey: boolean };

/**
 * The upload in wire order: upload.frames by index, each with the JPEG whose sha256 it names.
 * Throws when the record does not parse or a frame is missing or does not match.
 */
export function prepareDance(bundle: DanceBundleIn): PreparedDance {
  const upload = DanceUpload.parse(bundle.upload);
  const byIndex = new Map(bundle.frames.map((f) => [f.index, f] as const));
  const ordered = [...upload.frames].sort((a, b) => a.index - b.index);
  const frames = ordered.map((f) => {
    const jpeg = byIndex.get(f.index);
    if (!jpeg || jpeg.sha256.toLowerCase() !== f.sha256 || jpeg.bytes.length !== f.bytes)
      throw new Error(`frame ${f.index} does not match the upload`);
    return jpeg.bytes;
  });
  return { upload: { ...upload, frames: ordered }, frames };
}

/** A failed upload, in 1-3 words for the dance screen's retry line. */
function uploadNote(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'NETWORK') return t(COPY.app.offline);
    if (e.code === 'INVALID_STATE' || e.code === 'ATTEMPT_NOT_OPEN') return t(COPY.dance.roundOver);
  }
  return t(COPY.dance.uploadFailed);
}

/**
 * Sends one round's upload. With `cache` (keyed by the pinned Idempotency-Key) a retry resends
 * the first build, whatever the screen hands over the second time. Never throws.
 */
export async function sendDanceUpload(
  d: { api: Pick<YoApi, 'uploadDance'> },
  a: { betId: string; attemptNo: number; bundle: DanceBundleIn; idempotencyKey: string },
  cache?: Map<string, PreparedDance>,
): Promise<DanceUploadResult> {
  let prepared = cache?.get(a.idempotencyKey);
  if (!prepared) {
    try {
      prepared = prepareDance(a.bundle);
    } catch {
      return { ok: false, message: t(COPY.dance.uploadFailed), freshKey: false };
    }
    cache?.set(a.idempotencyKey, prepared);
  }
  try {
    await d.api.uploadDance(
      a.betId,
      a.attemptNo,
      prepared.upload,
      prepared.frames,
      a.idempotencyKey,
    );
    return { ok: true };
  } catch (e) {
    const answered = e instanceof ApiClientError && e.status >= 400 && e.status < 500;
    // The server answered: that answer is replayed for this key, so the next try is a new
    // request (a new key, and the screen's bundle built afresh).
    if (answered) cache?.delete(a.idempotencyKey);
    return { ok: false, message: uploadNote(e), freshKey: answered };
  }
}
