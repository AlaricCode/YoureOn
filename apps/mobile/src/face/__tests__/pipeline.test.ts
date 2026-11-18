import { describe, expect, it } from 'vitest';

import { FACE_INPUT_FLOATS } from '../model';
import {
  alignTransform,
  applyAffine,
  ARCFACE_TEMPLATE,
  bboxTransform,
  BBOX_CROP_SCALE,
  channelLayout,
  combineEmbeddings,
  eyeDistance,
  flipInput,
  INPUT_SIZE,
  invertAffine,
  landmarkPairs,
  normalizePixel,
  pickProbeFace,
  scaleFace,
  similarityTransform,
  uprightSize,
  warpToInput,
  type Affine,
  type Point,
  type RawImage,
} from '../pipeline';

const close = (a: Point, b: Point, eps = 1e-9) => {
  expect(a.x).toBeCloseTo(b.x, -Math.log10(eps));
  expect(a.y).toBeCloseTo(b.y, -Math.log10(eps));
};

/** A known similarity: scale s, rotation θ, translation (tx, ty). */
const sim = (s: number, deg: number, tx: number, ty: number): Affine => {
  const t = (deg * Math.PI) / 180;
  return [s * Math.cos(t), -s * Math.sin(t), tx, s * Math.sin(t), s * Math.cos(t), ty];
};

/** RGBA image whose pixel (x, y) is (x % 256, y % 256, (x + y) % 256, 255). */
function gradient(w: number, h: number, format: 'RGBA' | 'BGRA' = 'RGBA'): RawImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = [x % 256, y % 256, (x + y) % 256];
      if (format === 'RGBA') data.set([r, g, b, 255], i);
      else data.set([b, g, r, 255], i);
    }
  }
  return { data, width: w, height: h, format };
}

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];
/** Expected tensor values for raw channel values (normalized, rounded to float32). */
const px = (vals: number[]) => Array.from(Float32Array.from(vals.map(normalizePixel)));
const at = (t: Float32Array, u: number, v: number) => {
  const i = (v * INPUT_SIZE + u) * 3;
  return [t[i], t[i + 1], t[i + 2]];
};

describe('affine helpers', () => {
  it('invertAffine round-trips points', () => {
    const m = sim(2.5, 33, 10, -4);
    const inv = invertAffine(m);
    for (const p of ARCFACE_TEMPLATE) close(applyAffine(inv, applyAffine(m, p)), p);
    expect(() => invertAffine([0, 0, 1, 0, 0, 1])).toThrow(/not invertible/);
  });

  it('similarityTransform recovers a known similarity exactly from 5 points', () => {
    const truth = sim(0.37, -21, 140, 300);
    const inv = invertAffine(truth);
    // Image points = the template pushed back through the truth's inverse.
    const src = ARCFACE_TEMPLATE.map((p) => applyAffine(inv, p));
    const m = similarityTransform(src, ARCFACE_TEMPLATE);
    for (let i = 0; i < 6; i++) expect(m[i]).toBeCloseTo(truth[i]!, 9);
    // Template onto itself is the identity.
    const id = similarityTransform(ARCFACE_TEMPLATE, ARCFACE_TEMPLATE);
    for (let i = 0; i < 6; i++) expect(id[i]).toBeCloseTo(IDENTITY[i]!, 9);
  });

  it('is least squares: noisy points still land near the template, and 2 points suffice', () => {
    const truth = sim(0.5, 10, 20, 30);
    const inv = invertAffine(truth);
    const noisy = ARCFACE_TEMPLATE.map((p, i) => {
      const q = applyAffine(inv, p);
      return { x: q.x + (i % 2 ? 0.8 : -0.8), y: q.y + (i % 3 ? 0.5 : -0.5) };
    });
    const m = similarityTransform(noisy, ARCFACE_TEMPLATE);
    noisy.forEach((p, i) => {
      const q = applyAffine(m, p);
      expect(Math.hypot(q.x - ARCFACE_TEMPLATE[i]!.x, q.y - ARCFACE_TEMPLATE[i]!.y)).toBeLessThan(
        2,
      );
    });
    const two = similarityTransform(noisy.slice(0, 2), ARCFACE_TEMPLATE.slice(0, 2));
    close(applyAffine(two, noisy[0]!), ARCFACE_TEMPLATE[0]);
    close(applyAffine(two, noisy[1]!), ARCFACE_TEMPLATE[1]);
    expect(() => similarityTransform([{ x: 1, y: 1 }], [{ x: 2, y: 2 }])).toThrow();
    expect(() =>
      similarityTransform(
        [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
        ],
        ARCFACE_TEMPLATE.slice(0, 2),
      ),
    ).toThrow(/degenerate/);
  });
});

