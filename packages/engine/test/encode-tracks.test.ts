import { describe, expect, it } from 'vitest';
import {
  EngineError,
  buildPayload,
  decodeMarketBin,
  decodeProgram,
  decodeTrackBin,
  encodeCalibration,
  encodeMarketBin,
  encodeProgram,
  encodeTrackBin,
  splitPayload,
} from '../src/encode/index.js';
import { marketHash } from '../src/hash/index.js';
import type { DecodedProgram, TrackBufferData } from '../src/types.js';
import {
  MODEL_HASH,
  aiJudged,
  marketProgram,
  paperBall,
  paperBallCalibration,
  paperBallTracks,
  rec,
  zoneProgram,
} from './encode-fixtures.js';

function expectError(fn: () => unknown, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an EngineError').toBeInstanceOf(EngineError);
  expect((err as EngineError).code).toBe(code);
}
const expectMalformed = (fn: () => unknown): void => expectError(fn, 'MalformedTracks');

const mutate = (bin: Uint8Array, off: number, v: number): Uint8Array => {
  const out = bin.slice();
  out[off] = v;
  return out;
};

const dp: DecodedProgram = decodeProgram(encodeProgram(paperBall()));
const REC0 = 44 + 12 + 16; // records start for the 3-track, 2-segment fixture

