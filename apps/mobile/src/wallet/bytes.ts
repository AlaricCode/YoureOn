// Pure byte helpers for the wallet. No platform imports: this file runs in Node (vitest) and on Hermes.
// Hermes (RN 0.88, Expo 58) has no crypto.subtle and no global getRandomValues (FINDINGS §7), and the
// app ships no Buffer polyfill, so base58/hex/UUID handling is done here by hand.

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  [...B58_ALPHABET].map((c, i) => [c, i]),
);

/** Bitcoin-alphabet base58, the encoding of Solana addresses and transaction signatures. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i] as number];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  // Bytes, least significant first.
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const value = B58_INDEX[text[i] as string];
    if (value === undefined) throw new Error(`base58: invalid character at ${i}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i] as number;
  return out;
}

/** Decodes a base58 Solana address and asserts it is exactly 32 bytes. */
export function addressToBytes(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) throw new Error(`address: expected 32 bytes, got ${bytes.length}`);
  return bytes;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID string -> 16 bytes in RFC 4122 textual order (what npm `uuid.parse()` returns), never the
 * Microsoft mixed-endian GUID order. This is the onchain `bet_id: [u8; 16]` (ESCROW §2).
 */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_RE.test(uuid)) throw new Error('bet_id: not a UUID string');
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Overwrites a buffer with zeros in place. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
