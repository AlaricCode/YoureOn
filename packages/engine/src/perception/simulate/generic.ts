/**
 * Fallback mock scene for programs that match none of the worked-example
 * templates: every non-region entity stands still at its calibration bbox (or
 * a deterministic layout). The evaluation is whatever this static scene
 * yields; scenario effects that do not depend on the scene (motion,
 * cross_fail, oversize, no_identity's low id_conf) still apply.
 */
import { POSE_STANDING, TAIL_FRAMES } from '../../constants.js';
import type { Calibration, MockScenario, Program } from '../../types.js';
import { limitFrames } from '../program-info.js';
import { entityBox, SceneBuilder } from './scene.js';

export function buildGenericScene(p: Program, c: Calibration | null, scenario: MockScenario): SceneBuilder {
  const n = p.kind === 'rules' ? limitFrames(p) + TAIL_FRAMES : 0;
  const scene = new SceneBuilder(p, n);
  const idConf = scenario === 'no_identity' ? 35 : 90;
  for (const e of p.entities) {
    if (e.kind === 'region') continue;
    const person = e.kind === 'person' || e.kind === 'person_any';
    scene.hold(e.name, 0, n, entityBox(p, c, e.name), { conf: 90, id_conf: idConf, pose: person ? POSE_STANDING : 0 });
  }
  return scene;
}
