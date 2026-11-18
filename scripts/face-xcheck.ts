// The TS half of the face preprocessing cross-check (usage and results: scripts/face-xcheck.py):
// runs apps/mobile/src/face/pipeline.ts on the cases `face-xcheck.py prep <dir>` wrote, and writes
// its tensors back to <dir> for `face-xcheck.py compare`.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  alignTransform,
  ARCFACE_TEMPLATE,
  similarityTransform,
  warpToInput,
  type RawImage,
} from '../apps/mobile/src/face/pipeline';

const dir = process.argv[2]!;
const cases = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));

// Synthetic: same integer formula as ref.py synth().
const { width: w, height: h, landmarks } = cases.synthetic;
const data = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++)
    data.set(
      [(x * 3 + y) % 256, (x + y * 2) % 256, (Math.floor(x / 2) + Math.floor(y / 3)) % 256, 255],
      (y * w + x) * 4,
    );
const src = (landmarks as number[][]).map(([x, y]) => ({ x: x!, y: y! }));
const M = similarityTransform(src, ARCFACE_TEMPLATE);
const t = warpToInput({ data, width: w, height: h, format: 'RGBA' }, M);
const samples: Record<string, number[]> = {};
for (const [u, v] of cases.synthetic.samples as [number, number, number[]][]) {
  const i = (v * 112 + u) * 3;
  samples[`${u},${v}`] = [t[i]!, t[i + 1]!, t[i + 2]!];
}

// Astronaut: eyes only, through alignTransform (the embedder's path).
const a = cases.astronaut;
const img: RawImage = {
  data: new Uint8Array(readFileSync(join(dir, 'astronaut.rgba'))),
  width: a.width,
  height: a.height,
  format: 'RGBA',
};
const [e0, e1] = a.eyes as [number[], number[]];
const { m, method } = alignTransform({
  bounds: { x: a.face[0], y: a.face[1], width: a.face[2], height: a.face[3] },
  landmarks: { LEFT_EYE: { x: e1[0]!, y: e1[1]! }, RIGHT_EYE: { x: e0[0]!, y: e0[1]! } },
});
const tensor = warpToInput(img, m);
writeFileSync(join(dir, 'ts_astronaut.f32'), Buffer.from(tensor.buffer));
writeFileSync(
  join(dir, 'ts_out.json'),
  JSON.stringify({
    synthetic_M: [
      [M[0], M[1], M[2]],
      [M[3], M[4], M[5]],
    ],
    synthetic_samples: samples,
    astronaut_method: method,
  }),
);
console.log('ts side done', method);
