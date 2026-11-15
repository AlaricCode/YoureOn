/**
 * `simulate(p, c, scenario, seed)` (§13, §14): the mock perception provider.
 * Produces host A and host B SessionTracks whose evaluation matches the
 * scenario; host B = host A with ±1 px jitter (except `cross_fail`, where host
 * B disagrees on a tracked entity).
 *
 * Scenario semantics for the worked-example templates (see the tests for the
 * exact expected results):
 * - pass / fail       : the leg is True / False (status ok).
 * - cross_fail        : the hosts disagree ⇒ cross-check fails ⇒ reason 12.
 * - motion            : flags bit0 ⇒ every leg Unknown (MOTION) ⇒ reason 10.
 * - low_conf          : a decisive frame has conf < DECISIVE_CONF_MIN ⇒ CONF ⇒ reason 10.
 * - no_identity       : id_conf < ID_CONF_MIN at checkpoints ⇒ IDENTITY ⇒ reason 10
 *                       (non-actor-bound programs have no identity: same as pass).
 * - oversize          : decisive windows cannot fit the buffer caps ⇒ extraction
 *                       returns null ⇒ flags bit3 ⇒ reason 13. Where no scene can
 *                       exceed the caps (e.g. §15.2), perception marks the
 *                       session with flags bit3 directly.
 * - occlusion         : holds legs: the object is absent at the first failing
 *                       frame ⇒ OCCLUSION ⇒ reason 10; other templates: short
 *                       occlusions that the semantics bridge (result = pass).
 */
import {
  COORD_MAX,
  TRACK_FLAG_CAMERA_MOTION,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
} from '../../constants.js';
import type { Calibration, MockScenario, Program, QFrame, SessionTracks, SimulateResult } from '../../types.js';
import { crossCheckEval } from '../crosscheck.js';
import { trackedEntityIndices } from '../program-info.js';
import { extractDecisiveWindows } from '../windows.js';
import { buildGenericScene } from './generic.js';
import { buildHoldsScene } from './holds.js';
import { Prng } from './prng.js';
import { buildRepsScene } from './reps.js';
import { clampBox, type SceneBuilder } from './scene.js';
import { buildThrowScene } from './throw.js';
import { recognize } from './templates.js';

export { Prng } from './prng.js';
export { MOCK_MODEL_HASH } from './scene.js';
export { recognize } from './templates.js';
export type { SceneTemplate } from './templates.js';

const SCENARIOS: readonly MockScenario[] = ['pass', 'fail', 'cross_fail', 'motion', 'low_conf', 'no_identity', 'oversize', 'occlusion'];

function cloneSession(s: SessionTracks, map: (r: QFrame, entityIdx: number, f: number) => QFrame): SessionTracks {
  return {
    ...s,
    tracks: s.tracks.map((t) => ({
      ...t,
      frames: t.frames.map((r, f) => (r ? map(r, t.entity_idx, f) : null)),
    })),
  };
}

/** Host B: ±1 source pixel of jitter per coordinate and frame. */
function jitter(a: SessionTracks, c: Calibration | null, prng: Prng): SessionTracks {
  const ux = Math.max(1, Math.floor(COORD_MAX / (c?.scene.camera.width_px ?? 1920)));
  const uy = Math.max(1, Math.floor(COORD_MAX / (c?.scene.camera.height_px ?? 1080)));
  return cloneSession(a, (r) => {
    const b = clampBox({
      x0: r.x0 + prng.sign3() * ux,
      y0: r.y0 + prng.sign3() * uy,
      x1: r.x1 + prng.sign3() * ux,
      y1: r.y1 + prng.sign3() * uy,
    });
    return { ...r, ...b };
  });
}

/** Host B for cross_fail: a tracked entity is consistently offset by half its width (IoU ≈ 1/3). */
function disagree(a: SessionTracks, p: Program): SessionTracks {
  const tracked = trackedEntityIndices(p);
  const objects = tracked.filter((i) => p.entities[i]?.kind === 'object');
  const victim = objects[0] ?? tracked[0];
  return cloneSession(a, (r, ei) => {
    if (ei !== victim) return { ...r };
    const w = r.x1 - r.x0;
    const dx = r.x1 + Math.floor(w / 2) <= COORD_MAX ? Math.floor(w / 2) : -Math.floor(w / 2);
    return { ...r, x0: r.x0 + dx, x1: r.x1 + dx };
  });
}

function buildScene(p: Program, c: Calibration | null, scenario: MockScenario, prng: Prng): SceneBuilder {
  const t = recognize(p);
  switch (t?.kind) {
    case 'throw':
      return buildThrowScene(t, p, c, scenario, prng);
    case 'holds':
      return buildHoldsScene(t, p, c, scenario, prng);
    case 'reps':
      return buildRepsScene(t, p, c, scenario, prng);
    default:
      return buildGenericScene(p, c, scenario);
  }
}

export function simulate(p: Program, c: Calibration | null, scenario: MockScenario, seed: number): SimulateResult {
  if (!SCENARIOS.includes(scenario)) throw new Error(`simulate: unknown scenario ${String(scenario)}`);
  const prng = new Prng(seed);
  const scene = buildScene(p, c, scenario, prng);
  if (scenario === 'motion') scene.flags |= TRACK_FLAG_CAMERA_MOTION;
  let a = scene.build();
  let b = scenario === 'cross_fail' ? disagree(a, p) : jitter(a, c, prng);

  if (scenario === 'oversize' && p.kind === 'rules') {
    const verified = crossCheckEval(p, c, a).checkpoints;
    const sealed = { ...a, flags: a.flags | TRACK_FLAG_CROSS_CHECK_OK };
    if (extractDecisiveWindows(p, c, sealed, verified) !== null) {
      a = { ...a, flags: a.flags | TRACK_FLAG_WINDOW_UNAVAILABLE };
      b = { ...b, flags: b.flags | TRACK_FLAG_WINDOW_UNAVAILABLE };
    }
  }
  return { a, b };
}
