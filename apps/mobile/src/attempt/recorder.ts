// Who films an attempt, and how (API-CONTRACT §2.9). The room's judge cam when there is one
// (a third phone, a judge_cam device of the non-performer); with only two phones, the
// non-performer's own phone (recorder 'self'). The server picks the judge cam and refuses
// 'self' to the performer, so this phone's part is small:
//   - Start (and the REDO "Ready") is on the non-performer's phone: it may have to film. The
//     voice judge's request_attempt runs on A's phone, whoever performs.
//   - It asks for the judge cam first; a 409 no_judge_cam (the room has none) means record
//     yourself, unless you are the performer. That refusal costs no rate-limit token on the
//     server, and with a judge cam in the room the judge cam always wins.
//   - The recording is video only (RECORDING_CAMERA mute): on A's phone the voice session holds
//     the mic, and a muted camera never touches it.
// Pure TS: tested in node.
import type { Party } from '@youre-on/shared/primitives';

import { ApiClientError } from '../net/signedFetch';

export type Recorder = 'judge_cam' | 'self';

/** Does this phone show Start? The non-performer's does (A's when no performer is known yet). */
export function startsAttempt(me: Party | null, performer: Party | null): boolean {
  if (!me) return false;
  if (!performer) return me === 'A';
  return me !== performer;
}

/** The recorders this phone asks for, in order: the judge cam, then (off the performer) itself. */
export function recorderOrder(me: Party | null, performer: Party | null): Recorder[] {
  return me && performer && me !== performer ? ['judge_cam', 'self'] : ['judge_cam'];
}

/** POST …/attempts refused 'judge_cam': the room has no judge cam on the server. */
export const isNoJudgeCam = (e: unknown): boolean =>
  e instanceof ApiClientError && e.code === 'INVALID_STATE' && e.details?.reason === 'no_judge_cam';

/**
 * Starts the attempt with the first recorder the server takes. Only no_judge_cam moves on to the
 * next one; any other error (offline, a state race) is the caller's, as before.
 */
export async function startAttemptVia<T>(
  start: (recorder: Recorder) => Promise<T>,
  me: Party | null,
  performer: Party | null,
): Promise<{ recorder: Recorder; result: T }> {
  const order = recorderOrder(me, performer);
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

/** expo-camera CameraView props for the attempt recording (JudgeCamScreen). */
export const RECORDING_CAMERA = {
  facing: 'back',
  mode: 'video',
  /** No audio track: the voice session keeps the mic (FINDINGS §4 Beat 4). */
  mute: true,
  videoQuality: '720p',
} as const;