describe('alignment', () => {
  const lm = (pts: readonly Point[]) => ({
    LEFT_EYE: pts[0]!,
    RIGHT_EYE: pts[1]!,
    NOSE_BASE: pts[2]!,
    MOUTH_LEFT: pts[3]!,
    MOUTH_RIGHT: pts[4]!,
  });

  it('pairs eyes and mouth corners by image x, whatever the detector calls left', () => {
    const pts = ARCFACE_TEMPLATE.map((p) => ({ x: p.x * 3, y: p.y * 3 }));
    const swapped = {
      LEFT_EYE: pts[1]!,
      RIGHT_EYE: pts[0]!,
      NOSE_BASE: pts[2]!,
      MOUTH_LEFT: pts[4]!,
      MOUTH_RIGHT: pts[3]!,
    };
    expect(landmarkPairs(swapped)).toEqual(landmarkPairs(lm(pts)));
    expect(landmarkPairs(lm(pts))!.src).toEqual(pts);
    expect(landmarkPairs({ NOSE_BASE: pts[2]! })).toBeNull();
    expect(landmarkPairs(undefined)).toBeNull();
    // Eyes only: two pairs.
    expect(landmarkPairs({ LEFT_EYE: pts[0]!, RIGHT_EYE: pts[1]! })!.dst).toEqual(
      ARCFACE_TEMPLATE.slice(0, 2),
    );
  });

  it('maps a face found anywhere in the still onto the ArcFace template', () => {
    const truth = sim(0.25, 12, -60, -200); // a face ~4x template size, tilted 12 deg
    const inv = invertAffine(truth);
    const pts = ARCFACE_TEMPLATE.map((p) => applyAffine(inv, p));
    const { m, method } = alignTransform({
      bounds: { x: 0, y: 0, width: 400, height: 400 },
      landmarks: lm(pts),
    });
    expect(method).toBe('landmarks');
    pts.forEach((p, i) => close(applyAffine(m, p), ARCFACE_TEMPLATE[i]!, 1e-6));
  });

  it('falls back to the bbox crop without eyes, or with degenerate landmarks', () => {
    const bounds = { x: 100, y: 200, width: 300, height: 300 };
    expect(alignTransform({ bounds }).method).toBe('bbox');
    const same = { x: 10, y: 10 };
    expect(alignTransform({ bounds, landmarks: { LEFT_EYE: same, RIGHT_EYE: same } }).method).toBe(
      'bbox',
    );
    const m = bboxTransform(bounds);
    close(applyAffine(m, { x: 250, y: 350 }), { x: 56, y: 56 });
    // The crop is BBOX_CROP_SCALE x the box: the box spans 112 / 1.33 px.
    expect(applyAffine(m, { x: 400, y: 350 }).x - applyAffine(m, { x: 100, y: 350 }).x).toBeCloseTo(
      INPUT_SIZE / BBOX_CROP_SCALE,
      9,
    );
    expect(() => bboxTransform({ x: 0, y: 0, width: 0, height: 0 })).toThrow();
  });

  it('scaleFace scales bounds and landmarks (detector frame -> raw pixels)', () => {
    const f = {
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      landmarks: { LEFT_EYE: { x: 1, y: 2 } },
      yawAngle: 3,
    };
    expect(scaleFace(f, 1, 1)).toBe(f);
    expect(scaleFace(f, 2, 0.5)).toEqual({
      bounds: { x: 20, y: 10, width: 60, height: 20 },
      landmarks: { LEFT_EYE: { x: 2, y: 1 } },
      yawAngle: 3,
    });
    expect(eyeDistance({ LEFT_EYE: { x: 0, y: 0 }, RIGHT_EYE: { x: 3, y: 4 } })).toBe(5);
    expect(eyeDistance({ LEFT_EYE: { x: 0, y: 0 } })).toBeNull();
  });
});

