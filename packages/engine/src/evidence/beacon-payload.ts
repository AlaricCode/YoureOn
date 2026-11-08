/**
 * Freshness beacon payload and symbols (§7.5).
 *
 * Payload (18 bytes): u64 slot (LE) ‖ beacon_hash[0..8] ‖ crc16 (BE), with
 * crc16 = CRC-16/CCITT-FALSE over the first 16 bytes.
 * Symbols: preamble [0,15,0,15,0,15], then high nibble, low nibble per byte (42).
 */
import {
  BEACON_HASH_PREFIX_BYTES,
  BEACON_PAYLOAD_BYTES,
  BEACON_PREAMBLE,
  BEACON_SYMBOLS,
  BEACON_TONES,
  CRC16_INIT,
  CRC16_POLY,
} from '../constants.js';
import { readU64le, u64le } from './bytes.js';

/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, xorout 0).
 * Internal copy for the beacon; the public `crc16CcittFalse` lives in the hash module.
 */
export function beaconCrc16(bytes: Uint8Array): number {
  let crc = CRC16_INIT;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ CRC16_POLY) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Builds the 18-byte beacon payload. `hash` is the SlotHashes bank hash; only
 * its first 8 bytes are carried (any length ≥ 8 is accepted, normally 32).
 */
export function encodeBeaconPayload(slot: bigint | number, hash: Uint8Array): Uint8Array {
  if (!(hash instanceof Uint8Array) || hash.length < BEACON_HASH_PREFIX_BYTES) {
    throw new RangeError(`beacon hash must have at least ${BEACON_HASH_PREFIX_BYTES} bytes`);
  }
  const out = new Uint8Array(BEACON_PAYLOAD_BYTES);
  out.set(u64le(slot), 0);
  out.set(hash.subarray(0, BEACON_HASH_PREFIX_BYTES), 8);
  const crc = beaconCrc16(out.subarray(0, 16));
  out[16] = crc >> 8;
  out[17] = crc & 0xff;
  return out;
}

/** Parses and CRC-checks an 18-byte payload; null if the CRC fails. */
export function decodeBeaconPayload(payload: Uint8Array): { slot: bigint; hashPrefix: Uint8Array } | null {
  if (payload.length !== BEACON_PAYLOAD_BYTES) return null;
  const crc = beaconCrc16(payload.subarray(0, 16));
  if (payload[16] !== crc >> 8 || payload[17] !== (crc & 0xff)) return null;
  return { slot: readU64le(payload, 0), hashPrefix: Uint8Array.from(payload.subarray(8, 16)) };
}

/** 42 tone indices: preamble, then high/low nibble of each payload byte. */
export function beaconSymbols(payload: Uint8Array): number[] {
  if (payload.length !== BEACON_PAYLOAD_BYTES) {
    throw new RangeError(`beacon payload must be ${BEACON_PAYLOAD_BYTES} bytes`);
  }
  const out: number[] = [...BEACON_PREAMBLE];
  for (const b of payload) out.push(b >> 4, b & 0x0f);
  return out;
}

/** Inverse of `beaconSymbols` (preamble must match); null on malformed input. */
export function symbolsToPayload(symbols: number[]): Uint8Array | null {
  if (symbols.length !== BEACON_SYMBOLS) return null;
  for (let j = 0; j < BEACON_PREAMBLE.length; j++) if (symbols[j] !== BEACON_PREAMBLE[j]) return null;
  const out = new Uint8Array(BEACON_PAYLOAD_BYTES);
  for (let i = 0; i < BEACON_PAYLOAD_BYTES; i++) {
    const hi = symbols[BEACON_PREAMBLE.length + 2 * i]!;
    const lo = symbols[BEACON_PREAMBLE.length + 2 * i + 1]!;
    if (!validTone(hi) || !validTone(lo)) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function validTone(k: number): boolean {
  return Number.isInteger(k) && k >= 0 && k < BEACON_TONES;
}
