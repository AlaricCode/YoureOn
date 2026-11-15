/**
 * Mock scene for the throw template (§15.1 paper-ball shot): an actor behind a
 * line releases an object toward a container; a success drops into the
 * container's derived opening and disappears, a miss lands on the floor short
 * of it. Every attempt uses a fresh object track (multi-ball scenes).
 */
import { HAND_EXPAND_PCT, POSE_STANDING, TAIL_FRAMES } from '../../constants.js';
import type { Calibration, MockScenario, Program } from '../../types.js';
import { center, expand, interArea, side, type Box } from '../geometry.js';
import { limitFrames } from '../program-info.js';
import { Prng } from './prng.js';
import { boxAt, entityBox, refBox, SceneBuilder } from './scene.js';
import type { ThrowTemplate } from './templates.js';

const HOLD_FRAMES = 6;
const FLIGHT_FRAMES = 8;
const MISS_REST_FRAMES = 15;
const CYCLE_GAP = 10;
const SUCCESS_GAP = 25;

interface AttemptInfo {
  start: number;
  release: number;
  end: number;
  success: boolean;
}

function openingOf(b: Box): Box {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return {
    x0: b.x0 + Math.floor(w / 10),
    y0: Math.max(0, b.y0 - Math.floor(h / 10)),
    x1: b.x1 - Math.floor(w / 10),
    y1: b.y0 + Math.floor(h / 5),
  };
}

interface LineInfo {
  a: [number, number];
  b: [number, number];
  behind: number;
}

function lineOf(c: Calibration | null, name: string | null): LineInfo | null {
  if (!name || !c) return null;
  const r = c.regions.find((x) => x.entity === name && x.shape === 'line');
  if (!r || r.shape !== 'line') return null;
  return { a: [r.points[0][0], r.points[0][1]], b: [r.points[1][0], r.points[1][1]], behind: r.behind_sign };
}

/** Place the actor so its feet anchor is behind the line and its reach clears the container. */
function placeActor(ref: Box, can: Box, line: LineInfo | null): Box {
  const ok = (b: Box): boolean => {
    if (b.x0 < 0 || b.x1 > 10000) return false;
    const anchor: [number, number] = [Math.floor((b.x0 + b.x1) / 2), b.y1];
    if (line && side(line.a, line.b, anchor) !== line.behind) return false;
    return interArea(expand(b, HAND_EXPAND_PCT + 15), can) === 0;
  };
  const shifts: number[] = [0];
  for (let d = 250; d <= 9000; d += 250) shifts.push(d, -d);
  for (const dx of shifts) {
    const b = { ...ref, x0: ref.x0 + dx, x1: ref.x1 + dx };
    if (ok(b)) return b;
  }
  return ref;
}