describe('track_bin (§5.4)', () => {
  const t = paperBallTracks();
  const bin = encodeTrackBin(t);

  it('layout', () => {
    expect([...bin.slice(0, 12)]).toEqual([0x56, 0x54, 0x52, 0x4b, 1, 10, 3, 2, 0b10, 0, 0, 0]);
    expect([...bin.slice(44, 56)]).toEqual([0, 1, 0xb8, 0x0b, 1, 0xff, 0, 0, 2, 0xff, 0xb0, 0x04]);
    expect([...bin.slice(56, 72)]).toEqual([0, 0, 0, 0, 4, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0]);
    expect(bin.length).toBe(REC0 + 12 * 3 * 6);
    // frame 0, track 1 (ball) is absent → 12 zero bytes
    expect([...bin.slice(REC0 + 12, REC0 + 24)]).toEqual(new Array(12).fill(0));
    // frame 0, track 0: x0=0 y0=200 x1=300 y1=400 conf 90 fill 50 id 80 pose 1
    expect([...bin.slice(REC0, REC0 + 12)]).toEqual([0, 0, 200, 0, 0x2c, 1, 0x90, 1, 90, 50, 80, 1]);
  });

  it('round-trips', () => {
    expect(decodeTrackBin(bin, dp)).toEqual(t);
  });

  it('a conf-0 all-zero record decodes as null', () => {
    const t2 = paperBallTracks();
    t2.segments[0]!.frames[1]![1] = { x0: 0, y0: 0, x1: 0, y1: 0, conf: 0, fill: 0, id_conf: 0, pose: 0 };
    expect(decodeTrackBin(encodeTrackBin(t2), dp).segments[0]!.frames[1]![1]).toBeNull();
  });

  it('ai_judged minimal form', () => {
    const adp = decodeProgram(encodeProgram(aiJudged()));
    const min: TrackBufferData = { flags: 0b10, model_hash: '00'.repeat(32), tracks: [], segments: [] };
    const b = encodeTrackBin(min);
    expect(b.length).toBe(44);
    expect(decodeTrackBin(b, adp)).toEqual(min);
    // T = 0 segments are tolerated for ai_judged (§5.4 list; matches crates/verdict-rules),
    // but never together with window_unavailable.
    const withSeg = encodeTrackBin({ ...min, segments: [{ frame_start: 0, frames: [[]] }] });
    expect(decodeTrackBin(withSeg, adp).segments).toHaveLength(1);
    expectMalformed(() => decodeTrackBin(encodeTrackBin({ ...min, flags: 0b1010, segments: [{ frame_start: 0, frames: [[]] }] }), adp));
  });

  it('window_unavailable: S must be 0', () => {
    const w: TrackBufferData = { ...paperBallTracks(), flags: 0b1000, segments: [] };
    expect(decodeTrackBin(encodeTrackBin(w), dp).segments).toEqual([]);
    expectMalformed(() => decodeTrackBin(encodeTrackBin({ ...paperBallTracks(), flags: 0b1010 }), dp));
    expectMalformed(() => decodeTrackBin(encodeTrackBin({ ...paperBallTracks(), segments: [] }), dp));
  });

  it('frame limit: last frame < LIMIT + TAIL_FRAMES', () => {
    const limit = 180 * 10 + 20;
    const mk = (start: number, n: number): TrackBufferData => ({
      ...paperBallTracks(),
      segments: [{ frame_start: start, frames: Array.from({ length: n }, () => [null, null, null]) }],
    });
    expect(() => decodeTrackBin(encodeTrackBin(mk(limit - 1, 1)), dp)).not.toThrow();
    expectMalformed(() => decodeTrackBin(encodeTrackBin(mk(limit, 1)), dp));
    expectMalformed(() => decodeTrackBin(encodeTrackBin(mk(limit - 5, 6)), dp));
  });

  it('Σ n_frames ≤ MAX_EVAL_FRAMES', () => {
    const mk = (n: number): TrackBufferData => ({
      ...paperBallTracks(),
      segments: [{ frame_start: 0, frames: Array.from({ length: n }, () => [null, null, null]) }],
    });
    expect(() => decodeTrackBin(encodeTrackBin(mk(1024)), dp)).not.toThrow();
    expectMalformed(() => decodeTrackBin(encodeTrackBin(mk(1025)), dp));
  });

  it('16 segments ok, adjacent segments ok', () => {
    const segs = Array.from({ length: 16 }, (_, i) => ({ frame_start: i * 2, frames: [[null, null, null], [null, null, null]] }));
    expect(decodeTrackBin(encodeTrackBin({ ...paperBallTracks(), segments: segs }), dp).segments.length).toBe(16);
    expectMalformed(() => encodeTrackBin({ ...paperBallTracks(), segments: [...segs, { frame_start: 40, frames: [[null, null, null]] }] }));
  });

  describe('decoder rejections → MalformedTracks', () => {
    it('header: magic, version, fps, reserved, flag bits 5-7', () => {
      expectMalformed(() => decodeTrackBin(mutate(bin, 3, 0), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, 4, 2), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, 5, 30), dp));
      for (const off of [9, 10, 11]) expectMalformed(() => decodeTrackBin(mutate(bin, off, 1), dp));
      for (const bit of [0x20, 0x40, 0x80]) expectMalformed(() => decodeTrackBin(mutate(bin, 8, 0b10 | bit), dp));
      // advisory bits 0,2,4 are fine
      expect(() => decodeTrackBin(mutate(bin, 8, 0b10111), dp)).not.toThrow();
    });

    it('T ≠ number of referenced entities; track table mismatch', () => {
      expectMalformed(() => decodeTrackBin(mutate(bin, 6, 2), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, 6, 4), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, 44, 1), dp)); // wrong entity
      expectMalformed(() => decodeTrackBin(mutate(bin, 45, 0), dp)); // wrong participant for person
      expectMalformed(() => decodeTrackBin(mutate(bin, 49, 0), dp)); // object must be 0xFF
      const t2 = paperBallTracks();
      t2.tracks = [t2.tracks[1]!, t2.tracks[0]!, t2.tracks[2]!];
      expectMalformed(() => decodeTrackBin(encodeTrackBin(t2), dp));
    });

    it('market programs do not take track_bin', () => {
      expectMalformed(() => decodeTrackBin(bin, decodeProgram(encodeProgram(marketProgram()))));
    });

    it('segments: n_frames 0, reserved, order, overlap, S > 16', () => {
      expectMalformed(() => decodeTrackBin(mutate(bin, 60, 0), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, 62, 1), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, 64, 2), dp)); // second starts at 2 < 0 + 4
      expect(() => decodeTrackBin(mutate(bin, 64, 4), dp)).not.toThrow(); // adjacent
      expectMalformed(() => decodeTrackBin(mutate(bin, 7, 17), dp));
    });

    it('record section length must be exactly 12·T·Σn', () => {
      expectMalformed(() => decodeTrackBin(Uint8Array.from([...bin, 0]), dp));
      expectMalformed(() => decodeTrackBin(bin.slice(0, bin.length - 1), dp));
      expectMalformed(() => decodeTrackBin(bin.slice(0, bin.length - 12), dp));
      for (const n of [0, 10, 44, 50, 60]) expectMalformed(() => decodeTrackBin(bin.slice(0, n), dp));
    });

    it('record constraints', () => {
      const r = REC0; // frame 0, track 0 (person)
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 8, 101), dp)); // conf > 100
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 9, 101), dp)); // fill > 100
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 10, 101), dp)); // id_conf > 100
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 11, 0x08), dp)); // pose reserved bit
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 11, 0x06), dp)); // rep_low & rep_high
      expect(() => decodeTrackBin(mutate(bin, r + 11, 0x05), dp)).not.toThrow();
      // x0 > x1: x0 = 0x0200 > x1 = 0x012c
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 1, 2), dp));
      // x1 > 10000
      expectMalformed(() => decodeTrackBin(mutate(mutate(bin, r + 4, 0x11), r + 5, 0x27), dp));
      // y0 > y1
      expectMalformed(() => decodeTrackBin(mutate(bin, r + 3, 2), dp));
      // absent record with a non-zero field
      const absent = REC0 + 12; // frame 0 track 1 (ball) is null
      for (let k = 0; k < 12; k++) {
        if (k === 8) continue;
        expectMalformed(() => decodeTrackBin(mutate(bin, absent + k, 1), dp));
      }
      // id_conf on an object track; pose on an object track
      const obj = REC0 + 24; // frame 0, track 2 (can)
      expectMalformed(() => decodeTrackBin(mutate(bin, obj + 10, 1), dp));
      expectMalformed(() => decodeTrackBin(mutate(bin, obj + 11, 1), dp));
    });

    it('person_any tracks may carry pose but not id_conf', () => {
      const p = zoneProgram();
      p.entities.push({ name: 'crowd', kind: 'person_any' });
      p.legs[0]!.success = { op: 'standing', a: { e: 'crowd' } };
      const zdp = decodeProgram(encodeProgram(p));
      expect(zdp.tracked_entities).toEqual([3]);
      const mk = (q = rec({ pose: 1 })): TrackBufferData => ({
        flags: 2,
        model_hash: MODEL_HASH,
        tracks: [{ entity_idx: 3, participant_idx: null, ref_h: 0 }],
        segments: [{ frame_start: 5, frames: [[q]] }],
      });
      expect(() => decodeTrackBin(encodeTrackBin(mk()), zdp)).not.toThrow();
      expectMalformed(() => decodeTrackBin(encodeTrackBin(mk(rec({ id_conf: 5 }))), zdp));
    });
  });

  describe('encoder rejections', () => {
    it('bad header, table, records', () => {
      expectMalformed(() => encodeTrackBin({ ...t, flags: 0x20 }));
      expectMalformed(() => encodeTrackBin({ ...t, model_hash: 'AB'.repeat(32) }));
      expectMalformed(() => encodeTrackBin({ ...t, tracks: [{ entity_idx: 0, participant_idx: 255, ref_h: 0 }, ...t.tracks.slice(1)] }));
      expectMalformed(() => encodeTrackBin({ ...t, tracks: [{ entity_idx: 0, participant_idx: 1, ref_h: 65536 }, ...t.tracks.slice(1)] }));
      expectMalformed(() => encodeTrackBin({ ...t, segments: [{ frame_start: 0, frames: [] }] }));
      expectMalformed(() => encodeTrackBin({ ...t, segments: [{ frame_start: 0, frames: [[null, null]] }] }));
      expectMalformed(() => encodeTrackBin({ ...t, segments: [{ frame_start: 0, frames: [[rec({ conf: 0 }), null, null]] }] }));
      expectMalformed(() => encodeTrackBin({ ...t, segments: [{ frame_start: 0, frames: [[rec({ x0: 400 }), null, null]] }] }));
      expectMalformed(() => encodeTrackBin({ ...t, segments: [{ frame_start: -1, frames: [[null, null, null]] }] }));
      expectMalformed(() =>
        encodeTrackBin({
          ...t,
          segments: [
            { frame_start: 10, frames: [[null, null, null]] },
            { frame_start: 5, frames: [[null, null, null]] },
          ],
        }),
      );
    });
  });
});

