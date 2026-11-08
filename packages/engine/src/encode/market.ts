/**
 * `market_bin` (magic "VMKT", §5.5): replaces track_bin for kind `market`.
 * `"VMKT" ‖ version u8 = 1 ‖ n u8 ‖ reserved u16 = 0 ‖ n × (market_hash[32] ‖ result u8)`.
 */
import { MARKET_BIN_VERSION, MARKET_HASH_BYTES, MARKET_MAGIC } from '../constants.js';
import { bytesToHex, hexToBytes, isHex32 } from '../hash/bytes.js';
import type { MarketBinEntry, MarketResultCode } from '../types.js';
import { check } from './errors.js';
import { ByteReader, ByteWriter } from './io.js';

const MT = 'MalformedTracks' as const;

/** Encode market results (§5.5). Throws `EngineError("MalformedTracks")` on duplicates / bad results. */
export function encodeMarketBin(entries: readonly MarketBinEntry[]): Uint8Array {
  check(entries.length <= 0xff, MT, 'too many market entries');
  const w = new ByteWriter(8 + 33 * entries.length);
  w.bytes(MARKET_MAGIC).u8(MARKET_BIN_VERSION).u8(entries.length).u16(0);
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    check(isHex32(e.market_hash), MT, `entries[${i}].market_hash must be 64-char lowercase hex`);
    check(!seen.has(e.market_hash), MT, `duplicate market_hash ${e.market_hash}`);
    seen.add(e.market_hash);
    check(e.result === 0 || e.result === 1 || e.result === 2, MT, `entries[${i}].result must be 0|1|2`);
    w.bytes(hexToBytes(e.market_hash)).u8(e.result);
  });
  return w.finish();
}

/** Parse a market_bin starting at `start`; it must end exactly at the end of `bin`. */
export function readMarketBin(bin: Uint8Array, start = 0): MarketBinEntry[] {
  const r = new ByteReader(bin, MT, start);
  const magic = r.bytes(4, 'magic');
  check(magic.every((b, i) => b === MARKET_MAGIC[i]), MT, 'bad magic');
  check(r.u8('version') === MARKET_BIN_VERSION, MT, 'bad version');
  const n = r.u8('n');
  check(r.u16('reserved') === 0, MT, 'reserved must be 0');
  const out: MarketBinEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const h = bytesToHex(r.bytes(MARKET_HASH_BYTES, 'market_hash'));
    const result = r.u8('result');
    check(!seen.has(h), MT, `duplicate market_hash ${h}`);
    seen.add(h);
    check(result <= 2, MT, `result ${result} > 2`);
    out.push({ market_hash: h, result: result as MarketResultCode });
  }
  r.expectEnd('market entries');
  return out;
}

/** Decode and validate market_bin (§5.5). */
export function decodeMarketBin(bin: Uint8Array): MarketBinEntry[] {
  return readMarketBin(bin, 0);
}
