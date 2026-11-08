/**
 * ed25519 keypairs in Solana format: the secret key is 64 bytes
 * (`seed[32] ‖ pubkey[32]`), encoded base58 in `.env` (§13 `JUDGE_KEY_0..2`,
 * `ORACLE_KEY`, `FEE_PAYER_KEY`).
 */
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesEqual, fromBase58, toBase58 } from '../util/bytes.js';

export interface KeyPair {
  /** base58 public key */
  readonly publicKey: string;
  readonly publicKeyBytes: Uint8Array;
  /** 64-byte Solana secret key (seed ‖ pubkey) */
  readonly secretKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function keypairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  const s = Uint8Array.from(seed);
  const pub = ed25519.getPublicKey(s);
  const secret = new Uint8Array(64);
  secret.set(s, 0);
  secret.set(pub, 32);
  return {
    publicKey: toBase58(pub),
    publicKeyBytes: pub,
    secretKey: secret,
    sign: (m: Uint8Array) => ed25519.sign(m, s),
  };
}

export function generateKeypair(): KeyPair {
  return keypairFromSeed(new Uint8Array(randomBytes(32)));
}

/** Parses a base58 64-byte Solana secret key; verifies the embedded pubkey. */
export function keypairFromSecret(secretB58: string): KeyPair {
  let raw: Uint8Array;
  try {
    raw = fromBase58(secretB58.trim());
  } catch {
    throw new Error('secret key is not valid base58');
  }
  if (raw.length !== 64) throw new Error(`secret key must be 64 bytes, got ${raw.length}`);
  const kp = keypairFromSeed(raw.subarray(0, 32));
  if (!bytesEqual(kp.publicKeyBytes, raw.subarray(32))) throw new Error('secret key: embedded public key mismatch');
  return kp;
}

export function secretToBase58(kp: KeyPair): string {
  return toBase58(kp.secretKey);
}

/** Verifies a raw ed25519 signature; never throws (malformed input ⇒ false). */
export function verifyEd25519(signature: Uint8Array, message: Uint8Array, pubkey: Uint8Array | string): boolean {
  try {
    const pk = typeof pubkey === 'string' ? fromBase58(pubkey) : pubkey;
    if (pk.length !== 32 || signature.length !== 64) return false;
    return ed25519.verify(signature, message, pk);
  } catch {
    return false;
  }
}
