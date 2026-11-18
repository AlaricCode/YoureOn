// The native half of the face embedder (src/enroll/embedder.ts `EmbedderNatives`). App code only:
// it pulls in react-native-nitro-image, the ML Kit face detector and react-native-fast-tflite.
// Everything it does is plumbing; the math is in ./pipeline.ts and is tested in Node.
//
// Orientation (why the upright copy): the ML Kit wrapper hands a UIImage to ML Kit without its
// EXIF orientation and reports coordinates in the raw buffer, and nitro-image's crop() also
// works on the raw buffer, while resize() redraws the image upright. So the photo is resized
// first (orientation applied, long side <= 1280), saved, and both the detector and the pixel
// read use that one upright image. PENDING-PHONE: confirm on a device that a portrait photo
// from the back and the front camera both come out upright (the embedder throws
// FaceOrientationError if the detector and the pixels disagree on the frame size).
import { File } from 'expo-file-system';
import { loadImage, type Image } from 'react-native-nitro-image';
import {
  createImageFaceDetector,
  type Face,
  type ImageFaceDetector,
} from 'react-native-vision-camera-face-detector';

import {
  createDeviceEmbedder,
  type EmbedderNatives,
  type FaceEmbedder,
  type UprightStill,
} from '../enroll/embedder';
import type { DetectedFace } from '../enroll/flow';
import { loadFaceModel, warmUpFaceModel } from './loadModel';
import { copyEmbeddingOutput, FACE_INPUT_FLOATS } from './model';
import { uprightSize, type Landmarks, type PixelFormat } from './pipeline';

const toFileUrl = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);
const toPath = (url: string) => decodeURI(url.replace(/^file:\/\//, ''));

const LANDMARKS = ['LEFT_EYE', 'RIGHT_EYE', 'NOSE_BASE', 'MOUTH_LEFT', 'MOUTH_RIGHT'] as const;

/** A plain-object copy of a detector face (the HybridFace reads lazily from native). */
export function toDetectedFace(f: Face): DetectedFace {
  const lm = f.landmarks;
  let landmarks: Landmarks | undefined;
  if (lm) {
    const out: Record<string, { x: number; y: number }> = {};
    for (const k of LANDMARKS) {
      const p = lm[k];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[k] = { x: p.x, y: p.y };
    }
    landmarks = out;
  }
  return {
    yawAngle: f.yawAngle,
    pitchAngle: f.pitchAngle,
    bounds: { x: f.bounds.x, y: f.bounds.y, width: f.bounds.width, height: f.bounds.height },
    frameWidth: f.frameWidth,
    frameHeight: f.frameHeight,
    landmarks,
  };
}

let detector: ImageFaceDetector | null = null;
function getDetector(): ImageFaceDetector {
  detector ??= createImageFaceDetector({
    performanceMode: 'accurate',
    runLandmarks: true,
    runClassifications: false,
    // A scan reaches ~1.4 m: faces down to 8% of the frame (ML Kit's default is 15%).
    minFaceSize: 0.08,
  });
  return detector;
}

/** ML Kit on a file:// photo as it is (the preview stand-in only needs the pose). */
export function detectFacesInPhoto(url: string): DetectedFace[] {
  return getDetector().detectFaces(url).map(toDetectedFace);
}

async function loadUpright(photoUrl: string, maxSide: number): Promise<UprightStill> {
  const src: Image = await loadImage({ filePath: toPath(photoUrl) });
  const size = uprightSize(src.width, src.height, maxSide);
  // resize() redraws through UIKit, which applies the EXIF orientation: the result is upright.
  const up = await src.resizeAsync(size.width, size.height);
  const url = toFileUrl(await up.saveToTemporaryFileAsync('jpg', 92));
  return {
    url,
    width: up.width,
    height: up.height,
    async pixels() {
      const raw = await up.toRawPixelDataAsync();
      return {
        data: new Uint8Array(raw.buffer),
        width: raw.width,
        height: raw.height,
        format: raw.pixelFormat as PixelFormat,
      };
    },
    release() {
      try {
        new File(url).delete();
      } catch {
        // best effort: the OS clears the temp directory anyway
      }
    },
  };
}

const natives: EmbedderNatives = {
  loadUpright,
  detect: (url) => getDetector().detectFaces(url).map(toDetectedFace),
  async run(input) {
    // fast-tflite 3.0.1 does not check the input size and runs stale data on a mismatch.
    if (input.length !== FACE_INPUT_FLOATS || input.byteOffset !== 0) {
      throw new Error(`face model input has ${input.length} floats, expected ${FACE_INPUT_FLOATS}`);
    }
    const { model } = await loadFaceModel();
    const outputs = await model.run([input.buffer as ArrayBuffer]);
    const first = outputs[0];
    if (!first) throw new Error('face model returned no outputs');
    return copyEmbeddingOutput(first);
  },
  async warmUp() {
    const { model } = await loadFaceModel();
    await warmUpFaceModel(model);
  },
};

let shared: FaceEmbedder | null = null;

/** The on-device embedder (one per JS runtime; the model loads on first use). */
export function getNativeEmbedder(): FaceEmbedder {
  shared ??= createDeviceEmbedder(natives);
  return shared;
}
