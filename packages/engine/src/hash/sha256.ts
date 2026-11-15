/** SHA-256 (FIPS 180-4) via @noble/hashes (§0.3). */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import type { Hex32 } from '../types.js';
import { bytesToHex, concatBytes } from './bytes.js';

/** `sha256(bytes)` → 32-byte digest. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** `sha256(p_0 ‖ p_1 ‖ …)`. */
export function sha256Concat(...parts: Uint8Array[]): Uint8Array {
  return nobleSha256(concatBytes(...parts));
}

/** `sha256(bytes)` as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): Hex32 {
  return bytesToHex(nobleSha256(bytes));
}
