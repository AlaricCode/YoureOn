import { describe, expect, it } from 'vitest';

import { FACE_INPUT_FLOATS } from '../../face/model';
import {
  ARCFACE_TEMPLATE,
  combineEmbeddings,
  flipInput,
  INPUT_SIZE,
  normalizePixel,
  type RawImage,
} from '../../face/pipeline';
import {
  createDeviceEmbedder,
  createLazyEmbedder,
  createPreviewEmbedder,
  FaceOrientationError,
  PREVIEW_FACE,
  type EmbedderNatives,
} from '../embedder';
import type { DetectedFace } from '../flow';
import type { FaceEmbedder, FaceStill } from '../embedder';

const W = 960;
const H = 1280;

/** BGRA still whose red channel is x / 4 and green y / 5 (so a sample says where it came from). */
function still(): RawImage {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 7; // B
      data[i + 1] = Math.floor(y / 5); // G
      data[i + 2] = Math.floor(x / 4); // R
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H, format: 'BGRA' };
}

/** A face whose five landmarks are the ArcFace template scaled x3 and moved to (300, 400). */
const FACE: DetectedFace = {
  yawAngle: 2,
  pitchAngle: -1,
  bounds: { x: 300, y: 400, width: 336, height: 336 },
  frameWidth: W,
  frameHeight: H,
  landmarks: {
    LEFT_EYE: { x: 300 + 3 * ARCFACE_TEMPLATE[1].x, y: 400 + 3 * ARCFACE_TEMPLATE[1].y },
    RIGHT_EYE: { x: 300 + 3 * ARCFACE_TEMPLATE[0].x, y: 400 + 3 * ARCFACE_TEMPLATE[0].y },
    NOSE_BASE: { x: 300 + 3 * ARCFACE_TEMPLATE[2].x, y: 400 + 3 * ARCFACE_TEMPLATE[2].y },
    MOUTH_LEFT: { x: 300 + 3 * ARCFACE_TEMPLATE[4].x, y: 400 + 3 * ARCFACE_TEMPLATE[4].y },
    MOUTH_RIGHT: { x: 300 + 3 * ARCFACE_TEMPLATE[3].x, y: 400 + 3 * ARCFACE_TEMPLATE[3].y },
  },
};

function fakeNatives(over: Partial<EmbedderNatives> & { faces?: DetectedFace[] } = {}) {
  const log: string[] = [];
  const inputs: Float32Array[] = [];
  let active = 0;
  let maxActive = 0;
  const raw = still();
  const natives: EmbedderNatives = {
    async loadUpright(url, maxSide) {
      log.push(`load ${url} ${maxSide}`);
      return {
        url: 'file:///tmp/upright.jpg',
        width: W,
        height: H,
        async pixels() {
          log.push('pixels');
          return raw;
        },
        release() {
          log.push('release');
        },
      };
    },
    detect(url) {
      log.push(`detect ${url}`);
      return over.faces ?? [FACE];
    },
    async run(input) {
      active++;
      maxActive = Math.max(maxActive, active);
      inputs.push(input);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      // A stand-in "model": the first 512 values of the tensor, shifted so none is zero.
      return Float32Array.from(input.subarray(0, 512), (x, i) => x + 2 + i / 1000);
    },
    ...over,
  };
  return { natives, log, inputs, maxActive: () => maxActive };
}

