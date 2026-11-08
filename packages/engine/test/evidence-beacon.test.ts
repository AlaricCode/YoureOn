import { describe, expect, it } from 'vitest';
import {
  beaconSymbols,
  decodeBeacon,
  decodeBeaconPayload,
  encodeBeaconPayload,
  symbolsToPayload,
  synthBeacon,
} from '../src/evidence/index.js';
import { beaconCrc16 } from '../src/evidence/beacon-payload.js';

/** Seeded PRNG (mulberry32) + Box–Muller, test-only. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const HASH = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const SLOT = 312_456_789_012n;

/** Places `sig` at `offset` inside `len` samples of noise (std `noise` in PCM16 units), with gain. */
function embed(sig: Int16Array, offset: number, len: number, noise: number, gain: number, seed: number): Int16Array {
  const r = rng(seed);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    let v = noise * gauss(r);
    const j = i - offset;
    if (j >= 0 && j < sig.length) v += gain * sig[j]!;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

describe('crc16 CCITT-FALSE', () => {
  it('matches the standard check value', () => {
    expect(beaconCrc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
    expect(beaconCrc16(new Uint8Array(0))).toBe(0xffff);
  });
});

describe('beacon payload', () => {
  it('layout: u64 LE slot, hash[0..8], crc16 BE', () => {
    const p = encodeBeaconPayload(0x0102030405060708n, HASH);
    expect(p.length).toBe(18);
    expect(Array.from(p.subarray(0, 8))).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(Array.from(p.subarray(8, 16))).toEqual(Array.from(HASH.subarray(0, 8)));
    const crc = beaconCrc16(p.subarray(0, 16));
    expect(p[16]).toBe(crc >> 8);
    expect(p[17]).toBe(crc & 0xff);
  });
  it('round-trips and rejects a flipped bit', () => {
    const p = encodeBeaconPayload(SLOT, HASH);
    const d = decodeBeaconPayload(p)!;
    expect(d.slot).toBe(SLOT);
    expect(Array.from(d.hashPrefix)).toEqual(Array.from(HASH.subarray(0, 8)));
    for (let i = 0; i < 18; i++) {
      const q = Uint8Array.from(p);
      q[i]! ^= 0x10;
      expect(decodeBeaconPayload(q)).toBeNull();
    }
  });
  it('handles u64 extremes and rejects bad input', () => {
    for (const s of [0n, 0xffffffffffffffffn]) expect(decodeBeaconPayload(encodeBeaconPayload(s, HASH))!.slot).toBe(s);
    expect(() => encodeBeaconPayload(-1n, HASH)).toThrow();
    expect(() => encodeBeaconPayload(1n << 64n, HASH)).toThrow();
    expect(() => encodeBeaconPayload(1n, new Uint8Array(7))).toThrow();
    expect(decodeBeaconPayload(new Uint8Array(17))).toBeNull();
  });
});

describe('beacon symbols', () => {
  it('42 symbols: preamble then hi/lo nibbles', () => {
    const p = encodeBeaconPayload(SLOT, HASH);
    const s = beaconSymbols(p);
    expect(s.length).toBe(42);
    expect(s.slice(0, 6)).toEqual([0, 15, 0, 15, 0, 15]);
    expect(s[6]).toBe(p[0]! >> 4);
    expect(s[7]).toBe(p[0]! & 15);
    expect(s[41]).toBe(p[17]! & 15);
    expect(Array.from(symbolsToPayload(s)!)).toEqual(Array.from(p));
  });
  it('symbolsToPayload rejects bad preamble / tone / length', () => {
    const s = beaconSymbols(encodeBeaconPayload(SLOT, HASH));
    expect(symbolsToPayload(s.slice(1))).toBeNull();
    expect(symbolsToPayload([1, ...s.slice(1)])).toBeNull();
    const t = [...s];
    t[10] = 16;
    expect(symbolsToPayload(t)).toBeNull();
    expect(() => beaconSymbols(new Uint8Array(17))).toThrow();
  });
});

describe('synthBeacon', () => {
  const sym = beaconSymbols(encodeBeaconPayload(SLOT, HASH));
  const pcm = synthBeacon(sym, 48000);
  it('is 2.10 s at 48 kHz', () => {
    expect(pcm.length).toBe(42 * 2400);
  });
  it('envelope endpoints are zero, mirror-symmetric ramp, peak ≤ round(0.25·32767)', () => {
    for (let j = 0; j < 42; j++) {
      expect(pcm[j * 2400]).toBe(0);
      expect(pcm[j * 2400 + 2399]).toBe(0);
    }
    let max = 0;
    for (const v of pcm) max = Math.max(max, Math.abs(v));
    expect(max).toBeLessThanOrEqual(8192);
    expect(max).toBeGreaterThan(8000);
  });
  it('matches the normative formula sample-by-sample', () => {
    const k = sym[7]!;
    const f = 2000 + 250 * k;
    for (const n of [0, 1, 100, 239, 240, 1000, 2159, 2160, 2300, 2399]) {
      const env = n < 240 ? n / 240 : n >= 2160 ? (2399 - n) / 240 : 1;
      const s = 0.25 * env * Math.sin((2 * Math.PI * f * n) / 48000);
      const v = 32767 * s;
      const expected = v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
      expect(pcm[7 * 2400 + n]).toBe(expected + 0);
    }
  });
  it('is deterministic and rejects invalid tones', () => {
    expect(Array.from(synthBeacon(sym, 48000).subarray(0, 5000))).toEqual(Array.from(pcm.subarray(0, 5000)));
    expect(() => synthBeacon([16], 48000)).toThrow();
    expect(() => synthBeacon([-1], 48000)).toThrow();
  });
});

describe('decodeBeacon', () => {
  const sym = beaconSymbols(encodeBeaconPayload(SLOT, HASH));

  it('decodes the clean signal with t0 at the end', () => {
    const pcm = synthBeacon(sym, 48000);
    const d = decodeBeacon(pcm, 48000)!;
    expect(d).not.toBeNull();
    expect(d.slot).toBe(SLOT);
    expect(Array.from(d.hashPrefix)).toEqual(Array.from(HASH.subarray(0, 8)));
    expect(Math.abs(d.t0Sample - pcm.length)).toBeLessThanOrEqual(2);
  });

  it('finds the beacon at an arbitrary offset inside silence', () => {
    const pcm = synthBeacon(sym, 48000);
    const offset = 37_123;
    const buf = embed(pcm, offset, offset + pcm.length + 20_000, 0, 1, 1);
    const d = decodeBeacon(buf, 48000)!;
    expect(d.slot).toBe(SLOT);
    expect(Math.abs(d.t0Sample - (offset + pcm.length))).toBeLessThanOrEqual(24); // ≤ 0.5 ms
  });

  it('is robust to strong Gaussian noise and attenuation (48 kHz)', () => {
    const pcm = synthBeacon(sym, 48000);
    for (const [seed, noise, gain] of [
      [1, 1500, 1],
      [2, 3000, 0.7],
      [3, 2000, 0.3],
    ] as const) {
      const offset = 10_000 + seed * 7_777;
      const buf = embed(pcm, offset, offset + pcm.length + 15_000, noise, gain, seed);
      const d = decodeBeacon(buf, 48000);
      expect(d, `seed ${seed}`).not.toBeNull();
      expect(d!.slot).toBe(SLOT);
      expect(Math.abs(d!.t0Sample - (offset + pcm.length))).toBeLessThanOrEqual(96); // ≤ 2 ms
    }
  });

  it('decodes at 16 kHz and 44.1 kHz (synthesized at that rate)', () => {
    for (const rate of [16000, 44100, 22050]) {
      const pcm = synthBeacon(sym, rate);
      const offset = Math.round(rate * 0.73);
      const buf = embed(pcm, offset, offset + pcm.length + rate, 800, 1, rate);
      const d = decodeBeacon(buf, rate);
      expect(d, `rate ${rate}`).not.toBeNull();
      expect(d!.slot).toBe(SLOT);
      expect(Math.abs(d!.t0Sample - (offset + pcm.length))).toBeLessThanOrEqual(Math.ceil(rate / 500));
    }
  });

  it('decodes a 48 kHz beacon recorded at 96 kHz (downsampled internally)', () => {
    const pcm48 = synthBeacon(sym, 48000);
    const pcm96 = new Int16Array(pcm48.length * 2);
    for (let i = 0; i < pcm48.length; i++) {
      pcm96[2 * i] = pcm48[i]!;
      pcm96[2 * i + 1] = Math.round((pcm48[i]! + (pcm48[i + 1] ?? 0)) / 2);
    }
    const offset = 50_000;
    const buf = embed(pcm96, offset, offset + pcm96.length + 10_000, 500, 1, 9);
    const d = decodeBeacon(buf, 96000)!;
    expect(d.slot).toBe(SLOT);
    expect(Math.abs(d.t0Sample - (offset + pcm96.length))).toBeLessThanOrEqual(200);
  });

  it('survives interfering tones outside the band and a preceding sound', () => {
    const pcm = synthBeacon(sym, 48000);
    const offset = 48_000;
    const len = offset + pcm.length + 4_800;
    const buf = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      let v = 4000 * Math.sin((2 * Math.PI * 440 * i) / 48000) + 2000 * Math.sin((2 * Math.PI * 9000 * i) / 48000);
      if (i < offset) v += 3000 * Math.sin((2 * Math.PI * 3000 * i) / 48000); // start sound
      const j = i - offset;
      if (j >= 0 && j < pcm.length) v += pcm[j]!;
      buf[i] = Math.round(v);
    }
    const d = decodeBeacon(buf, 48000)!;
    expect(d.slot).toBe(SLOT);
    expect(Math.abs(d.t0Sample - (offset + pcm.length))).toBeLessThanOrEqual(48);
  });

  it('returns null for noise, silence, truncated beacons and corrupted payloads', () => {
    expect(decodeBeacon(embed(new Int16Array(0), 0, 200_000, 3000, 1, 5), 48000)).toBeNull();
    expect(decodeBeacon(new Int16Array(150_000), 48000)).toBeNull();
    const pcm = synthBeacon(sym, 48000);
    expect(decodeBeacon(pcm.subarray(0, pcm.length - 4800), 48000)).toBeNull();
    // replace one payload symbol with a different tone ⇒ CRC fails
    const bad = [...sym];
    bad[20] = (bad[20]! + 5) % 16;
    expect(decodeBeacon(synthBeacon(bad, 48000), 48000)).toBeNull();
    expect(decodeBeacon(pcm, 8000)).toBeNull();
  });

  it('accepts float PCM input', () => {
    const pcm = synthBeacon(sym, 48000);
    const f = new Float32Array(pcm.length + 1000);
    for (let i = 0; i < pcm.length; i++) f[i + 1000] = pcm[i]! / 32768;
    const d = decodeBeacon(f, 48000)!;
    expect(d.slot).toBe(SLOT);
    expect(Math.abs(d.t0Sample - (1000 + pcm.length))).toBeLessThanOrEqual(2);
  });

  it('round-trips many random payloads with noise', () => {
    const r = rng(42);
    for (let t = 0; t < 12; t++) {
      const slot = BigInt(Math.floor(r() * 2 ** 40));
      const hash = Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256));
      const s = beaconSymbols(encodeBeaconPayload(slot, hash));
      const pcm = synthBeacon(s, 48000);
      const offset = Math.floor(r() * 30_000);
      const buf = embed(pcm, offset, offset + pcm.length + Math.floor(r() * 10_000), 1200, 0.8, 100 + t);
      const d = decodeBeacon(buf, 48000);
      expect(d, `trial ${t}`).not.toBeNull();
      expect(d!.slot).toBe(slot);
      expect(Array.from(d!.hashPrefix)).toEqual(Array.from(hash.subarray(0, 8)));
      expect(Math.abs(d!.t0Sample - (offset + pcm.length))).toBeLessThanOrEqual(48);
    }
  });
});
