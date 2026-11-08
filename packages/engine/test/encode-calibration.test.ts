import { describe, expect, it } from 'vitest';
import {
  EngineError,
  calibrationHash,
  decodeCalibration,
  decodeProgram,
  encodeCalibration,
  encodeProgram,
} from '../src/encode/index.js';
import { ZERO_HASH_HEX, bytesToHex, sceneHash, sha256Hex } from '../src/hash/index.js';
import type { Calibration } from '../src/types.js';
import {
  aiJudged,
  marketProgram,
  paperBall,
  paperBallCalibration,
  zoneCalibration,
  zoneProgram,
} from './encode-fixtures.js';

function expectMalformed(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an EngineError').toBeInstanceOf(EngineError);
  expect((err as EngineError).code).toBe('MalformedCalibration');
}

const mutate = (bin: Uint8Array, off: number, v: number): Uint8Array => {
  const out = bin.slice();
  out[off] = v;
  return out;
};

describe('calibration_bin (§5.3)', () => {
  const p = paperBall();
  const dp = decodeProgram(encodeProgram(p));
  const c = paperBallCalibration();
  const bin = encodeCalibration(c, p);

  it('layout for §15.1', () => {
    expect([...bin.slice(0, 8)]).toEqual([0x56, 0x43, 0x41, 0x4c, 1, 1, 0, 0]);
    expect(bytesToHex(bin.slice(8, 40))).toBe(sceneHash(c));
    // entity 3 (line), shape 0, 2 points, behind_sign +1, (3000,6000), (3000,10000)
    expect([...bin.slice(40)]).toEqual([3, 0, 2, 1, 0xb8, 0x0b, 0x70, 0x17, 0xb8, 0x0b, 0x10, 0x27]);
    expect(bin.length).toBe(52);
  });

  it('round-trips and calibration_hash = sha256(bin)', () => {
    const dc = decodeCalibration(bin, dp);
    expect(dc).toEqual({
      scene_hash: sceneHash(c),
      regions: [{ entity_idx: 3, shape: 0, points: [[3000, 6000], [3000, 10000]], behind_sign: 1 }],
    });
    expect(calibrationHash(c, p)).toBe(sha256Hex(bin));
  });

  it('sorts regions by entity index and encodes zones with behind_sign 0', () => {
    const zp = zoneProgram();
    const zbin = encodeCalibration(zoneCalibration(), zp);
    const dc = decodeCalibration(zbin, decodeProgram(encodeProgram(zp)));
    expect(dc.regions.map((r) => [r.entity_idx, r.shape, r.points.length, r.behind_sign])).toEqual([
      [1, 1, 4, 0],
      [2, 0, 2, -1],
    ]);
    expect(zbin[40 + 4 + 16 + 3]).toBe(0xff); // i8 -1
  });

  it('ai_judged / market: empty bin and zero hash', () => {
    for (const q of [aiJudged(), marketProgram()]) {
      expect(encodeCalibration(null, q)).toEqual(new Uint8Array(0));
      expect(calibrationHash(null, q)).toBe(ZERO_HASH_HEX);
      const dq = decodeProgram(encodeProgram(q));
      expect(decodeCalibration(new Uint8Array(0), dq)).toEqual({ scene_hash: ZERO_HASH_HEX, regions: [] });
      expectMalformed(() => decodeCalibration(bin, dq));
    }
  });

  it('rules program without regions: R = 0', () => {
    const q = paperBall();
    q.entities = q.entities.slice(0, 3);
    q.legs[0]!.valid_attempt = { op: 'released_by', a: { e: 'ball' }, b: { e: 'shooter' } };
    const cal: Calibration = { ...c, regions: [] };
    const b = encodeCalibration(cal, q);
    expect(b.length).toBe(40);
    expect(decodeCalibration(b, decodeProgram(encodeProgram(q))).regions).toEqual([]);
  });

  describe('encoder rejections', () => {
    it('missing / duplicate / unknown / non-region entity', () => {
      expectMalformed(() => encodeCalibration({ ...c, regions: [] }, p));
      expectMalformed(() => encodeCalibration({ ...c, regions: [c.regions[0]!, c.regions[0]!] }, p));
      expectMalformed(() =>
        encodeCalibration({ ...c, regions: [...c.regions, { entity: 'nope', shape: 'zone', points: [[0, 0], [1, 1], [2, 0]] }] }, p),
      );
      expectMalformed(() =>
        encodeCalibration({ ...c, regions: [...c.regions, { entity: 'ball', shape: 'zone', points: [[0, 0], [1, 1], [2, 0]] }] }, p),
      );
      expectMalformed(() => encodeCalibration(null, p));
    });
    it('shape mismatch, bad points, degenerate line, bad sign', () => {
      expectMalformed(() => encodeCalibration({ ...c, regions: [{ entity: 'line', shape: 'zone', points: [[0, 0], [1, 1], [2, 0]] }] }, p));
      expectMalformed(() => encodeCalibration({ ...c, regions: [{ entity: 'line', shape: 'line', points: [[5, 5], [5, 5]], behind_sign: 1 }] }, p));
      expectMalformed(() => encodeCalibration({ ...c, regions: [{ entity: 'line', shape: 'line', points: [[0, 0], [10001, 5]], behind_sign: 1 }] }, p));
      expectMalformed(() => encodeCalibration({ ...c, regions: [{ entity: 'line', shape: 'line', points: [[0, 0], [1.5, 5]], behind_sign: 1 }] }, p));
      expectMalformed(() =>
        encodeCalibration({ ...c, regions: [{ entity: 'line', shape: 'line', points: [[0, 0], [1, 5]], behind_sign: 0 as 1 }] }, p),
      );
      const zp = zoneProgram();
      const zc = zoneCalibration();
      const nine = Array.from({ length: 9 }, (_, i) => [i, i * 2] as [number, number]);
      expectMalformed(() => encodeCalibration({ ...zc, regions: [zc.regions[0]!, { entity: 'goal', shape: 'zone', points: nine }] }, zp));
      expectMalformed(() =>
        encodeCalibration({ ...zc, regions: [zc.regions[0]!, { entity: 'goal', shape: 'zone', points: [[0, 0], [1, 1]] }] }, zp),
      );
      expect(() =>
        encodeCalibration({ ...zc, regions: [zc.regions[0]!, { entity: 'goal', shape: 'zone', points: nine.slice(0, 8) }] }, zp),
      ).not.toThrow();
      expect(() =>
        encodeCalibration({ ...zc, regions: [zc.regions[0]!, { entity: 'goal', shape: 'zone', points: [[0, 0], [10000, 10000], [0, 10000]] }] }, zp),
      ).not.toThrow();
    });
    it('non-canonical scene JSON', () => {
      const bad = paperBallCalibration();
      (bad.scene.camera as { pose?: unknown }).pose = { pitch_cdeg: 1.5, roll_cdeg: 0 };
      expectMalformed(() => encodeCalibration(bad, p));
    });
  });

  describe('decoder rejections → MalformedCalibration', () => {
    const zp = zoneProgram();
    const zdp = decodeProgram(encodeProgram(zp));
    const zbin = encodeCalibration(zoneCalibration(), zp);
    // region 0 at 40: entity 1 zone (4 hdr + 4×4 pts = 20 B); region 1 at 60: entity 2 line (4 + 8)
    it('valid zone program calibration decodes', () => {
      expect(() => decodeCalibration(zbin, zdp)).not.toThrow();
    });
    it('bad magic / version / reserved', () => {
      expectMalformed(() => decodeCalibration(mutate(bin, 0, 0), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 4, 2), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 6, 1), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 7, 1), dp));
    });
    it('region for a non-region entity / out of range', () => {
      expectMalformed(() => decodeCalibration(mutate(bin, 40, 1), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 40, 9), dp));
    });
    it('missing or duplicate region', () => {
      const missing = mutate(bin, 5, 0).slice(0, 40);
      expectMalformed(() => decodeCalibration(missing, dp));
      const dup = Uint8Array.from([...mutate(bin, 5, 2), ...bin.slice(40)]);
      expectMalformed(() => decodeCalibration(dup, dp));
      // R larger than the number of regions present (truncated)
      expectMalformed(() => decodeCalibration(mutate(bin, 5, 2), dp));
    });
    it('unsorted regions', () => {
      const r0 = zbin.slice(40, 60);
      const r1 = zbin.slice(60);
      const swapped = Uint8Array.from([...zbin.slice(0, 40), ...r1, ...r0]);
      expectMalformed(() => decodeCalibration(swapped, zdp));
    });
    it('shape mismatch, n_points, behind_sign', () => {
      expectMalformed(() => decodeCalibration(mutate(bin, 41, 1), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 41, 2), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 42, 3), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 43, 0), dp));
      expectMalformed(() => decodeCalibration(mutate(bin, 43, 2), dp));
      expect(decodeCalibration(mutate(bin, 43, 0xff), dp).regions[0]!.behind_sign).toBe(-1);
      expectMalformed(() => decodeCalibration(mutate(zbin, 43, 1), zdp)); // zone sign ≠ 0
      expectMalformed(() => decodeCalibration(mutate(zbin, 42, 2), zdp)); // zone with 2 points
    });
    it('coordinates > 10000 and degenerate line', () => {
      // x of point 1 = 10001 (0x2711)
      const big = mutate(mutate(bin, 48, 0x11), 49, 0x27);
      expectMalformed(() => decodeCalibration(big, dp));
      const edge = mutate(mutate(bin, 48, 0x10), 49, 0x27);
      expect(decodeCalibration(edge, dp).regions[0]!.points[1]).toEqual([10000, 10000]);
      const degenerate = Uint8Array.from([...bin.slice(0, 48), ...bin.slice(44, 48)]);
      expectMalformed(() => decodeCalibration(degenerate, dp));
    });
    it('trailing bytes and truncation', () => {
      expectMalformed(() => decodeCalibration(Uint8Array.from([...bin, 0]), dp));
      for (const n of [0, 4, 39, 40, 44, 51]) expectMalformed(() => decodeCalibration(bin.slice(0, n), dp));
    });
  });
});
