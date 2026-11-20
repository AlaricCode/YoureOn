// ed25519 verification of device-key signatures, and small encoding helpers.
import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getAddressEncoder, isAddress, type Address } from '@solana/kit';

// noble's sync API needs a sync SHA-512 (ed.hashes.sha512 = sha512, per its README).
ed.hashes.sha512 = sha512;

const addressEncoder = getAddressEncoder();

/** base58 Solana-style address -> 32 raw bytes, or null if it isn't one. */
export function pubkeyBytes(base58: string): Uint8Array | null {
  if (!isAddress(base58)) return null;
  return new Uint8Array(addressEncoder.encode(base58 as Address));
}

/** Strict standard base64 decode (padded); null when the input isn't canonical base64. */
export function decodeBase64(s: string): Uint8Array | null {
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s ? new Uint8Array(buf) : null;
}

/** Strict base64url decode (no padding); null when the input isn't canonical base64url. */
export function decodeBase64Url(s: string): Uint8Array | null {
  const buf = Buffer.from(s, 'base64url');
  return buf.toString('base64url') === s ? new Uint8Array(buf) : null;
}

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const toBase64Url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** Verifies an ed25519 signature over the UTF-8 bytes of `message`. Never throws. */
export function verifyEd25519(
  pubkeyBase58: string,
  message: string | Uint8Array,
  sig: Uint8Array | null,
): boolean {
  const pk = pubkeyBytes(pubkeyBase58);
  if (!pk || !sig || sig.length !== 64) return false;
  try {
    return ed.verify(sig, typeof message === 'string' ? utf8ToBytes(message) : message, pk);
  } catch {
    return false;
  }
}

export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

/** `n` CSPRNG bytes as base64url without padding. */
export const randomB64Url = (n: number): string => randomBytes(n).toString('base64url');
