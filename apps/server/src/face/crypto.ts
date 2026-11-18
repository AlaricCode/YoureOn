// Encryption at rest for face embeddings (DATA-MODEL §10): AES-256-GCM in the server's face
// module, with a KEK from env, a fresh 12-byte nonce per write, and an AAD that binds the
// ciphertext to its user and model, so a ciphertext copied to another row fails to open.
//
// Keys: FACE_KEK_ACTIVE names the key for new writes (e.g. `face-kek-2026-11-a`), and
// FACE_KEK_<id in UPPER_SNAKE> (e.g. FACE_KEK_2026_11_A) holds it: 32 bytes, base64 or hex
// (`openssl rand -base64 32`). The key never goes in the database or a log.
//
// Outside production, with no KEK configured, the process makes an ephemeral one
// (`face-kek-ephemeral`): enrollments then only survive until the server restarts.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { float32FromLe, float32ToLe, type FaceModelRef } from '@youre-on/shared/face';

import type { Env } from '../env';
import { HttpError } from '../errors';

export interface Kek {
  id: string;
  key: Buffer;
}

export interface Keyring {
  active: Kek;
  get(id: string): Buffer | undefined;
}

const EPHEMERAL_ID = 'face-kek-ephemeral';
const ephemeral = new Map<string, Buffer>();

/** `face-kek-2026-11-a` → `FACE_KEK_2026_11_A`. */
export const kekEnvName = (keyId: string): string =>
  `FACE_KEK_${keyId
    .replace(/^face-kek-/, '')
    .replace(/[^0-9a-z]+/gi, '_')
    .toUpperCase()}`;

function decodeKey(v: string): Buffer {
  const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (b.length !== 32) throw new Error('a face KEK must be 32 bytes');
  return b;
}

/**
 * The keyring from env. Throws 500 INTERNAL (reason face_not_configured) in production when no
 * KEK is set, so face routes fail closed instead of storing an embedding they can't protect.
 */
export function keyringFrom(env: Env): Keyring {
  const vars = env as unknown as Record<string, string | undefined>;
  const get = (id: string): Buffer | undefined => {
    if (id === EPHEMERAL_ID) return ephemeral.get(id);
    const v = vars[kekEnvName(id)];
    return v ? decodeKey(v) : undefined;
  };
  const activeId = env.FACE_KEK_ACTIVE;
  if (activeId) {
    const key = get(activeId);
    if (!key) {
      throw new HttpError('INTERNAL', "Face matching isn't set up.", {
        reason: 'face_not_configured',
      });
    }
    return { active: { id: activeId, key }, get };
  }
  if (env.NODE_ENV === 'production') {
    throw new HttpError('INTERNAL', "Face matching isn't set up.", {
      reason: 'face_not_configured',
    });
  }
  if (!ephemeral.has(EPHEMERAL_ID)) ephemeral.set(EPHEMERAL_ID, randomBytes(32));
  return { active: { id: EPHEMERAL_ID, key: ephemeral.get(EPHEMERAL_ID)! }, get };
}

/** DATA-MODEL §10 AAD: "yo.face.v1|" + user_id + "|" + model_name + "@" + model_version + "|" + dim. */
export const atRestAad = (userId: string, model: FaceModelRef): Buffer =>
  Buffer.from(`yo.face.v1|${userId}|${model.name}@${model.version}|${model.dim}`, 'utf8');

export interface SealedRow {
  embedding_ciphertext: Uint8Array;
  embedding_nonce: Uint8Array;
  key_id: string;
}

/** Encrypts a unit vector for `face_enrollments`: ciphertext ‖ 16-byte tag, 12-byte nonce. */
export function sealAtRest(
  ring: Keyring,
  userId: string,
  model: FaceModelRef,
  v: Float32Array,
): SealedRow {
  if (v.length !== model.dim) throw new Error(`embedding has ${v.length} values, not ${model.dim}`);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ring.active.key, nonce);
  c.setAAD(atRestAad(userId, model));
  const ct = Buffer.concat([c.update(float32ToLe(v)), c.final(), c.getAuthTag()]);
  return { embedding_ciphertext: ct, embedding_nonce: nonce, key_id: ring.active.id };
}

/** Decrypts one row in memory. Returns null if the key is gone or the tag does not verify. */
export function openAtRest(
  ring: Keyring,
  userId: string,
  model: FaceModelRef,
  row: SealedRow,
): Float32Array | null {
  const key = ring.get(row.key_id);
  if (!key) return null;
  const buf = Buffer.from(row.embedding_ciphertext);
  if (buf.length !== model.dim * 4 + 16) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(row.embedding_nonce));
    d.setAAD(atRestAad(userId, model));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
    return float32FromLe(new Uint8Array(pt));
  } catch {
    return null;
  }
}