export function buildThrowScene(
  t: ThrowTemplate,
  p: Program,
  c: Calibration | null,
  scenario: MockScenario,
  prng: Prng,
): SceneBuilder {
  const LIMIT = limitFrames(p);
  const can = entityBox(p, c, t.container);
  const line = lineOf(c, t.line);
  const actor = placeActor(entityBox(p, c, t.actor), can, line);
  const ballRef = refBox(c, t.ball);
  const bw = Math.max(100, ballRef ? ballRef.x1 - ballRef.x0 : 300);
  const bh = Math.max(100, ballRef ? ballRef.y1 - ballRef.y0 : 500);

  const [acx] = center(actor);
  const opening = openingOf(can);
  const target = center(opening);
  const dir = target[0] >= acx ? 1 : -1;
  const aw = actor.x1 - actor.x0;
  const ah = actor.y1 - actor.y0;
  const hand: [number, number] = [acx + dir * Math.floor(aw / 4), actor.y0 + Math.floor(ah / 3)];
  const reach = expand(actor, HAND_EXPAND_PCT);
  const release: [number, number] = [dir > 0 ? reach.x1 + 150 + Math.floor(bw / 2) : reach.x0 - 150 - Math.floor(bw / 2), hand[1]];
  const floorY = Math.min(10000, Math.max(can.y1, actor.y1)) - Math.floor(bh / 2) - 1;
  const landing: [number, number] = [release[0] + Math.floor(((target[0] - release[0]) * 45) / 100), floorY];

  // Plan of attempts (true = success).
  let plan: boolean[];
  if (scenario === 'fail') plan = new Array<boolean>(t.attempts).fill(false);
  else if (t.need > t.attempts) plan = new Array<boolean>(t.attempts).fill(true);
  else plan = [...new Array<boolean>(Math.min(1, t.attempts - t.need)).fill(false), ...new Array<boolean>(t.need).fill(true)];

  const attempts: AttemptInfo[] = [];
  let cursor = 10 + prng.int(0, 9);
  const cycleLen = (ok: boolean): number =>
    HOLD_FRAMES + FLIGHT_FRAMES + 1 + (ok ? SUCCESS_GAP : MISS_REST_FRAMES + CYCLE_GAP);
  for (const ok of plan) {
    attempts.push({ start: cursor, release: cursor + HOLD_FRAMES, end: cursor + HOLD_FRAMES + FLIGHT_FRAMES, success: ok });
    cursor += cycleLen(ok);
  }
  if (scenario === 'oversize') {
    // Keep throwing (misses beyond the counted attempts) until the time limit:
    // every release is a key frame, so the windows cannot fit the buffer caps.
    while (cursor + cycleLen(false) < LIMIT - 10) {
      attempts.push({ start: cursor, release: cursor + HOLD_FRAMES, end: cursor + HOLD_FRAMES + FLIGHT_FRAMES, success: false });
      cursor += cycleLen(false);
    }
  }
  if (cursor > LIMIT) throw new Error(`simulate: time limit ${p.time_limit_s}s is too short for the throw scene`);
  const n = Math.min(cursor + TAIL_FRAMES, LIMIT + TAIL_FRAMES);
  const scene = new SceneBuilder(p, n);

  const idConf = scenario === 'no_identity' ? 35 : 90;
  scene.hold(t.actor, 0, n, actor, { conf: 92, id_conf: idConf, pose: POSE_STANDING });
  scene.hold(t.container, 0, n, can, { conf: 90 });

  const arcPoint = (from: [number, number], to: [number, number], j: number, arc: number): [number, number] => {
    const x = from[0] + Math.floor(((to[0] - from[0]) * j) / FLIGHT_FRAMES);
    const lin = from[1] + Math.floor(((to[1] - from[1]) * j) / FLIGHT_FRAMES);
    const bump = Math.floor((arc * 4 * j * (FLIGHT_FRAMES - j)) / (FLIGHT_FRAMES * FLIGHT_FRAMES));
    return [x, Math.max(Math.floor(bh / 2) + 1, lin - bump)];
  };

  for (const a of attempts) {
    for (let f = a.start; f < a.release; f++) scene.set(t.ball, f, boxAt(hand[0], hand[1], bw, bh), { conf: 85 });
    const dest = a.success ? target : landing;
    for (let j = 0; j <= FLIGHT_FRAMES; j++) {
      const [x, y] = arcPoint(release, dest, j, 2000);
      scene.set(t.ball, a.release + j, boxAt(x, y, bw, bh), { conf: 85 });
    }
    if (a.success) {
      // One frame deep inside the container, then gone (track ends).
      const [ccx, ccy] = center(can);
      scene.set(t.ball, a.end + 1, boxAt(ccx, ccy, Math.floor(bw / 2), Math.floor(bh / 2)), { conf: 60 });
    } else {
      for (let f = a.end + 1; f <= a.end + MISS_REST_FRAMES; f++) scene.set(t.ball, f, boxAt(dest[0], dest[1], bw, bh), { conf: 85 });
    }
  }

  const firstSuccess = attempts.find((a) => a.success);
  if (scenario === 'low_conf' && firstSuccess) {
    scene.patch(t.ball, firstSuccess.end - 1, firstSuccess.end + 1, (r) => ({ ...r, conf: 40 }));
  }
  if (scenario === 'occlusion' && firstSuccess) {
    // Occluded hold before release: two absent frames bridged by RELEASE_GAP.
    scene.clear(t.ball, firstSuccess.start + 2);
    scene.clear(t.ball, firstSuccess.start + 3);
  }
  return scene;
}
