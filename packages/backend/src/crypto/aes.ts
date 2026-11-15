/**
 * AES-256-GCM for biometric templates at rest (§13 `BIOMETRIC_KEY`, 32-byte hex).
 * Format: `iv[12] ‖ tag[16] ‖ ciphertext`, base64 in JSON.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptAesGcm(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), ct]));
}

export function decryptAesGcm(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([d.update(blob.subarray(IV_BYTES + TAG_BYTES)), d.final()]));
}
