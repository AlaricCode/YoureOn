// Opens a SealedEmbedding from a phone (API-CONTRACT §2.2) into a unit vector, in memory only.
//
// `plain-v0` (the float32-LE vector, base64, protected by TLS alone) is accepted while
// FACE_SEAL_REQUIRED is false. The x25519 + chacha20poly1305 form is not served yet: the consent
// response says so with `face_seal_pubkey: null`, and a sealed embedding is refused with
// FACE_SEAL_INVALID until @noble/ciphers is pinned and both sides implement it.
import type { SealedEmbedding } from '@youre-on/shared/api';
import { float32FromLe, type FaceModelRef } from '@youre-on/shared/face';

import type { Env } from '../env';
import { HttpError } from '../errors';

/** Accept vectors within this of unit length (the phone L2-normalises in float32). */
const NORM_TOLERANCE = 0.02;

export function openEmbedding(
  env: Pick<Env, 'FACE_SEAL_REQUIRED'>,
  sealed: SealedEmbedding,
  model: FaceModelRef,
): Float32Array {
  if (sealed.alg !== 'plain-v0') {
    throw new HttpError('FACE_SEAL_INVALID', 'Sealed embeddings are not supported yet.', {
      reason: 'seal_unsupported',
    });
  }
  if (env.FACE_SEAL_REQUIRED) {
    throw new HttpError('FACE_SEAL_INVALID', 'This server requires a sealed embedding.', {
      reason: 'seal_required',
    });
  }
  const bytes = Buffer.from(sealed.ct_b64, 'base64');
  if (bytes.length !== model.dim * 4) {
    throw new HttpError('FACE_SEAL_INVALID', 'The embedding has the wrong size.', {
      reason: 'bad_length',
    });
  }
  const v = float32FromLe(new Uint8Array(bytes));
  let n = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) {
      throw new HttpError('FACE_SEAL_INVALID', 'The embedding is not a valid vector.', {
        reason: 'not_finite',
      });
    }
    n += x * x;
  }
  const norm = Math.sqrt(n);
  if (Math.abs(norm - 1) > NORM_TOLERANCE) {
    throw new HttpError('FACE_SEAL_INVALID', 'The embedding is not normalised.', {
      reason: 'not_unit',
    });
  }
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}
