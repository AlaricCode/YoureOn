"""Cross-checks the phone's face preprocessing (apps/mobile/src/face/pipeline.ts) against
InsightFace's reference (skimage SimilarityTransform + cv2.warpAffine + (x - 127.5) / 127.5, RGB:
norm_crop + ArcFaceONNX) and runs the real w600k_mbf_float32.tflite through both. Dev tool, not
CI; no network beyond the pip packages. The photo is skimage.data.astronaut() (public domain,
NASA), its eyes found by OpenCV's Haar cascades.

  D=$(mktemp -d)
  PY="uv run --python 3.12 --with numpy --with opencv-python-headless==4.10.0.84 \\
      --with scikit-image --with ai-edge-litert --with pooch python"
  $PY scripts/face-xcheck.py prep "$D"
  npx tsx scripts/face-xcheck.ts "$D"
  $PY scripts/face-xcheck.py compare "$D" apps/mobile/assets/models/w600k_mbf_float32.tflite

Result on 2026-11-18: similarity == skimage (1e-14), tensor == cv2 (max 0.005 synthetic, 0.02
photo), cosine(TS pipeline, reference) = 0.99991 through the model; same face re-aligned 0.958,
rotated photo 0.997, mirror 0.958, cat -0.017. The synthetic case is committed as
apps/mobile/src/face/__tests__/fixtures/insightface-reference.json.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter
from skimage import data
from skimage import transform as trans

ARCFACE = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float64,
)


def synth(w, h):
    y, x = np.mgrid[0:h, 0:w]
    r = (x * 3 + y) % 256
    g = (x + y * 2) % 256
    b = (x // 2 + y // 3) % 256
    return np.stack([r, g, b], -1).astype(np.uint8)


def similarity(src, dst):
    t = trans.SimilarityTransform.from_estimate(
        np.asarray(src, dtype=np.float64), np.asarray(dst, dtype=np.float64)
    )
    return t.params[0:2, :]


def ref_tensor(rgb, M):
    warped = cv2.warpAffine(rgb, M, (112, 112), borderValue=0.0)
    return (warped.astype(np.float32) - 127.5) / 127.5


def prep(HERE):
    out = {}
    # Synthetic case: five landmarks of a tilted face ~3x template size.
    s, th, tx, ty = 0.31, np.deg2rad(-14), -40.0, -95.0
    fwd = np.array([[s * np.cos(th), -s * np.sin(th), tx], [s * np.sin(th), s * np.cos(th), ty]])
    inv = cv2.invertAffineTransform(fwd)
    lmk = (inv[:, :2] @ ARCFACE.T + inv[:, 2:]).T
    img = synth(300, 400)
    M = similarity(lmk, ARCFACE)
    t = ref_tensor(img, M)
    pts = [(u, v) for u in range(0, 112, 13) for v in range(0, 112, 17)]
    out['synthetic'] = {
        'width': 300,
        'height': 400,
        'landmarks': lmk.tolist(),
        'M': M.tolist(),
        'samples': [[u, v, t[v, u].tolist()] for (u, v) in pts],
    }

    # Astronaut (public domain): eyes from OpenCV Haar cascades.
    rgb = data.astronaut()
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    faces = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml').detectMultiScale(gray, 1.1, 5)
    fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
    eyes = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml').detectMultiScale(
        gray[fy : fy + fh // 2 + fh // 6, fx : fx + fw], 1.05, 5
    )
    eyes = sorted(eyes, key=lambda e: e[2] * e[3], reverse=True)[:2]
    centers = sorted([(fx + ex + ew / 2, fy + ey + eh / 2) for (ex, ey, ew, eh) in eyes])
    h, w = rgb.shape[:2]
    rgba = np.concatenate([rgb, np.full((h, w, 1), 255, np.uint8)], -1)
    (HERE / 'astronaut.rgba').write_bytes(rgba.tobytes())
    out['astronaut'] = {
        'width': w,
        'height': h,
        'face': [int(fx), int(fy), int(fw), int(fh)],
        'eyes': centers,
    }
    (HERE / 'cases.json').write_text(json.dumps(out))
    print(json.dumps({'astronaut_face': out['astronaut']['face'], 'eyes': centers}))


def compare(HERE, model_path):
    cases = json.loads((HERE / 'cases.json').read_text())
    ts = json.loads((HERE / 'ts_out.json').read_text())
    report = {}

    syn = cases['synthetic']
    report['synthetic_M_maxdiff'] = float(np.abs(np.array(ts['synthetic_M']) - np.array(syn['M'])).max())
    diffs = [abs(a - b) for (u, v, ref) in syn['samples'] for a, b in zip(ref, ts['synthetic_samples'][f'{u},{v}'])]
    report['synthetic_tensor_maxdiff'] = max(diffs)
    report['synthetic_tensor_meandiff'] = sum(diffs) / len(diffs)

    interp = Interpreter(model_path=model_path)
    interp.allocate_tensors()
    i = interp.get_input_details()[0]
    o = interp.get_output_details()[0]
    report['model_input'] = {'shape': i['shape'].tolist(), 'dtype': str(i['dtype'])}
    report['model_output'] = {'shape': o['shape'].tolist(), 'dtype': str(o['dtype'])}

    def run(x):
        interp.set_tensor(i['index'], x[None].astype(np.float32))
        interp.invoke()
        return interp.get_tensor(o['index'])[0].astype(np.float64).copy()

    def emb(x):
        e = run(x) + run(x[:, ::-1, :].copy())
        return e / np.linalg.norm(e)

    cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    ast = cases['astronaut']
    rgb = data.astronaut()
    eyes = np.array(ast['eyes'])
    M = similarity(eyes, ARCFACE[:2])
    ref = ref_tensor(rgb, M)
    ts_t = np.frombuffer((HERE / 'ts_astronaut.f32').read_bytes(), dtype='<f4').reshape(112, 112, 3)
    report['astronaut_tensor_maxdiff'] = float(np.abs(ts_t - ref).max())
    report['astronaut_tensor_meandiff'] = float(np.abs(ts_t - ref).mean())
    e_ref = emb(ref)
    e_ts = emb(ts_t)
    report['cos(ts pipeline, insightface reference)'] = cos(e_ts, e_ref)
    # The TS embedder's combined (orig + mirror) embedding, computed by the TS code from raw outputs.
    # Robustness: eyes off by ~2 px and a 3 degree tilt (a re-capture of the same face).
    jitter = eyes + np.array([[1.5, -1.0], [-1.0, 2.0]])
    rot = cv2.getRotationMatrix2D((256, 256), 3.0, 1.0)
    rgb_rot = cv2.warpAffine(rgb, rot, (512, 512))
    eyes_rot = (rot[:, :2] @ eyes.T + rot[:, 2:]).T
    report['cos(same face, jittered eyes)'] = cos(e_ref, emb(ref_tensor(rgb, similarity(jitter, ARCFACE[:2]))))
    report['cos(same face, rotated photo)'] = cos(e_ref, emb(ref_tensor(rgb_rot, similarity(eyes_rot, ARCFACE[:2]))))
    report['cos(face, its mirror image)'] = cos(run(ref), run(ref[:, ::-1, :].copy()))
    # Contrasts: the cat, and a wrong preprocessing (BGR / [0,1]) of the same face.
    cat = data.chelsea()
    cy, cx = cat.shape[0] // 2, cat.shape[1] // 2
    Mc = np.array([[112 / 200, 0, 56 - 112 / 200 * cx], [0, 112 / 200, 56 - 112 / 200 * cy]])
    report['cos(face, cat)'] = cos(e_ref, emb(ref_tensor(cat, Mc)))
    report['cos(face, same face as BGR)'] = cos(e_ref, emb(ref[:, :, ::-1].copy()))
    report['cos(face, same face scaled [0,1])'] = cos(
        e_ref, emb(cv2.warpAffine(rgb, M, (112, 112)).astype(np.float32) / 255.0)
    )
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    if sys.argv[1] == 'prep':
        prep(Path(sys.argv[2]))
    else:
        compare(Path(sys.argv[2]), sys.argv[3])
