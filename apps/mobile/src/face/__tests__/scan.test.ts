import { describe, expect, it } from 'vitest';

import { FaceMatchRequest, type FaceMatchResponse } from '@youre-on/shared/face';

import type { DetectedFace } from '../../enroll/flow';
import { checkCopy } from '../../ui/copyRule';
import {
  channelLayout,
  FACE_CROP_SCALE,
  faceCropRect,
  toModelInput,
  uprightPlan,
} from '../preprocess';
import {
  buildFaceMatchRequest,
  createFaceScanner,
  pickScanFace,
  SCAN_PROBLEM_LABEL,
} from '../scan';

const face = (x: number, y: number, w: number, frame = [3024, 4032]): DetectedFace => ({
  yawAngle: 3,
  pitchAngle: -2,
  bounds: { x, y, width: w, height: w * 1.2 },
  frameWidth: frame[0] as number,
  frameHeight: frame[1] as number,
});

describe('upright working copy', () => {
  it('scales a 12 MP portrait still to 1280 on the long side and maps detector boxes', () => {
    const p = uprightPlan({ width: 3024, height: 4032 }, face(0, 0, 10))!;
    expect([p.width, p.height]).toEqual([960, 1280]);
    expect(p.sx).toBeCloseTo(960 / 3024, 6);
    expect(p.sy).toBeCloseTo(1280 / 4032, 6);
  });
  it('never upscales', () => {
    expect(uprightPlan({ width: 600, height: 800 }, face(0, 0, 10, [600, 800]))).toMatchObject({
      width: 600,
      height: 800,
      sx: 1,
      sy: 1,
    });
  });
  it('refuses a photo whose orientation disagrees with the detector frame', () => {
    expect(uprightPlan({ width: 4032, height: 3024 }, face(0, 0, 10))).toBeNull();
  });
});

describe('face crop', () => {
  it('is a square around the box, scaled by FACE_CROP_SCALE', () => {
    const r = faceCropRect(
      { x: 400, y: 500, width: 200, height: 240 },
      { width: 960, height: 1280 },
    );
    expect(r.x1 - r.x0).toBe(r.y1 - r.y0);
    expect(r.x1 - r.x0).toBe(Math.floor(240 * FACE_CROP_SCALE));
    expect((r.x0 + r.x1) / 2).toBeCloseTo(500, 0);
    expect((r.y0 + r.y1) / 2).toBeCloseTo(620, 0);
  });
  it('stays inside the image at the edges, shrinking only if it must', () => {
    const r = faceCropRect(
      { x: -20, y: 1200, width: 200, height: 200 },
      { width: 960, height: 1280 },
    );
    expect(r.x0).toBe(0);
    expect(r.y1).toBeLessThanOrEqual(1280);
    const big = faceCropRect(
      { x: 0, y: 0, width: 2000, height: 2000 },
      { width: 960, height: 1280 },
    );
    expect(big).toEqual({ x0: 0, y0: 320, x1: 960, y1: 1280 }); // centred on the box, then kept inside
  });
});

describe('pixels to model input', () => {
  const px = (format: string) => {
    const l = channelLayout(format)!;
    const b = new Uint8Array(112 * 112 * l.stride);
    // pixel 0 = (R 255, G 127.5-ish, B 0)
    b[l.r] = 255;
    b[l.g] = 128;
    b[l.b] = 0;
    return b;
  };
  it.each(['BGRA', 'RGBA', 'ARGB', 'RGB', 'BGR'])('%s → RGB in [-1, 1], NHWC', (format) => {
    const input = toModelInput(px(format), 112, 112, format);
    expect(input).toHaveLength(112 * 112 * 3);
    expect(input[0]).toBeCloseTo(1, 6);
    expect(input[1]).toBeCloseTo(0.5 / 127.5, 6);
    expect(input[2]).toBeCloseTo(-1, 6);
    expect(input[3]).toBeCloseTo(-1, 6); // pixel 1 is black
  });
  it('handles padded rows and refuses the wrong size or format', () => {
    const row = 112 * 4 + 32;
    const b = new Uint8Array(row * 112);
    b[row * 1 + 2] = 255; // first pixel of row 1, R in BGRA
    const input = toModelInput(b, 112, 112, 'BGRA', row);
    expect(input[112 * 3]).toBeCloseTo(1, 6);
    expect(() => toModelInput(new Uint8Array(10), 112, 112, 'RGBA')).toThrow();
    expect(() => toModelInput(new Uint8Array(4 * 100 * 100), 100, 100, 'RGBA')).toThrow();
    expect(() => toModelInput(new Uint8Array(4 * 112 * 112), 112, 112, 'unknown')).toThrow();
  });
});

