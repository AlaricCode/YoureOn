import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkModelTensors,
  copyEmbeddingOutput,
  FACE_INPUT_BYTES,
  FACE_INPUT_FLOATS,
  FACE_MODEL,
  l2NormalizeInPlace,
} from '../model';

const modelPath = fileURLToPath(
  new URL(`../../../assets/models/${FACE_MODEL.fileName}`, import.meta.url),
);
const noticePath = fileURLToPath(
  new URL('../../../assets/models/NOTICE-w600k_mbf.txt', import.meta.url),
);

// The .tflite is not committed (non-commercial weights; rebuild with scripts/face-model.sh).
// Without it this check is skipped, unless REQUIRE_FACE_MODEL=1 makes a missing file a failure.
const haveModel = existsSync(modelPath) || process.env.REQUIRE_FACE_MODEL === '1';

describe('face model (TASKS D0-M2, made by scripts/face-model.sh)', () => {
  it.skipIf(!haveModel)('is a TFLite flatbuffer and matches the pinned sha256 and size', () => {
    expect(existsSync(modelPath)).toBe(true);
    const bytes = readFileSync(modelPath);
    expect(bytes.length).toBe(FACE_MODEL.sizeBytes);
    // FlatBuffer file identifier at bytes 4..8.
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('TFL3');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FACE_MODEL.sha256);
    // The known-good conversion hash prefix (TASKS D0-M2).
    expect(FACE_MODEL.sha256.startsWith('ca17b05a')).toBe(true);
  });

  it('ships with its non-commercial licence note carrying the same hash', () => {
    const notice = readFileSync(noticePath, 'utf8');
    expect(notice).toContain(FACE_MODEL.sha256);
    expect(notice).toMatch(/NON-COMMERCIAL RESEARCH/);
  });

  it('pins the hash in the generator script too', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../../../../../scripts/face-model.sh', import.meta.url)),
      'utf8',
    );
    expect(script).toContain(FACE_MODEL.sha256);
    expect(script).toContain('onnx2tf==$ONNX2TF_VERSION');
    expect(script).toMatch(/ONNX2TF_VERSION="2\.6\.9"/);
    expect(script).toMatch(/ -b 1 /);
  });
});

describe('model facts', () => {
  it('matches API-CONTRACT accepted_models', () => {
    expect(FACE_MODEL).toMatchObject({ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 });
    expect(FACE_INPUT_FLOATS).toBe(112 * 112 * 3);
    expect(FACE_INPUT_BYTES).toBe(150_528);
  });
});

describe('checkModelTensors', () => {
  const good = {
    inputs: [{ name: 'input.1', dataType: 'float32', shape: [1, 112, 112, 3] }],
    outputs: [{ name: '516', dataType: 'float32', shape: [1, 512] }],
  };

  it('accepts the converted model (tensors as LiteRT reports them)', () => {
    expect(checkModelTensors(good.inputs, good.outputs)).toEqual([]);
  });

  it('rejects the fp16 file, an NCHW input and a wrong output', () => {
    expect(
      checkModelTensors(
        [{ name: 'x', dataType: 'float16', shape: [1, 3, 112, 112] }],
        [{ name: 'y', dataType: 'float16', shape: [1, 128] }],
      ),
    ).toEqual([
      'input dataType float16, not float32',
      'input shape [1,3,112,112], not [1,112,112,3]',
      'output dataType float16, not float32',
      'output shape [1,128], not [1,512]',
    ]);
  });

  it('rejects a model with the wrong number of tensors', () => {
    expect(checkModelTensors([], [...good.outputs, ...good.outputs])).toEqual([
      'expected 1 input tensor, got 0',
      'expected 1 output tensor, got 2',
    ]);
  });
});

describe('copyEmbeddingOutput', () => {
  it('copies so a reused native buffer cannot change the result', () => {
    const native = new Float32Array(512).fill(0.5);
    const copy = copyEmbeddingOutput(native.buffer);
    native.fill(9);
    expect(copy[0]).toBe(0.5);
    expect(copy.length).toBe(512);
  });

  it('rejects the wrong size and non-finite values', () => {
    expect(() => copyEmbeddingOutput(new Float32Array(128).buffer)).toThrow(/128 values/);
    const bad = new Float32Array(512);
    bad[7] = Number.NaN;
    expect(() => copyEmbeddingOutput(bad.buffer)).toThrow(/value 7/);
  });
});

describe('l2NormalizeInPlace', () => {
  it('normalises to unit length and returns the old norm', () => {
    const v = new Float32Array([3, 4]);
    expect(l2NormalizeInPlace(v)).toBe(5);
    expect(Array.from(v)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
  });

  it('throws on a zero vector', () => {
    expect(() => l2NormalizeInPlace(new Float32Array(4))).toThrow(/zero vector/);
  });
});
