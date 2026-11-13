/**
 * Free local sidecars (no spend guard):
 *  - IDENTITY_PROVIDER=http → services/embedder (§8.1):
 *      POST {EMBEDDER_URL}/embed/face {images_b64:[...]} → {embeddings:[[...]]}
 *      POST {EMBEDDER_URL}/embed/voice {wav_b64} → {embedding:[...]}
 *  - DETECTOR_PROVIDER=http → scene detector (D-28):
 *      POST {DETECTOR_URL}/detect {jpeg_b64, entities:[{entity, phrase}]}
 *        → {detections:[{entity, bbox:[x0,y0,x1,y1] (0..10000), conf (percent)}]}
 *    (request/response shape chosen by the backend; see CONTRACTS-ERRATA.md)
 */
import { FACE_DIM, VOICE_DIM } from '@verdict/engine';
import { ApiError } from '../../errors.js';
import { toBase64 } from '../../util/bytes.js';
import { l2normalize } from '../../util/prng.js';
import type { Detection, DetectorProvider, IdentityProvider } from '../types.js';

export type FetchFn = typeof fetch;

/** A non-2xx answer from a sidecar; `status` is the HTTP status. */
export class SidecarHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`POST ${url} → HTTP ${status}`);
  }
}

async function postJson<T>(f: FetchFn, url: string, body: unknown): Promise<T> {
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new SidecarHttpError(url, r.status);
  return (await r.json()) as T;
}

/**
 * The embedder answers 422 when the input itself is unusable (no detectable
 * face; a voice clip of the wrong length). That is the user's frame, not a
 * server fault: report it with the matching §12.8 code.
 */
function rejectedInput(e: unknown, code: 'FACE_NOT_MATCHED' | 'PHRASE_NOT_HEARD', detail: string): never {
  if (e instanceof SidecarHttpError && e.status === 422) throw new ApiError(code, detail);
  throw e;
}

function checkVector(v: unknown, dim: number, what: string): number[] {
  if (!Array.isArray(v) || v.length !== dim || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`${what}: expected ${dim} finite numbers`);
  }
  return l2normalize(v as number[]);
}

export class HttpEmbedder implements IdentityProvider {
  readonly name = 'http';
  constructor(
    private readonly baseUrl: string,
    private readonly f: FetchFn = fetch,
  ) {}

  async embedFace(jpeg: Uint8Array): Promise<number[]> {
    const r = await postJson<{ embeddings?: unknown[] }>(this.f, `${this.baseUrl}/embed/face`, {
      images_b64: [toBase64(jpeg)],
    }).catch((e: unknown) => rejectedInput(e, 'FACE_NOT_MATCHED', 'no face found in the image'));
    return checkVector(r.embeddings?.[0], FACE_DIM, 'embed/face');
  }

  async embedVoice(wav: Uint8Array): Promise<number[]> {
    const r = await postJson<{ embedding?: unknown }>(this.f, `${this.baseUrl}/embed/voice`, {
      wav_b64: toBase64(wav),
    }).catch((e: unknown) => rejectedInput(e, 'PHRASE_NOT_HEARD', 'voice clip rejected by the embedder'));
    return checkVector(r.embedding, VOICE_DIM, 'embed/voice');
  }
}

export class HttpDetector implements DetectorProvider {
  readonly name = 'http';
  constructor(
    private readonly baseUrl: string,
    private readonly f: FetchFn = fetch,
  ) {}

  async detect(jpeg: Uint8Array, ctx: Parameters<DetectorProvider['detect']>[1]): Promise<Detection[]> {
    const r = await postJson<{ detections?: Detection[] }>(this.f, `${this.baseUrl}/detect`, {
      jpeg_b64: toBase64(jpeg),
      entities: ctx.entities,
    });
    return (r.detections ?? []).filter(
      (d) =>
        typeof d.entity === 'string' &&
        Array.isArray(d.bbox) &&
        d.bbox.length === 4 &&
        d.bbox.every((x) => Number.isInteger(x) && x >= 0 && x <= 10000) &&
        Number.isInteger(d.conf) &&
        d.conf >= 0 &&
        d.conf <= 100,
    );
  }
}