describe('picking the face to scan', () => {
  it('takes the biggest face', () => {
    const r = pickScanFace([face(100, 100, 300), face(1500, 900, 600), face(0, 0, 400)]);
    expect(r.ok && r.face.bounds.x).toBe(1500);
  });
  it('asks to come closer, or says no face', () => {
    expect(pickScanFace([face(100, 100, 120)])).toEqual({ ok: false, problem: 'too_far' });
    expect(pickScanFace([])).toEqual({ ok: false, problem: 'no_face' });
  });
});

describe('face scanner', () => {
  const unit = new Float32Array(512).fill(1 / Math.sqrt(512));
  const matched: FaceMatchResponse = {
    match: {
      user: {
        user_id: '9b2f1c3e-1d2a-4b5c-8d9e-0f1a2b3c4d5e',
        pubkey: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr' as never,
        display_name: 'Jake',
        avatar_url: null,
      },
      match_ticket: 'mt1.x.y',
      ticket_expires_at: '2026-11-18T12:00:00.000Z',
      head_to_head: {
        wins: 4,
        losses: 7,
        pushes: 0,
        net: '-7000000',
        net_display: '−$7.00',
        last_settled_at: null,
        includes_seed: false,
      },
    },
  };
  const sent: FaceMatchRequest[] = [];
  const scanner = (res: FaceMatchResponse | Error, faces = [face(1000, 1200, 800)]) =>
    createFaceScanner({
      detect: () => faces,
      embed: async () => Float32Array.from(unit, (x) => x * 3),
      match: async (req) => {
        sent.push(req);
        if (res instanceof Error) throw res;
        return res;
      },
      now: () => new Date('2026-11-18T11:59:00.000Z'),
    });

  it('sends a valid, normalised plain-v0 probe and returns the match with its ticket', async () => {
    const out = await scanner(matched)('file:///tmp/x.jpg');
    expect(out).toEqual({
      kind: 'match',
      user: { user_id: matched.match!.user.user_id, display_name: 'Jake' },
      matchTicket: 'mt1.x.y',
      headToHead: { wins: 4, losses: 7, net: '-7000000' },
    });
    const req = FaceMatchRequest.parse(sent.at(-1));
    expect(req.probe.alg).toBe('plain-v0');
    expect(req.model).toEqual({ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 });
    const bytes = Uint8Array.from(atob(req.probe.ct_b64), (c) => c.charCodeAt(0));
    const v = new Float32Array(bytes.buffer);
    expect(Math.hypot(...v)).toBeCloseTo(1, 4);
  });

  it('turns every other ending into a fix-it line', async () => {
    expect(await scanner({ match: null })('u')).toMatchObject({
      kind: 'problem',
      label: 'No match',
    });
    expect(await scanner(new Error('offline'))('u')).toMatchObject({
      kind: 'problem',
      label: 'Try again',
    });
    expect(await scanner(matched, [])('u')).toMatchObject({
      kind: 'problem',
      label: 'No face found',
    });
  });

  it('builds the capture block without any image data', () => {
    const r = buildFaceMatchRequest(unit, face(0, 0, 500), new Date('2026-11-18T00:00:00.000Z'));
    expect(r.capture).toEqual({
      captured_at: '2026-11-18T00:00:00.000Z',
      eye_distance_px: null,
      yaw_deg: 3,
    });
  });

  it.each(Object.values(SCAN_PROBLEM_LABEL))('"%s" follows the copy rule', (label) => {
    expect(checkCopy(label, 'error')).toEqual([]);
  });
});