describe('device embedder (fake natives)', () => {
  it('opens an upright copy, detects on it, and releases it on close', async () => {
    const f = fakeNatives();
    const e = createDeviceEmbedder(f.natives);
    expect(e.preview).toBe(false);
    const s = await e.open('file:///photo.jpg');
    expect(s.faces).toEqual([FACE]);
    expect([s.width, s.height]).toEqual([W, H]);
    s.close();
    s.close();
    expect(f.log).toEqual([
      'load file:///photo.jpg 1280',
      'detect file:///tmp/upright.jpg',
      'release',
    ]);
    await expect(s.embed(FACE)).rejects.toThrow(/closed/);
  });

  it('aligns the face onto the ArcFace template, runs the model on it and its mirror, and normalizes', async () => {
    const f = fakeNatives();
    const s = await createDeviceEmbedder(f.natives).open('file:///photo.jpg');
    const out = await s.embed(FACE);
    expect(f.inputs.length).toBe(2);
    const [a, b] = f.inputs as [Float32Array, Float32Array];
    expect(a.length).toBe(FACE_INPUT_FLOATS);
    expect(b).toEqual(flipInput(a));
    // The image-left eye (x = 300 + 3 * 38.29) lands on the template's left eye: the red channel
    // there reads (that x) / 4, the green (that y) / 5, the blue 7. NHWC, RGB order.
    const u = Math.round(ARCFACE_TEMPLATE[0].x);
    const v = Math.round(ARCFACE_TEMPLATE[0].y);
    const i = (v * INPUT_SIZE + u) * 3;
    const srcX = 300 + 3 * u;
    const srcY = 400 + 3 * v;
    expect(a[i]).toBeCloseTo(normalizePixel(Math.floor(srcX / 4)), 1);
    expect(a[i + 1]).toBeCloseTo(normalizePixel(Math.floor(srcY / 5)), 1);
    expect(a[i + 2]).toBeCloseTo(normalizePixel(7), 5);
    // The result is the normalized sum of the two runs.
    const expected = combineEmbeddings(
      Float32Array.from(a.subarray(0, 512), (x, k) => x + 2 + k / 1000),
      Float32Array.from(b.subarray(0, 512), (x, k) => x + 2 + k / 1000),
    );
    expect(out).toEqual(expected);
    expect(Math.hypot(...out)).toBeCloseTo(1, 5);
    // Pixels are read once per still, however many faces are embedded.
    await s.embed(FACE);
    expect(f.log.filter((l) => l === 'pixels').length).toBe(1);
    s.close();
  });

  it('never runs the model concurrently, even across stills', async () => {
    const f = fakeNatives();
    const e = createDeviceEmbedder(f.natives);
    const [s1, s2] = await Promise.all([e.open('file:///1.jpg'), e.open('file:///2.jpg')]);
    await Promise.all([s1.embed(FACE), s2.embed(FACE), s1.embed(FACE)]);
    expect(f.inputs.length).toBe(6);
    expect(f.maxActive()).toBe(1);
  });

  it('a failed run does not wedge the queue', async () => {
    let calls = 0;
    const f = fakeNatives({
      async run() {
        calls++;
        if (calls === 1) throw new Error('boom');
        return new Float32Array(512).fill(1);
      },
    });
    const s = await createDeviceEmbedder(f.natives).open('file:///p.jpg');
    await expect(s.embed(FACE)).rejects.toThrow('boom');
    const ok = await s.embed(FACE);
    expect(ok[0]).toBeCloseTo(1 / Math.sqrt(512), 6);
  });

  it('scales detector coordinates to the still and refuses a sideways frame', async () => {
    const half: DetectedFace = {
      ...FACE,
      bounds: { x: 150, y: 200, width: 168, height: 168 },
      frameWidth: W / 2,
      frameHeight: H / 2,
      landmarks: undefined,
    };
    const s = await createDeviceEmbedder(fakeNatives({ faces: [half] }).natives).open(
      'file:///p.jpg',
    );
    expect(s.faces[0]!.bounds).toEqual({ x: 300, y: 400, width: 336, height: 336 });
    expect(s.faces[0]!.frameWidth).toBe(W);

    const sideways: DetectedFace = { ...FACE, frameWidth: H, frameHeight: W };
    const f = fakeNatives({ faces: [sideways] });
    await expect(createDeviceEmbedder(f.natives).open('file:///p.jpg')).rejects.toBeInstanceOf(
      FaceOrientationError,
    );
    expect(f.log.at(-1)).toBe('release');
  });

  it('prewarm runs warmUp through the same queue', async () => {
    const order: string[] = [];
    const f = fakeNatives({
      async warmUp() {
        order.push('warm');
      },
    });
    const e = createDeviceEmbedder(f.natives);
    await e.prewarm!();
    expect(order).toEqual(['warm']);
    expect(createDeviceEmbedder(fakeNatives().natives).prewarm).toBeUndefined();
  });
});

