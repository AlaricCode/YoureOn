import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildMultipart } from '../../net/multipart';
import {
  buildEvidence,
  capturePlan,
  ACTION_WINDOW_MS,
  DEFAULT_FRAMES,
  LEAD_FRAMES,
  encodeSteps,
  fitUnderCap,
  FRAME_MAX_PX,
  frameTimesMs,
  hashFrames,
  JPEG_QUALITIES,
  LANDING_CROP_MAX_PX,
  MAX_FRAME_BYTES,
  mimeForUri,
  runCapturePlan,
  shotTransform,
  type CapturedFrame,
} from '../frames';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const increasing = (t: number[]) => t.every((x, i) => i === 0 || x > t[i - 1]!);

describe('frame sampling (planning D10)', () => {
  it('12 frames by default, strictly increasing, inside the clip, 9 over the last 2.7 s', () => {
    const t = frameTimesMs(6000);
    expect(DEFAULT_FRAMES).toBe(12);
    expect(t).toHaveLength(12);
    expect(increasing(t)).toBe(true);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBe(6000 - 80);
    expect(t.filter((x) => x >= 6000 - 80 - ACTION_WINDOW_MS)).toHaveLength(12 - LEAD_FRAMES);
    // the action window is evenly spaced, no gap wider than ~340 ms
    const gaps = t.slice(LEAD_FRAMES).map((x, i, a) => (i ? x - a[i - 1]! : 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(340);
  });

  it('a throw is in the window even when Stop comes a second or two after it lands', () => {
    // seen on a device: a 2.9 s clip, the ball released at 1.19 s; a 4.3 s clip, released ~2.3 s.
    // The shared sampler left a 0.55 s and a 0.9 s gap right after the release.
    for (const [duration, releaseMs] of [
      [2867, 1190],
      [4302, 2300],
    ] as const) {
      const t = frameTimesMs(duration);
      const flight = t.filter((x) => x >= releaseMs && x <= releaseMs + 700);
      expect(flight.length, `${duration}`).toBeGreaterThanOrEqual(2);
      const after = t.filter((x) => x > releaseMs + 700);
      expect(after.length, `${duration}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('a short clip: the window is three quarters of it', () => {
    const t = frameTimesMs(3000);
    const start = 2920 - 2920 * 0.75;
    expect(t.filter((x) => x >= start)).toHaveLength(9);
    expect(t.filter((x) => x < start)).toHaveLength(3);
  });

  it('clamps the count to 8..12 and survives very short clips', () => {
    expect(frameTimesMs(6000, 3)).toHaveLength(8);
    expect(frameTimesMs(6000, 30)).toHaveLength(12);
    const short = frameTimesMs(120);
    expect(short).toHaveLength(12);
    expect(increasing(short)).toBe(true);
  });
});

describe('capture plan: 12 stills + the landing crop of the last one', () => {
  it('one shot per frame time, then the crop at the last instant', () => {
    const plan = capturePlan(6000);
    expect(plan).toHaveLength(13);
    expect(plan.slice(0, 12).map((s) => s.t_ms)).toEqual(frameTimesMs(6000));
    expect(plan.slice(0, 12).every((s) => s.kind === 'frame')).toBe(true);
    expect(plan[12]).toEqual({ t_ms: frameTimesMs(6000).at(-1), kind: 'landing_crop' });
    expect(capturePlan(6000, 12, false)).toHaveLength(12);
    expect(capturePlan(6000, 8)).toHaveLength(9);
  });

  it("frames keep the 720p clip's own pixels; the crop is its middle 80 %", () => {
    // nothing to resize: the still is already 1280 px on its long side
    expect(shotTransform('frame', 1280, 720)).toEqual({ crop: null, resize: null });
    expect(shotTransform('frame', 720, 1280).resize).toBeNull();
    expect(shotTransform('frame', 1920, 1080).resize).toEqual({ width: FRAME_MAX_PX, height: 720 });
    expect(shotTransform('landing_crop', 1280, 720)).toEqual({
      crop: { originX: 128, originY: 72, width: 1024, height: 576 },
      resize: null,
    });
    // a 1080p still: cropped, then scaled to 1024
    const big = shotTransform('landing_crop', 1920, 1080);
    expect(big.crop).toEqual({ originX: 192, originY: 108, width: 1536, height: 864 });
    expect(big.resize).toEqual({ width: LANDING_CROP_MAX_PX, height: 576 });
    // small stills are never scaled up
    expect(shotTransform('frame', 320, 240)).toEqual({ crop: null, resize: null });
  });
});

describe('evidence', () => {
  const jpeg = (n: number) => new Uint8Array(1000 + n).fill(n);
  const frames: CapturedFrame[] = frameTimesMs(6000).map((t_ms, i) => ({ t_ms, jpeg: jpeg(i) }));
  const withCrop: CapturedFrame[] = [
    ...frames,
    { t_ms: frames.at(-1)!.t_ms, jpeg: jpeg(99), landing_crop: true },
  ];
  const evidenceOf = (f: readonly CapturedFrame[], clip = new Uint8Array(5000).fill(7)) =>
    buildEvidence({
      bet_id: BET,
      attempt_no: 2,
      clip,
      mime: 'video/quicktime',
      duration_ms: 5999.6,
      recorded_by: 'A',
      recorded_at: '2026-11-21T18:07:06.000Z',
      frames: f,
    });

  it('hashes each frame (sha256 hex, matching Node) in send order; the crop is flagged', () => {
    const h = hashFrames(withCrop);
    expect(h.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    h.forEach((f, i) => expect(f.sha256).toBe(nodeSha(withCrop[i]!.jpeg)));
    expect(h.slice(0, 12).every((f) => !('landing_crop' in f))).toBe(true);
    expect(h[12]).toMatchObject({ index: 12, t_ms: 5920, landing_crop: true });
  });

  it('builds a valid CameraEvidence with the clip hash, 12 frames + the crop', () => {
    const clip = new Uint8Array(5000).fill(7);
    const e = evidenceOf(withCrop, clip);
    expect(e.clip_sha256).toBe(nodeSha(clip));
    expect(e.clip_bytes).toBe(5000);
    expect(e.duration_ms).toBe(6000);
    expect(e.frames).toHaveLength(13);
    expect(e.frames.at(-1)!.landing_crop).toBe(true);
    // without the crop (it failed to render) the 12 frames still go
    expect(evidenceOf(frames).frames).toHaveLength(12);
  });

  it('refuses what the server would: oversized or empty JPEGs, bad counts, a crop not last', () => {
    const big = [...frames.slice(0, 11), { t_ms: 5920, jpeg: new Uint8Array(MAX_FRAME_BYTES + 1) }];
    expect(() => evidenceOf(big)).toThrow(/frame size/);
    const empty = [...frames.slice(0, 11), { t_ms: 5920, jpeg: new Uint8Array(0) }];
    expect(() => evidenceOf(empty)).toThrow(/frame size/);
    expect(() => evidenceOf(frames.slice(0, 7))).toThrow(/send 8 to 12 frames/);
    const early = [withCrop[12]!, ...frames];
    expect(() => evidenceOf(early)).toThrow(/landing crop must be the last/);
  });

  it('mime from the file extension', () => {
    expect(mimeForUri('file:///x/clip.mov')).toBe('video/quicktime');
    expect(mimeForUri('file:///x/clip.mp4')).toBe('video/mp4');
  });

  it('multipart: evidence first, then frames in index order, bytes intact', () => {
    const mp = buildMultipart(
      [
        { name: 'evidence', contentType: 'application/json', body: '{"k":1}' },
        {
          name: 'frame',
          filename: '00.jpg',
          contentType: 'image/jpeg',
          body: new Uint8Array([0, 255, 13, 10]),
        },
      ],
      'B',
    );
    const text = Buffer.from(mp.bytes).toString('latin1');
    expect(mp.contentType).toBe('multipart/form-data; boundary=B');
    expect(text).toBe(
      '--B\r\nContent-Disposition: form-data; name="evidence"\r\nContent-Type: application/json\r\n\r\n{"k":1}\r\n' +
        '--B\r\nContent-Disposition: form-data; name="frame"; filename="00.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\u0000ÿ\r\n\r\n' +
        '--B--\r\n',
    );
  });
});

describe('the per-image cap: step down, else drop (never send what the server refuses)', () => {
  const evidenceOf = (f: readonly CapturedFrame[]) =>
    buildEvidence({
      bet_id: BET,
      attempt_no: 1,
      clip: new Uint8Array(5000).fill(7),
      mime: 'video/quicktime',
      duration_ms: 6000,
      recorded_by: 'A',
      recorded_at: '2026-11-21T18:07:06.000Z',
      frames: f,
    });
  /** A JPEG of `n` bytes. */
  const bytes = (n: number) => new Uint8Array(n).fill(1);
  const plan = capturePlan(6000);

  it('every quality at full size, then smaller sizes: the crop goes 1024 -> 768 -> 512 px', () => {
    const steps = encodeSteps({ width: LANDING_CROP_MAX_PX, height: 576 });
    expect(steps.slice(0, 4)).toEqual(
      JPEG_QUALITIES.map((quality) => ({ quality, width: 1024, height: 576 })),
    );
    expect(JPEG_QUALITIES).toEqual([0.8, 0.65, 0.5, 0.35]);
    expect(steps.slice(4).map((s) => `${s.width}x${s.height}@${s.quality}`)).toEqual([
      '768x432@0.5',
      '768x432@0.35',
      '512x288@0.5',
      '512x288@0.35',
    ]);
    // a frame steps down the same way, from 1280 px: quality first, size only after that
    const frame = encodeSteps({ width: FRAME_MAX_PX, height: 720 });
    expect(frame.slice(0, 4).every((s) => s.width === 1280 && s.height === 720)).toBe(true);
    expect(frame.at(-1)).toEqual({ quality: 0.35, width: 640, height: 360 });
  });

  it('fitUnderCap: the first step under 200 KB wins; none fits -> null', async () => {
    const steps = encodeSteps({ width: 1024, height: 576 });
    const tried: string[] = [];
    // over the cap at full size whatever the quality; fits at 768 px
    const jpeg = await fitUnderCap(steps, async (s) => {
      tried.push(`${s.width}@${s.quality}`);
      return bytes(s.width === 1024 ? MAX_FRAME_BYTES + 1 : MAX_FRAME_BYTES);
    });
    expect(jpeg?.length).toBe(MAX_FRAME_BYTES);
    expect(tried).toEqual(['1024@0.8', '1024@0.65', '1024@0.5', '1024@0.35', '768@0.5']);
    expect(await fitUnderCap(steps, async () => bytes(MAX_FRAME_BYTES + 1))).toBeNull();
    expect(await fitUnderCap(steps, async () => bytes(0))).toBeNull();
  });

  it('a crop still over the cap is dropped: the 12 frames go, and the upload builds', async () => {
    const warned: string[] = [];
    const out = await runCapturePlan(
      plan,
      async (shot) => (shot.kind === 'frame' ? bytes(1000) : null),
      (m) => warned.push(m),
    );
    expect(out).toHaveLength(12);
    expect(out.some((f) => f.landing_crop)).toBe(false);
    expect(warned).toEqual([expect.stringMatching(/landing crop dropped/)]);
    expect(evidenceOf(out).frames).toHaveLength(12);
  });

  it('an oversized crop returned anyway is dropped, never sent', async () => {
    const out = await runCapturePlan(plan, async (shot) =>
      bytes(shot.kind === 'frame' ? 1000 : MAX_FRAME_BYTES + 1),
    );
    expect(out).toHaveLength(12);
    expect(out.every((f) => f.jpeg.length <= MAX_FRAME_BYTES)).toBe(true);
    expect(() => evidenceOf(out)).not.toThrow();
  });

  it('a crop that fails to render is dropped too (the catch path)', async () => {
    const warned: string[] = [];
    const out = await runCapturePlan(
      plan,
      async (shot) => {
        if (shot.kind === 'landing_crop') throw new Error('render failed');
        return bytes(1000);
      },
      (m) => warned.push(m),
    );
    expect(out).toHaveLength(12);
    expect(warned).toEqual(['landing crop skipped: render failed']);
  });

  it('a crop that fits is sent last, flagged, at the last frame time', async () => {
    const out = await runCapturePlan(plan, async (shot) =>
      bytes(shot.kind === 'frame' ? 1000 : 150_000),
    );
    expect(out).toHaveLength(13);
    expect(out.at(-1)).toMatchObject({ t_ms: plan[11]!.t_ms, landing_crop: true });
    expect(evidenceOf(out).frames.at(-1)!.landing_crop).toBe(true);
  });

  it('a frame that never fits is dropped (11 still go); a frame that throws fails the capture', async () => {
    const out = await runCapturePlan(plan, async (shot, i) =>
      shot.kind === 'frame' && i === 3 ? null : bytes(1000),
    );
    expect(out.filter((f) => !f.landing_crop)).toHaveLength(11);
    expect(out.map((f) => f.t_ms)).not.toContain(plan[3]!.t_ms);
    expect(evidenceOf(out).frames).toHaveLength(12);
    await expect(
      runCapturePlan(plan, async (_shot, i) => {
        if (i === 0) throw new Error('no thumbnail');
        return bytes(1000);
      }),
    ).rejects.toThrow('no thumbnail');
  });
});
