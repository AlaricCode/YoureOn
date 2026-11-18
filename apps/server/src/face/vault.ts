// Embeddings at rest and in transit (DATA-MODEL §10; API-CONTRACT §2.2 SealedEmbedding).
//
// At rest: AES-256-GCM under the active KEK, a fresh 12-byte nonce per write, and the AAD
// "yo.face.v1|<user_id>|<model_name>@<model_version>|<dim>" so a ciphertext copied to another
// row (or relabelled as another model) fails to decrypt. Stored as ciphertext ‖ 16-byte tag.
//
// In transit: `plain-v0` carries the float32-LE bytes in `ct_b64` (TLS only), accepted while
// FACE_SEAL_REQUIRED=false. The sealed x25519 form (API-CONTRACT O8) is not built, so it is
// refused with FACE_SEAL_INVALID.
//
// Nothing here logs, and the plaintext buffers are zero-filled once they are no longer needed.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { bytesToEmbedding, embeddingProblem, type FaceModelRef } from '@youre-on/shared/face';
import type { SealedEmbedding } from '@youre-on/shared/api';
import { decodeBase64 } from '../crypto';
import { HttpError } from '../errors';

const GCM_TAG_BYTES = 16;
const GCM_NONCE_BYTES = 12;

export const atRestAad = (userId: string, model: FaceModelRef): Buffer =>
  Buffer.from(`yo.face.v1|${userId}|${model.name}@${model.version}|${model.dim}`, 'utf8');

export interface SealedAtRest {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

/** AES-256-GCM seal of `plain` under `kek` with `aad`: ciphertext ‖ tag, plus the nonce. */
export function sealAtRest(kek: Uint8Array, aad: Uint8Array, plain: Uint8Array): SealedAtRest {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const c = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: GCM_TAG_BYTES });
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { ciphertext: new Uint8Array(body), nonce: new Uint8Array(nonce) };
}

/** Opens a sealAtRest() output; null on any failure (wrong key, AAD, nonce or bytes). */
export function openAtRest(
  kek: Uint8Array,
  aad: Uint8Array,
  sealed: SealedAtRest,
): Uint8Array | null {
  if (sealed.nonce.length !== GCM_NONCE_BYTES || sealed.ciphertext.length < GCM_TAG_BYTES) {
    return null;
  }
  try {
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - GCM_TAG_BYTES);
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - GCM_TAG_BYTES);
    const d = createDecipheriv('aes-256-gcm', kek, sealed.nonce, { authTagLength: GCM_TAG_BYTES });
    d.setAAD(aad);
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  } catch {
    return null;
  }
}

/**
 * Opens a SealedEmbedding from a request into a validated `model.dim`-d L2-normalized vector.
 * FACE_SEAL_INVALID: not decodable or the wrong byte length (or sealing required / sealed form
 * sent). VALIDATION_FAILED: decodes, but is not finite or not L2-normalized. `path` names the
 * field in the error (`embedding` or `probe`).
 */
export function openRequestEmbedding(
  sealed: SealedEmbedding,
  model: FaceModelRef,
  opts: { sealRequired: boolean; path: 'embedding' | 'probe' },
): Float32Array {
  if (sealed.alg !== 'plain-v0') {
    throw new HttpError(
      'FACE_SEAL_INVALID',
      'Sealed face data is not supported yet. Update the app.',
      {
        reason: 'seal_unsupported',
      },
    );
  }
  if (opts.sealRequired) {
    throw new HttpError('FACE_SEAL_INVALID', 'This server only accepts sealed face data.', {
      reason: 'seal_required',
    });
  }
  const bytes = decodeBase64(sealed.ct_b64);
  if (!bytes || bytes.length !== model.dim * 4) {
    throw new HttpError('FACE_SEAL_INVALID', "That face data couldn't be read.", {
      reason: 'bad_length',
      expected_bytes: model.dim * 4,
    });
  }
  const v = bytesToEmbedding(bytes);
  bytes.fill(0);
  const problem = embeddingProblem(v, model.dim);
  if (problem) {
    v.fill(0);
    throw new HttpError('VALIDATION_FAILED', undefined, {
      issues: [{ path: `${opts.path}.ct_b64`, message: `embedding ${problem}` }],
    });
  }
  return v;
}

/** The KEK for `keyId`, or null when this server cannot resolve it. */
export const kekFor = (keyring: ReadonlyMap<string, Uint8Array>, keyId: string) =>
  keyring.get(keyId) ?? null;

export { GCM_NONCE_BYTES, GCM_TAG_BYTES };
