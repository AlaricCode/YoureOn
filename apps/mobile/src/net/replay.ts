// The slow-mo replay read (API-CONTRACT §2.14 GET /v1/bets/:bet_id/replay; SCHEMAS §4.1
// ReplayMoment) and how a phone loads one replay frame. Kept out of ./api so that file is untouched
// by this feature: the integrator can fold getReplay into createYoApi later or call it as is.
//
// Frames come from the existing party frame route (GET /v1/bets/:id/attempts/:n/frames/:idx,
// requireSession + canRead), which takes the same bearer every GET carries (./signedFetch). RN
// <Image source={{ uri, headers }}> sends that header itself, so no extra image library is needed.
// Once object storage exists the server fills ReplayFrame.url with a short-lived signed GET; that
// URL is preferred and goes out without the bearer.
//
// Pure TS (no react-native import): the returned object is structurally an ImageURISource.
import { ReplayResponse, replayPath, type ReplayFrame } from '@youre-on/shared/replay';

import type { ApiClient } from './signedFetch';

/** GET /v1/bets/:bet_id/replay -> ReplayResponse (404 for a bet that is not yours). */
export const getReplay = (c: Pick<ApiClient, 'request'>, betId: string): Promise<ReplayResponse> =>
  c.request('GET', replayPath(betId), { schema: ReplayResponse });

/** An RN ImageURISource for one replay frame. */
export interface FrameImageSource {
  uri: string;
  headers?: Record<string, string>;
  /** The frame route answers `private, immutable`: a replay-again never refetches. */
  cache: 'force-cache';
}

/**
 * Where to load `f` from: its signed `url` when the server sent one (no bearer: the signature is
 * the credential), else the API base + `path` with the caller's bearer. `token` null (signed out)
 * leaves the header off; the server then answers 401 and the player falls back to fewer frames.
 */
export function frameImageSource(
  baseUrl: string,
  token: string | null,
  f: Pick<ReplayFrame, 'path' | 'url'>,
): FrameImageSource {
  if (f.url) return { uri: f.url, cache: 'force-cache' };
  const uri = baseUrl.replace(/\/+$/, '') + f.path;
  return token
    ? { uri, headers: { Authorization: `Bearer ${token}` }, cache: 'force-cache' }
    : { uri, cache: 'force-cache' };
}
