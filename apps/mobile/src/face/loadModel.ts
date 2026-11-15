// Native loader for the face-embedding model (FINDINGS §3.2): resolve the bundled .tflite through
// expo-asset to a file:// URL, load it with react-native-fast-tflite on the CPU delegate, and check
// its tensors. App code only (it pulls in native modules); tests use ./model.ts.
import { Asset } from 'expo-asset';
import { loadTensorflowModel, type TfliteModel } from 'react-native-fast-tflite';

import faceModelAsset from '../../assets/models/w600k_mbf_float32.tflite';
import { checkModelTensors, copyEmbeddingOutput, FACE_INPUT_FLOATS } from './model';

export interface LoadedFaceModel {
  model: TfliteModel;
  /** file:// URL the model was read from. */
  uri: string;
  loadMs: number;
}

let cached: Promise<LoadedFaceModel> | null = null;

/** Loads the model once per JS runtime. A failed load is not cached, so a retry loads again. */
export function loadFaceModel(): Promise<LoadedFaceModel> {
  if (!cached) {
    cached = doLoad().catch((e: unknown) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

async function doLoad(): Promise<LoadedFaceModel> {
  const t0 = performance.now();
  const asset = Asset.fromModule(faceModelAsset);
  await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri.startsWith('file://')) {
    // Android release builds cannot load require()d models (fast-tflite #191); iOS dev builds
    // serve assets from Metro over http. Both loaders accept file://, which is what we want here.
    throw new Error(`face model did not resolve to a file:// URL (got ${uri})`);
  }
  // [] = the default CPU delegate (FINDINGS §3.2).
  const model = await loadTensorflowModel({ url: uri }, []);
  const problems = checkModelTensors(model.inputs, model.outputs);
  if (problems.length > 0) throw new Error(`face model tensors: ${problems.join('; ')}`);
  return { model, uri, loadMs: performance.now() - t0 };
}

/**
 * Runs one inference on an all-zero input, so the first real embedding does not pay the
 * interpreter's first-run cost. Never call run() concurrently on one model (FINDINGS §7).
 */
export async function warmUpFaceModel(
  model: TfliteModel,
): Promise<{ ms: number; embedding: Float32Array }> {
  const input = new Float32Array(FACE_INPUT_FLOATS);
  const t0 = performance.now();
  const outputs = await model.run([input.buffer]);
  const first = outputs[0];
  if (!first) throw new Error('model returned no outputs');
  const embedding = copyEmbeddingOutput(first);
  return { ms: performance.now() - t0, embedding };
}
