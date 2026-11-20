// Planning D10: the shared judge-frame sampler (12 frames, 8 of them in the last ~1.2 s), the
// landing crop plan, the upload limits, and CameraEvidence's landing_crop flag.
import { describe, expect, it } from 'vitest';
import { CameraEvidence } from '../../src/evidence';
import {
  FRAME_END_GUARD_MS,
  FRAME_MAX_PX,
  fitSize,
  isLandingFrame,
  JUDGE_FRAMES,
  judgeFrameCount,
  judgeFramesProblem,
  judgeFrameTimesMs,
  LANDING_CROP_MAX_PX,
  LANDING_WINDOW_MS,
  landingCropPlan,
  landingStartMs,
  MAX_FRAME_BYTES,
  MAX_JUDGE_FRAMES,
  MAX_UPLOAD_IMAGES,
  MIN_JUDGE_FRAMES,
} from '../../src/judge/frames';

const increasing = (t: number[]) => t.every((x, i) => i === 0 || x > t[i - 1]!);

describe('judgeFrameTimesMs (D10)', () => {
  it('12 frames by default, at least 8 of them in the last 1.2 s, strictly increasing', () => {
    for (const d of [2500, 4200, 6000, 30_000]) {
      const t = judgeFrameTimesMs(d);
      expect(t).toHaveLength(JUDGE_FRAMES);
      expect(JUDGE_FRAMES).toBe(12);
      expect(increasing(t)).toBe(true);
      expect(t[0]).toBe(0);
      expect(t.at(-1)).toBe(d - FRAME_END_GUARD_MS);
      expect(t.filter((x) => x >= d - LANDING_WINDOW_MS).length).toBeGreaterThanOrEqual(8);
    }
  });

  it('the landing frames are even over the window; the lead-in covers the clip before it', () => {
    const t = judgeFrameTimesMs(6000);
    expect(t).toEqual([0, 1180, 2360, 3540, 4870, 5020, 5170, 5320, 5470, 5620, 5770, 5920]);
    expect(landingStartMs(6000)).toBe(4720);
    expect(t.map((x) => isLandingFrame(x, 6000))).toEqual([
      ...Array(4).fill(false),
      ...Array(8).fill(true),
    ]);
  });

  it('clamps the count to the server limits 8..12; 4 lead-in frames at any count', () => {
    expect(judgeFrameCount(3)).toBe(MIN_JUDGE_FRAMES);
    expect(judgeFrameCount(30)).toBe(MAX_JUDGE_FRAMES);
    expect(judgeFrameCount(Number.NaN)).toBe(JUDGE_FRAMES);
    for (let n = 8; n <= 12; n++) {
      const t = judgeFrameTimesMs(6000, n);
      expect(t).toHaveLength(n);
      expect(t.filter((x) => isLandingFrame(x, 6000))).toHaveLength(n - 4);
    }
    expect(judgeFrameTimesMs(6000, 3)).toHaveLength(8);
    expect(judgeFrameTimesMs(6000, 30)).toHaveLength(12);
  });

  it('survives very short clips (the window shrinks to 60 % of the clip)', () => {
    for (const d of [1, 60, 120, 900, 1500]) {
      const t = judgeFrameTimesMs(d);
      expect(t).toHaveLength(12);
      expect(increasing(t)).toBe(true);
      expect(t.every((x) => x >= 0)).toBe(true);
    }
    const t = judgeFrameTimesMs(1500);
    expect(t.at(-1)).toBe(1420);
    expect(t.filter((x) => isLandingFrame(x, 1500))).toHaveLength(8);
  });

  it("labels an older phone's 8 u4d4 frames: its dense last second is the landing", () => {
    // the pre-D10 phone: 4 uniform over the first 60 %, 4 over the last second
    const end = 6000 - FRAME_END_GUARD_MS;
    const dense = end - 1000;
    const u4d4 = [0, 1, 2, 3].map((i) => Math.round((dense * i) / 4));
    u4d4.push(...[1, 2, 3, 4].map((i) => Math.round(dense + (1000 * i) / 4)));
    expect(u4d4.map((x) => isLandingFrame(x, 6000))).toEqual([
      ...Array(4).fill(false),
      ...Array(4).fill(true),
    ]);
  });
});