describe('lazy embedder (the native half loads on first use)', () => {
  const STILL: FaceStill = {
    faces: [FACE],
    width: W,
    height: H,
    embed: async () => new Float32Array(512),
    close() {},
  };
  function inner(log: string[], withPrewarm = true): FaceEmbedder {
    return {
      preview: false,
      async open(url) {
        log.push(`open ${url}`);
        return STILL;
      },
      prewarm: withPrewarm
        ? async () => {
            log.push('prewarm');
          }
        : undefined,
    };
  }

  it('loads nothing until a photo is opened or the model is warmed up', async () => {
    const log: string[] = [];
    let loads = 0;
    const e = createLazyEmbedder(async () => {
      loads++;
      return inner(log);
    });
    // Creating it (what DemoApp does at start) must not touch the native modules.
    expect(loads).toBe(0);
    expect(e.preview).toBe(false);
    expect(typeof e.prewarm).toBe('function');

    await e.prewarm!();
    const s = await e.open('file:///a.jpg');
    expect(s.faces).toEqual([FACE]);
    await e.open('file:///b.jpg');
    expect(log).toEqual(['prewarm', 'open file:///a.jpg', 'open file:///b.jpg']);
    expect(loads).toBe(1);
  });

  it('concurrent first calls share one load', async () => {
    let loads = 0;
    let resolve!: (x: FaceEmbedder) => void;
    const log: string[] = [];
    const e = createLazyEmbedder(() => {
      loads++;
      return new Promise<FaceEmbedder>((r) => (resolve = r));
    });
    const a = e.open('file:///a.jpg');
    const w = e.prewarm!();
    const b = e.open('file:///b.jpg');
    await Promise.resolve();
    resolve(inner(log));
    await Promise.all([a, w, b]);
    expect(loads).toBe(1);
    expect(log.sort()).toEqual(['open file:///a.jpg', 'open file:///b.jpg', 'prewarm']);
  });

  it('prewarm is a no-op when the loaded embedder has none', async () => {
    const e = createLazyEmbedder(async () => inner([], false));
    await expect(e.prewarm!()).resolves.toBeUndefined();
  });

  it('a native module that fails to start rejects that call only, and the next call retries', async () => {
    const log: string[] = [];
    let attempt = 0;
    const e = createLazyEmbedder(() => {
      attempt++;
      // Metro's require throws synchronously when a module's factory throws.
      if (attempt === 1) throw new Error('NitroModules: ImageFactory is not registered');
      if (attempt === 2) return Promise.reject(new Error('still missing'));
      return Promise.resolve(inner(log));
    });
    await expect(e.open('file:///a.jpg')).rejects.toThrow(/ImageFactory/);
    await expect(e.prewarm!()).rejects.toThrow('still missing');
    await expect(e.open('file:///b.jpg')).resolves.toMatchObject({ width: W, height: H });
    expect(attempt).toBe(3);
    expect(log).toEqual(['open file:///b.jpg']);
  });
});

describe('preview embedder', () => {
  it('reports the stand-in face unless given a detector, and is tagged preview', async () => {
    const e = createPreviewEmbedder();
    expect(e.preview).toBe(true);
    const s = await e.open('file:///x.jpg');
    expect(s.faces).toEqual([PREVIEW_FACE]);
    expect((await s.embed(PREVIEW_FACE)).length).toBe(512);
    const custom = createPreviewEmbedder(1, () => []);
    expect((await custom.open('file:///x.jpg')).faces).toEqual([]);
  });

  it('takes a detector that loads lazily (the preview imports the face natives on first use)', async () => {
    const turned = { ...PREVIEW_FACE, yawAngle: 30 };
    const lazyDetect = (url: string) =>
      Promise.resolve(url.endsWith('b.jpg') ? [turned] : ([] as const));
    const e = createPreviewEmbedder(1, lazyDetect);
    expect((await e.open('file:///a.jpg')).faces).toEqual([]);
    const s = await e.open('file:///b.jpg');
    expect(s.faces).toEqual([turned]);
    expect(s.width).toBe(PREVIEW_FACE.frameWidth);
    // A detector that cannot load (no ML Kit in the simulator build) fails the capture only.
    const broken = createPreviewEmbedder(1, () => Promise.reject(new Error('no detector')));
    await expect(broken.open('file:///a.jpg')).rejects.toThrow('no detector');
  });
});