describe('pixels -> model input', () => {
  it('normalizes like InsightFace ArcFace: (x - 127.5) / 127.5', () => {
    expect(normalizePixel(0)).toBe(-1);
    expect(normalizePixel(255)).toBe(1);
    expect(normalizePixel(127.5)).toBe(0);
  });

  it('knows where R, G and B sit in every layout', () => {
    expect(channelLayout('RGBA')).toEqual({ r: 0, g: 1, b: 2, bpp: 4 });
    expect(channelLayout('BGRA')).toEqual({ r: 2, g: 1, b: 0, bpp: 4 });
    expect(channelLayout('ARGB')).toEqual({ r: 1, g: 2, b: 3, bpp: 4 });
    expect(channelLayout('XBGR')).toEqual({ r: 3, g: 2, b: 1, bpp: 4 });
    expect(channelLayout('BGR')).toEqual({ r: 2, g: 1, b: 0, bpp: 3 });
    expect(() => channelLayout('unknown')).toThrow();
  });

  it('identity warp of a 112x112 image is the normalized pixels, RGB, NHWC', () => {
    const img = gradient(112, 112);
    const t = warpToInput(img, IDENTITY);
    expect(t.length).toBe(FACE_INPUT_FLOATS);
    expect(at(t, 0, 0)).toEqual([-1, -1, -1]);
    expect(at(t, 10, 20)).toEqual(px([10, 20, 30]));
    expect(at(t, 111, 111)).toEqual(px([111, 111, 222]));
  });

  it('BGRA and RGBA buffers of the same picture give the same tensor', () => {
    expect(warpToInput(gradient(112, 112, 'BGRA'), IDENTITY)).toEqual(
      warpToInput(gradient(112, 112, 'RGBA'), IDENTITY),
    );
  });

  it('samples bilinearly through the transform and reads outside the image as black', () => {
    const img = gradient(300, 300);
    // Template (u, v) <- image (2u + 7, 2v + 3).
    const m = invertAffine([2, 0, 7, 0, 2, 3]);
    const t = warpToInput(img, m);
    expect(at(t, 5, 6)).toEqual(px([17, 15, 32]));
    // Half-pixel sample: the mean of two neighbours.
    const half = warpToInput(img, invertAffine([1, 0, 10.5, 0, 1, 0]));
    expect(at(half, 0, 0)[0]).toBeCloseTo(normalizePixel(10.5), 6);
    // Far outside: -1 everywhere.
    const off = warpToInput(img, invertAffine([1, 0, 5000, 0, 1, 5000]));
    expect(Array.from(off).every((x) => x === -1)).toBe(true);
  });

  it('honours padded rows and refuses short buffers', () => {
    const w = 112;
    const h = 112;
    const stride = w * 4 + 16;
    const data = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data.set([x, y, 0, 255], y * stride + x * 4);
    const t = warpToInput({ data, width: w, height: h, format: 'RGBA' }, IDENTITY);
    expect(at(t, 50, 60)).toEqual(px([50, 60, 0]));
    expect(() =>
      warpToInput({ data: new Uint8Array(10), width: w, height: h, format: 'RGBA' }, IDENTITY),
    ).toThrow(/too short/);
  });

  it('flipInput mirrors left-right and is its own inverse', () => {
    const t = warpToInput(gradient(112, 112), IDENTITY);
    const f = flipInput(t);
    expect(at(f, 0, 9)).toEqual(at(t, 111, 9));
    expect(at(f, 40, 70)).toEqual(at(t, 71, 70));
    expect(flipInput(f)).toEqual(t);
    expect(() => flipInput(new Float32Array(3))).toThrow();
  });
});

describe('outputs -> embedding', () => {
  it('sums and L2-normalizes the original and mirrored outputs', () => {
    const a = new Float32Array(512);
    const b = new Float32Array(512);
    a[0] = 3;
    b[0] = 1;
    b[1] = 4;
    const e = combineEmbeddings(a, b);
    expect(e[0]).toBeCloseTo(4 / Math.sqrt(32), 6);
    expect(e[1]).toBeCloseTo(4 / Math.sqrt(32), 6);
    expect(Math.hypot(...e)).toBeCloseTo(1, 6);
    expect(() => combineEmbeddings(new Float32Array(10))).toThrow();
    expect(() => combineEmbeddings(new Float32Array(512))).toThrow(/zero/);
    const nan = new Float32Array(512);
    nan[4] = Number.NaN;
    expect(() => combineEmbeddings(nan)).toThrow(/finite/);
    expect(() => combineEmbeddings()).toThrow();
  });
});

describe('stills and the probe face', () => {
  it('caps the long side, never upscales', () => {
    expect(uprightSize(3024, 4032, 1280)).toEqual({ width: 960, height: 1280 });
    expect(uprightSize(4032, 3024, 1280)).toEqual({ width: 1280, height: 960 });
    expect(uprightSize(640, 480, 1280)).toEqual({ width: 640, height: 480 });
    expect(() => uprightSize(0, 10, 1280)).toThrow();
  });

  const face = (x: number, y: number, size: number) => ({
    bounds: { x, y, width: size, height: size },
  });
  const frame = { width: 960, height: 1280 };

  it('no face, or only a face too far away, is a miss', () => {
    expect(pickProbeFace([], frame)).toEqual({ ok: false, problem: 'no_face' });
    expect(pickProbeFace([face(400, 600, 60)], frame)).toEqual({ ok: false, problem: 'too_far' });
  });

  it('picks the most central of the large faces; small background faces never win', () => {
    const left = face(0, 500, 300);
    const centre = face(330, 500, 280);
    const tinyCentre = face(460, 620, 80);
    expect(pickProbeFace([left, tinyCentre, centre], frame)).toEqual({ ok: true, face: centre });
    expect(pickProbeFace([left, tinyCentre], frame)).toEqual({ ok: true, face: left });
  });
});
