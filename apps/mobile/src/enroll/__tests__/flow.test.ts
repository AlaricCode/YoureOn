import { describe, expect, it } from 'vitest';

import { FACE_MODEL } from '../../face/model';
import {
  averageEmbedding,
  buildEnrollmentRequest,
  checkSeries,
  checkShot,
  cosine,
  enrollErrorLabel,
  makePrompts,
  plainEmbedding,
  problemLabel,
  SHOTS,
  type DetectedFace,
  type Shot,
} from '../flow';
import { createPreviewFaceApi, FaceApiError, sha256Hex } from '../api';
import { FACE_CONSENT_V1_TEXT } from '../consentText';
import { createPreviewEmbedder } from '../embedder';

const face = (yawAngle: number, pitchAngle = 0, width = 300): DetectedFace => ({
  yawAngle,
  pitchAngle,
  bounds: { width, height: width },
  frameWidth: 1000,
});

const vec = (seed: number) => {
  const v = new Float32Array(FACE_MODEL.dim);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(i * 0.37 + seed * 0.01) + 0.5;
  return v;
};

const shot = (prompt: Shot['prompt'], yawAngle: number, seed = 1): Shot => ({
  prompt,
  yawAngle,
  embedding: vec(seed),
});

describe('prompts', () => {
  it('start ahead, then turn both ways, in either order', () => {
    expect(makePrompts(() => 0.1)).toEqual(['ahead', 'left', 'right']);
    expect(makePrompts(() => 0.9)).toEqual(['ahead', 'right', 'left']);
    expect(makePrompts()).toHaveLength(SHOTS);
  });
});

describe('checkShot', () => {
  it('accepts a centred face looking ahead', () => {
    expect(checkShot('ahead', [face(2)]).ok).toBe(true);
  });
  it('names the problem with a fix-it label', () => {
    const cases: [Parameters<typeof checkShot>, string][] = [
      [['ahead', []], 'No face found'],
      [['ahead', [face(0), face(0)]], 'One face only'],
      [['ahead', [face(0, 0, 50)]], 'Move closer'],
      [['ahead', [face(30)]], 'Look straight ahead'],
    ];
    for (const [args, label] of cases) {
      const r = checkShot(...args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(problemLabel(args[0], r.problem)).toBe(label);
    }
  });
  it('asks for a bigger turn when the head barely moved', () => {
    const r = checkShot('left', [face(4)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(problemLabel('left', r.problem)).toMatch(/further/);
    expect(checkShot('left', [face(25)]).ok).toBe(true);
    expect(checkShot('right', [face(-25)]).ok).toBe(true);
  });
});

describe('checkSeries', () => {
  it('passes opposite turns of one person', () => {
    expect(checkSeries([shot('ahead', 0), shot('left', 25), shot('right', -25)])).toBeNull();
  });
  it('rejects two turns the same way', () => {
    expect(checkSeries([shot('ahead', 0), shot('left', 25), shot('right', 20)])).toBe(
      'turns_same_way',
    );
  });
  it('rejects a different face in one photo', () => {
    const other = { ...shot('right', -25), embedding: vec(1).map((x) => -x) };
    expect(checkSeries([shot('ahead', 0), shot('left', 25), other])).toBe('not_same_person');
  });
});

describe('averageEmbedding', () => {
  it('is unit length and close to each shot', () => {
    const shots = [shot('ahead', 0, 1), shot('left', 25, 2), shot('right', -25, 3)];
    const avg = averageEmbedding(shots);
    expect(avg).toHaveLength(FACE_MODEL.dim);
    expect(cosine(avg, avg)).toBeCloseTo(1, 5);
    for (const s of shots) expect(cosine(avg, s.embedding)).toBeGreaterThan(0.9);
  });
});

describe('enrollment request', () => {
  it('matches the D3-M3 shape and the preview API accepts it', async () => {
    const api = createPreviewFaceApi();
    const consent = await api.getConsent();
    expect(consent.consent_version).toBe('face-consent-v1');
    expect(consent.text_sha256).toBe(sha256Hex(FACE_CONSENT_V1_TEXT));

    const embedding = averageEmbedding([shot('ahead', 0), shot('left', 25), shot('right', -25)]);
    const req = buildEnrollmentRequest({
      consent,
      consentAt: new Date(),
      passedAt: new Date(),
      embedding: plainEmbedding(embedding),
    });
    expect(req.liveness.method).toBe('head_turn');
    expect(req.model).toEqual({ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 });
    expect(req.shots).toBe(3);
    expect(req.embedding.alg).toBe('plain-v0');
    expect(Buffer.from(req.embedding.ct_b64, 'base64')).toHaveLength(512 * 4);

    expect(await api.getStatus()).toBe('none');
    await api.enroll(req);
    expect(await api.getStatus()).toBe('active');
    await api.setStatus('disabled');
    expect(await api.getStatus()).toBe('disabled');
    await api.remove();
    expect(await api.getStatus()).toBe('none');
    expect(api.enrolled()).toBeNull();
  });

  it('refuses consent to text other than what was shown', async () => {
    const api = createPreviewFaceApi();
    const consent = await api.getConsent();
    const req = buildEnrollmentRequest({
      consent: { ...consent, text_sha256: sha256Hex('something else') },
      consentAt: new Date(),
      passedAt: new Date(),
      embedding: plainEmbedding(vec(1)),
    });
    await expect(api.enroll(req)).rejects.toEqual(new FaceApiError('FACE_CONSENT_REQUIRED'));
    expect(enrollErrorLabel('FACE_CONSENT_REQUIRED')).toBe('Consent needed');
  });

  it('cannot toggle matching before a face is saved', async () => {
    await expect(createPreviewFaceApi().setStatus('active')).rejects.toBeInstanceOf(FaceApiError);
  });
});

describe('preview embedder', () => {
  it('passes the same-person check so the flow can be tried end to end', async () => {
    const e = createPreviewEmbedder();
    expect(e.preview).toBe(true);
    const shots: Shot[] = [];
    for (const [p, yaw] of [
      ['ahead', 0],
      ['left', 25],
      ['right', -25],
    ] as const) {
      shots.push({
        prompt: p,
        yawAngle: yaw,
        embedding: await e.embed('file:///x.jpg', face(yaw)),
      });
    }
    expect(checkSeries(shots)).toBeNull();
  });
});
