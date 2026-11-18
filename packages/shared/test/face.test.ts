// Face addressing contract (src/face.ts): the top-2 match rule, the float32-LE embedding bytes,
// embedding validation and the wire schemas.
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_FACE_MODELS,
  bytesToEmbedding,
  cosineSimilarity,
  decideMatch,
  embeddingProblem,
  embeddingToBytes,
  FACE_CONSENT_V1_SHA256,
  FACE_CONSENT_V1_TEXT,
  FACE_MATCH_MIN_COSINE,
  FACE_MATCH_MIN_MARGIN,
  FACE_MODEL_W600K,
  FaceEnrollmentRequest,
  FaceMatchRequest,
  FaceMatchResponse,
  faceMatchPath,
  isAcceptedFaceModel,
  sha256HexOfText,
} from '../src/face';

const unit = (dim: number, i = 0) => {
  const v = new Float32Array(dim);
  v[i] = 1;
  return v;
};

describe('decideMatch (API-CONTRACT §2.4: top1 >= 0.30 and top1 - top2 >= 0.05)', () => {
  it('uses the documented thresholds', () => {
    expect(FACE_MATCH_MIN_COSINE).toBe(0.3);
    expect(FACE_MATCH_MIN_MARGIN).toBe(0.05);
  });

  it('abstains with no candidates', () => {
    expect(decideMatch([])).toEqual({ kind: 'abstain', reason: 'no_candidates' });
  });

  it('matches a single candidate at or above the threshold', () => {
    expect(decideMatch([{ id: 'b', score: 0.3 }])).toEqual({ kind: 'match', id: 'b' });
    expect(decideMatch([{ id: 'b', score: 0.2999 }])).toEqual({
      kind: 'abstain',
      reason: 'below_threshold',
    });
  });

  it('needs the margin over the runner-up, whatever the input order', () => {
    expect(
      decideMatch([
        { id: 'c', score: 0.36 },
        { id: 'b', score: 0.42 },
      ]),
    ).toEqual({ kind: 'match', id: 'b' });
    expect(
      decideMatch([
        { id: 'b', score: 0.42 },
        { id: 'c', score: 0.38 },
      ]),
    ).toEqual({ kind: 'abstain', reason: 'ambiguous' });
    // The margin counts against the second best, not the last one.
    expect(
      decideMatch([
        { id: 'x', score: 0.1 },
        { id: 'b', score: 0.6 },
        { id: 'c', score: 0.58 },
      ]),
    ).toEqual({ kind: 'abstain', reason: 'ambiguous' });
  });

  it('ignores non-finite scores', () => {
    expect(decideMatch([{ id: 'b', score: Number.NaN }])).toEqual({
      kind: 'abstain',
      reason: 'no_candidates',
    });
    expect(
      decideMatch([
        { id: 'b', score: 0.5 },
        { id: 'c', score: Number.POSITIVE_INFINITY },
      ]),
    ).toEqual({ kind: 'match', id: 'b' });
  });

  it('accepts a custom rule', () => {
    expect(decideMatch([{ id: 'b', score: 0.5 }], { minCosine: 0.6, minMargin: 0 })).toEqual({
      kind: 'abstain',
      reason: 'below_threshold',
    });
  });
});

