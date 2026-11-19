// The upload bundle (DANCE-OFF §5): DanceUpload JSON + the key-frame JPEG parts.
import { DanceUpload } from '@youre-on/shared/evidence';
import { poseSha256 } from '@youre-on/shared/dance/pose';
import { ROUTINE_SHA256_PINS, ROUTINES, routineSha256 } from '@youre-on/shared/dance/routine';
import { scoreRound } from '@youre-on/shared/dance/score';
import { sha256Hex } from '@youre-on/shared/primitives';
import { describe, expect, it } from 'vitest';

import { selfTestSeries } from '../model/pipeline';
import {
  buildDanceUploadBundle,
  readSnapshots,
  usableSnapshots,
  type SnapshotBytes,
} from '../model/upload';
import { WAVE_POP } from './helpers';

const series = selfTestSeries(WAVE_POP);
const result = scoreRound(WAVE_POP, series);
const jpeg = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const snap = (t_ms: number, bytes: Uint8Array, sha256?: string): SnapshotBytes => ({
  t_ms,
  width: 288,
  height: 512,
  bytes,
  ...(sha256 !== undefined ? { sha256 } : {}),
});

describe('dance upload bundle', () => {
  it('every bundled routine hashes to its pin (the calibration self-test checks it on Hermes)', () => {
    for (const r of ROUTINES) expect(routineSha256(r), r.id).toBe(ROUTINE_SHA256_PINS[r.id]);
  });

  it('builds a valid DanceUpload with recomputed frame hashes, in time order', () => {
    const b1 = jpeg(1_000, 1);
    const b2 = jpeg(2_000, 2);
    const built = buildDanceUploadBundle({
      routine: WAVE_POP,
      series,
      result,
      clipSha256: 'ab'.repeat(32),
      snapshots: [snap(6_150, b2, sha256Hex(b2)), snap(2_150.4, b1, sha256Hex(b1))],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { upload, frames } = built.bundle;
    expect(DanceUpload.safeParse(upload).success).toBe(true);
    expect(built.hashMismatch).toBe(false);
    expect(upload.routine_id).toBe('wave-pop');
    expect(upload.routine_sha256).toBe(routineSha256(WAVE_POP));
    expect(upload.pose_sha256).toBe(poseSha256(series));
    expect(upload.client_scores).toEqual({ a: 1_000, b: 1_000 });
    expect(upload.clip_sha256).toBe('ab'.repeat(32));
    expect(frames.map((f) => [f.index, f.t_ms])).toEqual([
      [0, 2_150],
      [1, 6_150],
    ]);
    expect(frames[0]!.bytes).toBe(b1);
    expect(upload.frames.map((f) => f.sha256)).toEqual([sha256Hex(b1), sha256Hex(b2)]);
    expect(upload.frames.map((f) => f.bytes)).toEqual([1_000, 2_000]);
  });

  it('trusts the bytes, not the native hash (and says when they differ)', () => {
    const b = jpeg(10);
    const built = buildDanceUploadBundle({
      routine: WAVE_POP,
      series,
      result,
      clipSha256: null,
      snapshots: [snap(100, b, '00'.repeat(32))],
    });
    expect(built.ok && built.hashMismatch).toBe(true);
    if (built.ok) expect(built.bundle.upload.frames[0]!.sha256).toBe(sha256Hex(b));
  });

  it('a malformed clip hash becomes "no clip"', () => {
    const built = buildDanceUploadBundle({
      routine: WAVE_POP,
      series,
      result,
      clipSha256: 'not-a-hash',
      snapshots: [snap(100, jpeg(10))],
    });
    expect(built.ok && built.bundle.upload.clip_sha256).toBeNull();
  });

  it('needs at least one usable key frame', () => {
    const none = buildDanceUploadBundle({
      routine: WAVE_POP,
      series,
      result,
      clipSha256: null,
      snapshots: [snap(100, jpeg(0)), snap(200, jpeg(200_001))],
    });
    expect(none).toEqual({ ok: false, reason: 'no_frames', detail: 'no key frame' });
  });

  it('keeps at most six, drops empty / oversized / odd-sized ones', () => {
    const many = Array.from({ length: 8 }, (_, i) => snap(i * 1_000, jpeg(10)));
    expect(usableSnapshots(many)).toHaveLength(6);
    expect(usableSnapshots([{ ...snap(0, jpeg(10)), width: 0 }])).toEqual([]);
    expect(usableSnapshots([{ ...snap(0, jpeg(10)), height: 5_000 }])).toEqual([]);
    expect(usableSnapshots([snap(Number.NaN, jpeg(10))])).toEqual([]);
  });

  it('a series that breaks the schema is refused before it leaves', () => {
    const bad = { ...series, frames: [...series.frames].reverse() };
    const built = buildDanceUploadBundle({
      routine: WAVE_POP,
      series: bad,
      result,
      clipSha256: null,
      snapshots: [snap(100, jpeg(10))],
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.reason).toBe('invalid');
      expect(built.detail).toMatch(/^series\.frames/);
    }
  });
});

describe('readSnapshots', () => {
  it('reads each file and skips one that fails', async () => {
    const files: Record<string, Uint8Array> = { 'file:///a.jpg': jpeg(3, 1) };
    const out = await readSnapshots(
      [
        { t_ms: 1, uri: 'file:///a.jpg', width: 10, height: 20, sha256: 'x' },
        { t_ms: 2, uri: 'file:///missing.jpg', width: 10, height: 20, sha256: 'y' },
      ],
      async (uri) => {
        const b = files[uri];
        if (!b) throw new Error('missing');
        return b;
      },
    );
    expect(out).toEqual([{ t_ms: 1, width: 10, height: 20, bytes: jpeg(3, 1), sha256: 'x' }]);
  });
});
