/**
 * CRC-16/CCITT-FALSE (§7.5): poly 0x1021, init 0xFFFF, no reflection, xorout 0.
 * Check value: crc("123456789") = 0x29B1.
 */
export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]! << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** The CRC written big-endian (2 bytes), as in the beacon payload (§7.5). */
export function crc16CcittFalseBytes(bytes: Uint8Array): Uint8Array {
  const c = crc16CcittFalse(bytes);
  return Uint8Array.of(c >>> 8, c & 0xff);
}