describe('market_bin (§5.5)', () => {
  const entries = [
    { market_hash: marketHash('EV1', 'C1'), result: 1 as const },
    { market_hash: marketHash('EV2', 'C9'), result: 2 as const },
  ];
  const bin = encodeMarketBin(entries);

  it('layout and round trip', () => {
    expect([...bin.slice(0, 8)]).toEqual([0x56, 0x4d, 0x4b, 0x54, 1, 2, 0, 0]);
    expect(bin.length).toBe(8 + 33 * 2);
    expect(decodeMarketBin(bin)).toEqual(entries);
    expect(decodeMarketBin(encodeMarketBin([]))).toEqual([]);
  });

  it('rejections → MalformedTracks', () => {
    expectMalformed(() => decodeMarketBin(mutate(bin, 0, 0)));
    expectMalformed(() => decodeMarketBin(mutate(bin, 4, 2)));
    expectMalformed(() => decodeMarketBin(mutate(bin, 6, 1)));
    expectMalformed(() => decodeMarketBin(mutate(bin, 7, 1)));
    expectMalformed(() => decodeMarketBin(mutate(bin, 8 + 32, 3)));
    expectMalformed(() => decodeMarketBin(Uint8Array.from([...bin, 0])));
    expectMalformed(() => decodeMarketBin(bin.slice(0, bin.length - 1)));
    expectMalformed(() => decodeMarketBin(mutate(bin, 5, 3)));
    const dup = Uint8Array.from([...mutate(bin, 5, 3), ...bin.slice(8, 41)]);
    expectMalformed(() => decodeMarketBin(dup));
    expectMalformed(() => encodeMarketBin([entries[0]!, entries[0]!]));
    expectMalformed(() => encodeMarketBin([{ market_hash: entries[0]!.market_hash, result: 3 as 2 }]));
  });
});