describe('sizes', () => {
  it('frames fit 768 px, never upscaled', () => {
    expect(FRAME_MAX_PX).toBe(768);
    expect(fitSize(1280, 720)).toEqual({ width: FRAME_MAX_PX, height: 432 });
    expect(fitSize(720, 1280)).toEqual({ width: 432, height: FRAME_MAX_PX });
    expect(fitSize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it('the landing crop is the middle 80 % at native pixels for 720p, at most 1024 px', () => {
    expect(landingCropPlan(1280, 720)).toEqual({
      originX: 128,
      originY: 72,
      width: 1024,
      height: 576,
      outWidth: 1024,
      outHeight: 576,
    });
    // portrait, as a hand-held phone films
    expect(landingCropPlan(720, 1280)).toMatchObject({
      originX: 72,
      originY: 128,
      outWidth: 576,
      outHeight: 1024,
    });
    // 1080p: cropped, then scaled to 1024
    const p = landingCropPlan(1920, 1080);
    expect(p).toMatchObject({ originX: 192, originY: 108, width: 1536, height: 864 });
    expect(Math.max(p.outWidth, p.outHeight)).toBe(LANDING_CROP_MAX_PX);
    // the crop sits inside the still
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [641, 479],
      [1, 1],
    ] as const) {
      const c = landingCropPlan(w, h);
      expect(c.originX + c.width).toBeLessThanOrEqual(w);
      expect(c.originY + c.height).toBeLessThanOrEqual(h);
    }
  });

  it('per-JPEG cap is the DB CHECK (204800 B), crop included; 13 images at most', () => {
    expect(MAX_FRAME_BYTES).toBe(204_800);
    expect(MAX_UPLOAD_IMAGES).toBe(13);
  });
});

describe('judgeFramesProblem (upload limits)', () => {
  const frames = (n: number, crop?: number) =>
    Array.from({ length: n }, (_, i) => (i === crop ? { landing_crop: true } : {}));

  it('8..12 frames, with or without one landing crop last', () => {
    for (let n = 8; n <= 12; n++) {
      expect(judgeFramesProblem(frames(n))).toBeNull();
      expect(judgeFramesProblem(frames(n + 1, n))).toBeNull();
    }
  });

  it('refuses too few or too many frames (the crop is not counted)', () => {
    expect(judgeFramesProblem(frames(7))?.message).toBe('send 8 to 12 frames (got 7)');
    expect(judgeFramesProblem(frames(8, 7))?.message).toBe('send 8 to 12 frames (got 7)');
    expect(judgeFramesProblem(frames(13))?.message).toBe('send 8 to 12 frames (got 13)');
    expect(judgeFramesProblem(frames(14, 13))?.message).toBe('send 8 to 12 frames (got 13)');
  });

  it('refuses two crops, or a crop that is not last', () => {
    const two = [...frames(10), { landing_crop: true }, { landing_crop: true }];
    expect(judgeFramesProblem(two)?.path).toBe('evidence.frames');
    expect(judgeFramesProblem(frames(13, 5))).toEqual({
      path: 'evidence.frames.5.landing_crop',
      message: 'the landing crop must be the last frame',
    });
  });
});

describe('CameraEvidence.frames[].landing_crop', () => {
  const H = (c: string) => c.repeat(64);
  const ev = (frames: unknown[]) => ({
    schema_version: 1,
    kind: 'camera',
    bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
    attempt_no: 1,
    clip_sha256: H('a'),
    clip_bytes: 5_000_000,
    mime: 'video/quicktime',
    duration_ms: 6000,
    recorded_by: 'A',
    recorded_at: '2026-11-21T18:07:06.000Z',
    frames,
  });

  it('accepts landing_crop: true; an absent flag is a plain frame (older uploads)', () => {
    const t = judgeFrameTimesMs(6000);
    const frames: Record<string, unknown>[] = t.map((t_ms, index) => ({
      index,
      t_ms,
      sha256: H('b'),
    }));
    frames.push({ index: 12, t_ms: t.at(-1), sha256: H('c'), landing_crop: true });
    const parsed = CameraEvidence.parse(ev(frames));
    expect(parsed.frames.at(-1)!.landing_crop).toBe(true);
    expect(parsed.frames[0]!.landing_crop).toBeUndefined();
    expect(CameraEvidence.safeParse(ev(frames.slice(0, 8))).success).toBe(true);
  });

  it('the flag is true or absent, never false', () => {
    const f = { index: 0, t_ms: 0, sha256: H('b'), landing_crop: false };
    expect(CameraEvidence.safeParse(ev([f])).success).toBe(false);
  });
});
