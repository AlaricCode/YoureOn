import { describe, expect, it } from 'vitest';
import {
  EngineError,
  decodeCalibration,
  decodeMarketBin,
  decodeProgram,
  decodeTrackBin,
  encodeCalibration,
  encodeMarketBin,
  encodeProgram,
  encodeTrackBin,
} from '../src/encode/index.js';
import { marketHash } from '../src/hash/index.js';
import { aiJudged, marketProgram, paperBall, paperBallCalibration, paperBallTracks, zoneCalibration, zoneProgram } from './encode-fixtures.js';

/** mulberry32, seeded. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `decode` on many mutations of `bin`: it must either succeed or throw EngineError(code). */
function fuzz(bin: Uint8Array, decode: (b: Uint8Array) => unknown, code: string, seed: number, n = 1500): number {
  const rnd = prng(seed);
  let accepted = 0;
  for (let i = 0; i < n; i++) {
    let b = bin.slice();
    const mode = Math.floor(rnd() * 4);
    if (mode === 0) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    else if (mode === 1) b[Math.floor(rnd() * b.length)]! ^= 1 << Math.floor(rnd() * 8);
    else if (mode === 2) b = b.slice(0, Math.floor(rnd() * b.length));
    else b = Uint8Array.from([...b, Math.floor(rnd() * 256)]);
    try {
      decode(b);
      accepted++;
    } catch (e) {
      if (!(e instanceof EngineError) || e.code !== code) throw e;
    }
  }
  return accepted;
}

describe('decoders never throw anything but their §9.6 error', () => {
  it('program_bin', () => {
    for (const [i, p] of [paperBall(), zoneProgram(), aiJudged(), marketProgram()].entries()) {
      const acc = fuzz(encodeProgram(p), decodeProgram, 'MalformedProgram', 100 + i);
      expect(acc).toBeLessThan(1500);
    }
  });
  it('calibration_bin', () => {
    const dp = decodeProgram(encodeProgram(paperBall()));
    fuzz(encodeCalibration(paperBallCalibration(), paperBall()), (b) => decodeCalibration(b, dp), 'MalformedCalibration', 7);
    const zp = zoneProgram();
    const zdp = decodeProgram(encodeProgram(zp));
    fuzz(encodeCalibration(zoneCalibration(), zp), (b) => decodeCalibration(b, zdp), 'MalformedCalibration', 8);
  });
  it('track_bin', () => {
    const dp = decodeProgram(encodeProgram(paperBall()));
    fuzz(encodeTrackBin(paperBallTracks()), (b) => decodeTrackBin(b, dp), 'MalformedTracks', 9);
  });
  it('market_bin', () => {
    const bin = encodeMarketBin([
      { market_hash: marketHash('a', 'b'), result: 0 },
      { market_hash: marketHash('c', 'd'), result: 1 },
    ]);
    fuzz(bin, decodeMarketBin, 'MalformedTracks', 10);
  });
});
