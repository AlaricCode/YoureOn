/**
 * Mock scene for the rep_count template (§15.3 push-ups): the person
 * alternates rep_low / rep_high pose phases; a rep is counted on each
 * low → high transition (§3.4).
 */
import { POSE_REP_HIGH, POSE_REP_LOW, POSE_STANDING, TAIL_FRAMES } from '../../constants.js';
import type { Calibration, MockScenario, Program } from '../../types.js';
import { limitFrames } from '../program-info.js';
import { Prng } from './prng.js';
import { entityBox, SceneBuilder } from './scene.js';
import type { RepsTemplate } from './templates.js';

const OVERSIZE_BLINK_EVERY = 15;

export function buildRepsScene(
  t: RepsTemplate,
  p: Program,
  c: Calibration | null,
  scenario: MockScenario,
  prng: Prng,
): SceneBuilder {
  const LIMIT = limitFrames(p);
  const n = LIMIT + TAIL_FRAMES;
  const scene = new SceneBuilder(p, n);
  for (const e of p.entities) {
    if (e.kind === 'region' || e.name === t.person) continue;
    scene.hold(e.name, 0, n, entityBox(p, c, e.name), { conf: 88, id_conf: 90 });
  }
  const box = entityBox(p, c, t.person);
  const idConf = scenario === 'no_identity' ? 35 : 92;
  const start = 5 + prng.int(0, 9);
  const deadline = Math.min(t.deadline ?? LIMIT, LIMIT);
  const reps = scenario === 'fail' ? t.target - 1 : t.target;
  // Phase length: up to 5 frames, compressed so that the target is reached
  // comfortably before the deadline (80% of it).
  const phase = Math.min(5, Math.floor((Math.floor((deadline * 8) / 10) - start) / (2 * t.target + 1)));
  if (phase < 1) throw new Error(`simulate: ${t.target} reps cannot fit before frame ${deadline}`);

  const opts = (pose: number) => ({ conf: 90, id_conf: idConf, pose });
  scene.hold(t.person, 0, start, box, opts(POSE_STANDING));
  let f = start;
  scene.hold(t.person, f, f + phase, box, opts(POSE_REP_HIGH));
  f += phase;
  let reach: number | null = null;
  for (let i = 1; i <= reps; i++) {
    scene.hold(t.person, f, f + phase, box, opts(POSE_REP_LOW));
    f += phase;
    if (i === t.target) reach = f; // first high frame after the target-th low phase
    scene.hold(t.person, f, f + phase, box, opts(POSE_REP_HIGH));
    f += phase;
  }
  scene.hold(t.person, f, n, box, opts(POSE_STANDING));

  if (scenario === 'low_conf' && reach !== null) {
    scene.patch(t.person, reach, reach + 1, (r) => ({ ...r, conf: 40 }));
  }
  if (scenario === 'occlusion') {
    // Absent frames inside the second low phase: the count is unaffected
    // because only present frames update the rep phase.
    const g = start + 3 * phase + 1;
    if (reach === null || g + 1 < reach) {
      scene.clear(t.person, g);
      if (phase > 2) scene.clear(t.person, g + 1);
    }
  }
  if (scenario === 'oversize' && reach !== null) {
    // After success, the person keeps stepping out of frame: every return is
    // a rising edge of `success` (a key frame) up to the limit, and rep_count
    // needs coverage from frame 0 to each key frame.
    for (let g = reach + OVERSIZE_BLINK_EVERY; g < LIMIT; g += OVERSIZE_BLINK_EVERY) scene.clear(t.person, g);
  }
  return scene;
}