describe('payload (§5.6)', () => {
  it('build + split for rules', () => {
    const p = paperBall();
    const pb = encodeProgram(p);
    const cb = encodeCalibration(paperBallCalibration(), p);
    const tb = encodeTrackBin(paperBallTracks());
    const payload = buildPayload(pb, cb, tb);
    expect(payload.length).toBe(pb.length + cb.length + tb.length);
    const s = splitPayload(payload);
    expect(s.program_bin).toEqual(pb);
    expect(s.calibration_bin).toEqual(cb);
    expect(s.tracks_bin).toEqual(tb);
    expect(s.tracks).toEqual(paperBallTracks());
    expect(s.market).toBeNull();
    expect(s.calibration.regions.length).toBe(1);
  });

  it('SP1-only payload has no third part', () => {
    const p = paperBall();
    const s = splitPayload(buildPayload(encodeProgram(p), encodeCalibration(paperBallCalibration(), p)));
    expect(s.tracks_bin).toBeUndefined();
    expect(s.tracks).toBeNull();
  });

  it('market payload: empty calibration + market_bin', () => {
    const p = marketProgram();
    const mb = encodeMarketBin([{ market_hash: marketHash('EV1', 'C1'), result: 0 }]);
    const s = splitPayload(buildPayload(encodeProgram(p), encodeCalibration(null, p), mb));
    expect(s.calibration_bin.length).toBe(0);
    expect(s.market).toEqual([{ market_hash: marketHash('EV1', 'C1'), result: 0 }]);
  });

  it('ai_judged payload', () => {
    const p = aiJudged();
    const tb = encodeTrackBin({ flags: 0b10, model_hash: MODEL_HASH, tracks: [], segments: [] });
    const s = splitPayload(buildPayload(encodeProgram(p), encodeCalibration(null, p), tb));
    expect(s.tracks!.flags).toBe(2);
  });

  it('BufferTooLarge above MAX_BUFFER_PAYLOAD', () => {
    const big = new Uint8Array(10000);
    expect(buildPayload(big, new Uint8Array(0)).length).toBe(10000);
    expectError(() => buildPayload(big, new Uint8Array(1)), 'BufferTooLarge');
    expectError(() => splitPayload(new Uint8Array(10001)), 'BufferTooLarge');
  });

  it('split surfaces decoder errors', () => {
    const p = paperBall();
    const pb = encodeProgram(p);
    const cb = encodeCalibration(paperBallCalibration(), p);
    expectError(() => splitPayload(Uint8Array.from([0, ...pb])), 'MalformedProgram');
    expectError(() => splitPayload(buildPayload(pb, mutate(cb, 0, 0))), 'MalformedCalibration');
    expectError(() => splitPayload(buildPayload(pb, cb, Uint8Array.of(1, 2, 3))), 'MalformedTracks');
  });
});