describe('embedding bytes and validation', () => {
  it('round-trips float32 little-endian', () => {
    const v = Float32Array.from([1, -0.5, 0.25, 3.5e-8]);
    const b = embeddingToBytes(v);
    expect(b.length).toBe(16);
    expect(Array.from(b.slice(0, 4))).toEqual([0x00, 0x00, 0x80, 0x3f]); // 1.0f LE
    expect(Array.from(bytesToEmbedding(b))).toEqual(Array.from(v));
    // A view into a larger buffer at an offset decodes too.
    const big = new Uint8Array(20);
    big.set(b, 4);
    expect(Array.from(bytesToEmbedding(big.subarray(4)))).toEqual(Array.from(v));
  });

  it('rejects a byte length that is not a multiple of 4', () => {
    expect(() => bytesToEmbedding(new Uint8Array(7))).toThrow(/not 4k/);
  });

  it('checks dimension, finiteness and the L2 norm', () => {
    expect(embeddingProblem(unit(512), 512)).toBeNull();
    expect(embeddingProblem(unit(128), 512)).toMatch(/expected 512/);
    const nan = unit(512);
    nan[3] = Number.NaN;
    expect(embeddingProblem(nan, 512)).toMatch(/not finite/);
    const long = unit(512);
    long[0] = 1.01;
    expect(embeddingProblem(long, 512)).toMatch(/not L2-normalized/);
    const near = unit(512);
    near[0] = 1.0005;
    expect(embeddingProblem(near, 512)).toBeNull();
  });

  it('cosine similarity', () => {
    expect(cosineSimilarity(unit(4, 0), unit(4, 0))).toBe(1);
    expect(cosineSimilarity(unit(4, 0), unit(4, 1))).toBe(0);
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 12);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow();
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow(/zero/);
  });
});

describe('consent and models', () => {
  it('the consent hash is the sha256 of the exact text', () => {
    expect(FACE_CONSENT_V1_SHA256).toBe(sha256HexOfText(FACE_CONSENT_V1_TEXT));
    expect(FACE_CONSENT_V1_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256HexOfText(`${FACE_CONSENT_V1_TEXT} `)).not.toBe(FACE_CONSENT_V1_SHA256);
  });

  it('accepts the bundled model and the documented fallback only', () => {
    expect(ACCEPTED_FACE_MODELS).toContainEqual(FACE_MODEL_W600K);
    expect(isAcceptedFaceModel({ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 })).toBe(
      true,
    );
    expect(isAcceptedFaceModel({ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 128 })).toBe(
      false,
    );
    expect(isAcceptedFaceModel({ name: 'w600k_mbf', version: 'fp16', dim: 512 })).toBe(false);
    expect(isAcceptedFaceModel({ name: 'sface', version: '2021dec', dim: 128 })).toBe(true);
  });
});

describe('wire schemas', () => {
  const embedding = { alg: 'plain-v0', epk_b64: null, nonce_b64: null, ct_b64: 'AAAA' } as const;

  it('FaceEnrollmentRequest', () => {
    const ok = FaceEnrollmentRequest.safeParse({
      consent: {
        consent_version: 'face-consent-v1',
        consent_text_sha256: FACE_CONSENT_V1_SHA256,
        consent_at: '2026-11-18T10:00:00.000Z',
      },
      liveness: { method: 'head_turn', passed_at: '2026-11-18T10:00:05.000Z' },
      model: FACE_MODEL_W600K,
      embedding,
      shots: 3,
      extra: 'stripped',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && 'extra' in ok.data).toBe(false);
    expect(
      FaceEnrollmentRequest.safeParse({
        consent: { consent_version: 'v1', consent_text_sha256: 'nope', consent_at: 'x' },
      }).success,
    ).toBe(false);
  });

  it('FaceMatchRequest: capture is optional', () => {
    expect(FaceMatchRequest.safeParse({ probe: embedding, model: FACE_MODEL_W600K }).success).toBe(
      true,
    );
    expect(
      FaceMatchRequest.safeParse({
        probe: embedding,
        model: FACE_MODEL_W600K,
        capture: { captured_at: '2026-11-18T10:00:00.000Z', eye_distance_px: 80, yaw_deg: -4 },
      }).success,
    ).toBe(true);
  });

  it('FaceMatchResponse: a null match carries nothing', () => {
    expect(FaceMatchResponse.parse({ match: null })).toEqual({ match: null });
    expect(FaceMatchResponse.safeParse({ match: { score: 0.9 } }).success).toBe(false);
  });

  it('faceMatchPath encodes the room id', () => {
    expect(faceMatchPath('abc')).toBe('/v1/rooms/abc/face-match');
    expect(faceMatchPath('a/b')).toBe('/v1/rooms/a%2Fb/face-match');
  });
});
