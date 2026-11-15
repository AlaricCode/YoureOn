/**
 * Mock scene for the holds/intact template (§15.2 cup tower survives the fan):
 * the object stands for the whole session; failure variants collapse it
 * (height below INTACT_PCT of ref_h) or occlude it.
 */
import { TAIL_FRAMES } from '../../constants.js';
import type { Calibration, MockScenario, Program } from '../../types.js';
import { limitFrames } from '../program-info.js';
import { Prng } from './prng.js';
import { entityBox, SceneBuilder } from './scene.js';
import type { HoldsTemplate } from './templates.js';

const OCCLUDE_FRAMES = 15;

export function buildHoldsScene(
  t: HoldsTemplate,
  p: Program,
  c: Calibration | null,
  scenario: MockScenario,
  prng: Prng,
): SceneBuilder {
  const n = limitFrames(p) + TAIL_FRAMES;
  const scene = new SceneBuilder(p, n);
  const box = entityBox(p, c, t.object);
  // Every other non-region entity stands still where calibration put it.
  for (const e of p.entities) {
    if (e.kind === 'region' || e.name === t.object) continue;
    scene.hold(e.name, 0, n, entityBox(p, c, e.name), { conf: 88, id_conf: 90 });
  }
  scene.hold(t.object, 0, n, box, { conf: 90 });

  // Failure frame inside [1, D): somewhere in the middle, seed-dependent.
  const D = Math.min(t.frames, n);
  const fail = Math.max(1, Math.min(D - 1, Math.floor((D * 6) / 10) + prng.int(-3, 3)));
  const h = box.y1 - box.y0;
  const collapsed = { ...box, y0: box.y1 - Math.floor(h / 2) };
  switch (scenario) {
    case 'fail':
      scene.hold(t.object, fail, n, collapsed, { conf: 90 });
      break;
    case 'low_conf':
      // Collapse seen with low (but present) confidence at the decisive frame ⇒ CONF.
      scene.hold(t.object, fail, n, collapsed, { conf: 40 });
      break;
    case 'occlusion':
      // Someone walks in front of the tower: absent at the first failing frame ⇒ OCCLUSION.
      for (let f = fail; f < Math.min(n, fail + OCCLUDE_FRAMES); f++) scene.clear(t.object, f);
      break;
    default:
      break;
  }
  return scene;
}
