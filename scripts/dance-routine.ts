#!/usr/bin/env -S npx tsx
// Dance Off reference routines (docs/planning/DANCE-OFF.md §2, §8).
//
//   npx tsx scripts/dance-routine.ts synth
//       Writes the 2 bundled SYNTHETIC placeholder routines (wave-pop, bounce-back; 15 s each) to
//       packages/shared/src/dance/routines/<id>.ts, procedurally and deterministically (same bytes
//       on every run), then validates and self-scores them.
//   npx tsx scripts/dance-routine.ts import <routine.json> [--id ID] [--title T] [--song S]
//       [--bpm N] [--first-beat-ms M] [--version V] [--duration-ms D]
//       [--key-moves ms,ms,… | --every K] [--video FILE] [--audio FILE]
//       Takes the RoutineData-ish JSON the macOS tool (tools/dance-ref) writes (floats in [0, 1] or
//       already-quantized ints), keeps its duration_ms (5000..40000; --duration-ms overrides it,
//       15000 when neither is given) and the frames in [0, duration_ms], quantizes, picks key moves
//       (--key-moves, --every K beats from first_beat_ms, the JSON's key_moves, or else every K
//       beats with the smallest K that gives <= 16; 8..16 of them, kept on the beat, never snapped
//       to a frame), validates with the shared RoutineData schema and writes routines/<id>.ts.
//       The pure part is packages/shared/src/dance/routine-import.ts. A NEW id must also be
//       added to ROUTINES in packages/shared/src/dance/routine.ts (exactly 3 bundled).
//   npx tsx scripts/dance-routine.ts selftest
//       Scores each bundled routine against itself (both players) and expects 100.0.
//
// A routine file never changes once a bet is locked on it (its sha256 is in the Terms text): a new
// take of the same routine bumps `version`. Music must be royalty-free or ElevenLabs Music output.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOINT, JOINT_COUNT, KEYPOINT_LEN } from '../packages/shared/src/dance/joints';
import { quantizePerson } from '../packages/shared/src/dance/pose';
import type { RoutineData } from '../packages/shared/src/dance/routine';
import type { RoutineImportJson } from '../packages/shared/src/dance/routine-import';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTINES_DIR = join(ROOT, 'packages/shared/src/dance/routines');
const DURATION_MS = 15_000;
const SYNTH_FPS = 15;
const W = 720;
const H = 1280;
const ASPECT = W / H;

// ---- the synthetic skeleton ---------------------------------------------------------------

/** Angles in degrees. Limb direction = (sin φ, cos φ): φ = 0 points down, φ > 0 to image right. */
interface Pose {
  /** Hip-centre shift (aspect units, + = image right = the dancer's left). */
  dx: number;
  /** Hip drop (squat), aspect units. */
  drop: number;
  /** Torso lean: + tips the top toward image right. */
  lean: number;
  /** Arms, relative to the torso. l* = the dancer's LEFT arm (image right side). */
  lUA: number;
  lFA: number;
  rUA: number;
  rFA: number;
  /** Legs, absolute. */
  lTh: number;
  lSh: number;
  rTh: number;
  rSh: number;
}

const NEUTRAL: Pose = {
  dx: 0,
  drop: 0,
  lean: 0,
  lUA: 12,
  lFA: 8,
  rUA: -12,
  rFA: -8,
  lTh: 4,
  lSh: 2,
  rTh: -4,
  rSh: -2,
};

type Part = Partial<Pose>;
/** Symmetric arm poses: [upper, fore] for the left arm; the right arm mirrors. */
const sym = (ua: number, fa: number): Part => ({ lUA: ua, lFA: fa, rUA: -ua, rFA: -fa });
const ARMS: Record<string, Part> = {
  down: {},
  t: sym(90, 90),
  v: sym(145, 155),
  up: sym(172, 176),
  flex: sym(90, 172),
  low: sym(45, 40),
  hips: sym(45, -40),
  cross: { lUA: -25, lFA: -80, rUA: 25, rFA: 80 },
  leftUp: { lUA: 170, lFA: 175 },
  rightUp: { rUA: -170, rFA: -175 },
  waveA: { lUA: 100, lFA: 150 },
  waveB: { lUA: 100, lFA: 60 },
  waveC: { rUA: -100, rFA: -150 },
  waveD: { rUA: -100, rFA: -60 },
  pointL: { lUA: 135, lFA: 135, rUA: -45, rFA: 40 },
  pointR: { rUA: -135, rFA: -135, lUA: 45, lFA: -40 },
  swingL: { lUA: 70, lFA: 95, rUA: 30, rFA: 60 },
  swingR: { rUA: -70, rFA: -95, lUA: -30, lFA: -60 },
  clap: { lUA: 160, lFA: -165, rUA: -160, rFA: 165 },
  disco: { lUA: 150, lFA: 150, rUA: 30, rFA: 20 },
};
const LEGS: Record<string, Part> = {
  stand: {},
  wide: { lTh: 14, lSh: 10, rTh: -14, rSh: -10 },
  plie: { drop: 0.07, lTh: 42, lSh: -6, rTh: -42, rSh: 6 },
  bounce: { drop: 0.035, lTh: 22, lSh: -4, rTh: -22, rSh: 4 },
  kickL: { dx: -0.02, lTh: 62, lSh: 64 },
  kickR: { dx: 0.02, rTh: -62, rSh: -64 },
  kneeL: { drop: 0.02, lTh: 55, lSh: -25 },
  kneeR: { drop: 0.02, rTh: -55, rSh: 25 },
  stepL: { dx: 0.055, lTh: 16, lSh: 10, rTh: -6, rSh: -4 },
  stepR: { dx: -0.055, rTh: -16, rSh: -10, lTh: 6, lSh: 4 },
  lungeL: { dx: 0.04, drop: 0.05, lTh: 40, lSh: -8, rTh: -30, rSh: -30 },
  lungeR: { dx: -0.04, drop: 0.05, rTh: -40, rSh: 8, lTh: 30, lSh: 30 },
};
const TORSO: Record<string, Part> = {
  up: {},
  leanL: { lean: 18 },
  leanR: { lean: -18 },
  tiltL: { lean: 9 },
  tiltR: { lean: -9 },
};

const rad = (d: number) => (d * Math.PI) / 180;
const dir = (deg: number): [number, number] => [Math.sin(rad(deg)), Math.cos(rad(deg))];

/** A Pose → 19 joints, as raw floats [x, y, c] × 19 in the unmirrored image. */
function skeleton(p: Pose): number[] {
  const pts = Array.from({ length: JOINT_COUNT }, (): [number, number] => [0, 0]);
  const set = (j: number, x: number, y: number) => {
    pts[j] = [x, y];
  };
  const mx = ASPECT / 2 + p.dx;
  const my = 0.52 + p.drop;
  const up: [number, number] = [Math.sin(rad(p.lean)), -Math.cos(rad(p.lean))];
  const perp: [number, number] = [Math.cos(rad(p.lean)), Math.sin(rad(p.lean))];
  const at = (o: [number, number], v: [number, number], s: number): [number, number] => [
    o[0] + v[0] * s,
    o[1] + v[1] * s,
  ];
  const mid: [number, number] = [mx, my];
  const neck = at(mid, up, 0.26);
  set(JOINT.root, mid[0], mid[1]);
  set(JOINT.neck, neck[0], neck[1]);
  const lHip = at(mid, perp, 0.05);
  const rHip = at(mid, perp, -0.05);
  set(JOINT.leftHip, ...lHip);
  set(JOINT.rightHip, ...rHip);
  const shoulderBase = at(neck, up, -0.012);
  const lSh = at(shoulderBase, perp, 0.075);
  const rSh = at(shoulderBase, perp, -0.075);
  set(JOINT.leftShoulder, ...lSh);
  set(JOINT.rightShoulder, ...rSh);
  const nose = at(neck, up, 0.085);
  set(JOINT.nose, ...nose);
  set(JOINT.leftEye, ...at(at(nose, up, 0.012), perp, 0.018));
  set(JOINT.rightEye, ...at(at(nose, up, 0.012), perp, -0.018));
  set(JOINT.leftEar, ...at(at(nose, up, 0.004), perp, 0.036));
  set(JOINT.rightEar, ...at(at(nose, up, 0.004), perp, -0.036));
  const lEl = at(lSh, dir(p.lUA + p.lean), 0.13);
  const rEl = at(rSh, dir(p.rUA + p.lean), 0.13);
  set(JOINT.leftElbow, ...lEl);
  set(JOINT.rightElbow, ...rEl);
  set(JOINT.leftWrist, ...at(lEl, dir(p.lFA + p.lean), 0.12));
  set(JOINT.rightWrist, ...at(rEl, dir(p.rFA + p.lean), 0.12));
  const lKn = at(lHip, dir(p.lTh), 0.19);
  const rKn = at(rHip, dir(p.rTh), 0.19);
  set(JOINT.leftKnee, ...lKn);
  set(JOINT.rightKnee, ...rKn);
  set(JOINT.leftAnkle, ...at(lKn, dir(p.lSh), 0.19));
  set(JOINT.rightAnkle, ...at(rKn, dir(p.rSh), 0.19));
  const k = new Array<number>(KEYPOINT_LEN);
  for (let j = 0; j < JOINT_COUNT; j++) {
    k[j * 3] = pts[j]![0] / ASPECT;
    k[j * 3 + 1] = pts[j]![1];
    k[j * 3 + 2] = 1;
  }
  return k;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (u: number) => u * u * (3 - 2 * u);
function blend(a: Pose, b: Pose, u: number): Pose {
  const out = { ...a };
  for (const key of Object.keys(a) as (keyof Pose)[]) out[key] = lerp(a[key], b[key], u);
  return out;
}

/** One beat: arms / legs / torso pose names, and a key-move name when the beat is scored. */
type Beat = [arms: string, legs: string, torso: string, key?: string];

interface SynthSpec {
  id: string;
  title: string;
  song: string;
  bpm: number;
  first_beat_ms: number;
  beats: Beat[];
}

function poseOf(b: Beat): Pose {
  const [arms, legs, torso] = b;
  const parts = [ARMS[arms], LEGS[legs], TORSO[torso]];
  if (parts.some((x) => x === undefined)) throw new Error(`unknown pose part in ${b.join('/')}`);
  return { ...NEUTRAL, ...parts[0], ...parts[1], ...parts[2] };
}

/**
 * The pose at time t: hold the previous beat's pose for the first 35 % of the beat, then move
 * (smoothstep) to arrive exactly ON the next beat, so every key move follows motion.
 */
function poseAt(spec: SynthSpec, t: number): Pose {
  const beat = 60_000 / spec.bpm;
  const poses = spec.beats.map(poseOf);
  const beatT = (i: number) => spec.first_beat_ms + i * beat;
  if (t <= beatT(0) - beat) return NEUTRAL;
  if (t <= beatT(0)) {
    const u = (t - (beatT(0) - beat)) / beat;
    return blend(NEUTRAL, poses[0]!, smooth(Math.min(1, Math.max(0, (u - 0.35) / 0.65))));
  }
  const i = Math.floor((t - beatT(0)) / beat);
  if (i >= poses.length - 1) return poses[poses.length - 1]!;
  const u = (t - beatT(i)) / beat;
  return blend(poses[i]!, poses[i + 1]!, smooth(Math.min(1, Math.max(0, (u - 0.35) / 0.65))));
}

function synthesize(spec: SynthSpec): RoutineData {
  const frames: RoutineData['frames'] = [];
  const n = Math.round((DURATION_MS * SYNTH_FPS) / 1000);
  for (let i = 0; i <= n; i++) {
    const t = Math.round((i * 1000) / SYNTH_FPS);
    frames.push({ t, k: quantizePerson(skeleton(poseAt(spec, t))) });
  }
  const beat = 60_000 / spec.bpm;
  const key_moves: RoutineData['key_moves'] = [];
  spec.beats.forEach((b, i) => {
    if (!b[3]) return;
    const t = Math.round(spec.first_beat_ms + i * beat);
    if (t > DURATION_MS) throw new Error(`${spec.id}: key move after the end`);
    key_moves.push({ id: `k${String(key_moves.length + 1).padStart(2, '0')}`, t, name: b[3] });
  });
  return {
    schema_version: 1,
    id: spec.id,
    version: 1,
    title: spec.title,
    song: spec.song,
    bpm: spec.bpm,
    duration_ms: DURATION_MS,
    first_beat_ms: spec.first_beat_ms,
    count_in_beats: 3,
    w: W,
    h: H,
    mirrored_source: false,
    source: 'synthetic',
    frames,
    key_moves,
    media: { video: null, audio: null },
  };
}

// Choreography. Each list is one entry per beat from first_beat_ms (≤ 15 s). Key moves only land
// on a beat whose pose differs from the one before (the motion gate needs movement before them).
const SPECS: SynthSpec[] = [
  {
    id: 'wave-pop',
    title: 'Wave Pop',
    song: 'Placeholder click track, 120 BPM (royalty-free)',
    bpm: 120,
    first_beat_ms: 500,
    beats: [
      ['down', 'stand', 'up'],
      ['t', 'stand', 'up', 'T pose'],
      ['down', 'stand', 'up'],
      ['v', 'wide', 'up', 'Arms up'],
      ['waveA', 'wide', 'up'],
      ['waveB', 'wide', 'tiltR', 'Wave left'],
      ['waveA', 'wide', 'up'],
      ['waveC', 'wide', 'up'],
      ['waveD', 'wide', 'tiltL', 'Wave right'],
      ['down', 'stand', 'up'],
      ['leftUp', 'stepL', 'leanR', 'Reach left'],
      ['down', 'stand', 'up'],
      ['rightUp', 'stepR', 'leanL', 'Reach right'],
      ['low', 'stand', 'up'],
      ['flex', 'plie', 'up', 'Pop down'],
      ['low', 'stand', 'up'],
      ['cross', 'stand', 'up', 'Cross'],
      ['t', 'wide', 'up'],
      ['clap', 'wide', 'up', 'Clap up'],
      ['down', 'stand', 'up'],
      ['pointL', 'stepL', 'tiltR', 'Point'],
      ['pointR', 'stepR', 'tiltL'],
      ['down', 'stand', 'up'],
      ['disco', 'bounce', 'up', 'Disco'],
      ['down', 'stand', 'up'],
      ['flex', 'wide', 'up'],
      ['up', 'stand', 'up', 'Finish'],
      ['up', 'stand', 'up'],
      ['v', 'stand', 'up'],
    ],
  },
  {
    id: 'bounce-back',
    title: 'Bounce Back',
    song: 'Placeholder click track, 112 BPM (royalty-free)',
    bpm: 112,
    first_beat_ms: 536,
    beats: [
      ['hips', 'stand', 'up'],
      ['hips', 'plie', 'up', 'Squat'],
      ['hips', 'stand', 'up'],
      ['t', 'plie', 'up', 'Wide squat'],
      ['low', 'stand', 'up'],
      ['low', 'kneeL', 'tiltR', 'Knee left'],
      ['low', 'stand', 'up'],
      ['low', 'kneeR', 'tiltL', 'Knee right'],
      ['hips', 'bounce', 'up'],
      ['up', 'stand', 'up', 'Jump up'],
      ['hips', 'bounce', 'up'],
      ['t', 'kickL', 'tiltR', 'Kick left'],
      ['hips', 'stand', 'up'],
      ['t', 'kickR', 'tiltL', 'Kick right'],
      ['low', 'bounce', 'up'],
      ['flex', 'plie', 'up', 'Flex squat'],
      ['low', 'stand', 'up'],
      ['swingL', 'lungeL', 'up', 'Lunge left'],
      ['low', 'stand', 'up'],
      ['swingR', 'lungeR', 'up', 'Lunge right'],
      ['hips', 'bounce', 'up'],
      ['v', 'wide', 'up', 'Arms up'],
      ['hips', 'plie', 'up'],
      ['up', 'stand', 'up', 'Finish'],
      ['up', 'stand', 'up'],
      ['v', 'wide', 'up'],
      ['hips', 'stand', 'up'],
    ],
  },
];

// ---- output -------------------------------------------------------------------------------

const constName = (id: string) => `ROUTINE_${id.toUpperCase().replace(/-/g, '_')}`;

function renderTs(r: RoutineData, how: string): string {
  const { frames, ...head } = r;
  const lines = [
    `// GENERATED by scripts/dance-routine.ts ${how}. Do not edit by hand: the routine's sha256 is`,
    '// bound into Dance Off terms, so a new take is a new version (DANCE-OFF §2, §8).',
    "import type { RoutineData } from '../routine';",
    '',
    '// prettier-ignore',
    `export const ${constName(r.id)}: RoutineData = {`,
  ];
  for (const [k, v] of Object.entries(head)) {
    if (k === 'key_moves') {
      lines.push('  key_moves: [');
      for (const m of r.key_moves) lines.push(`    ${JSON.stringify(m)},`);
      lines.push('  ],');
    } else lines.push(`  ${k}: ${JSON.stringify(v)},`);
  }
  lines.push('  frames: [');
  for (const f of frames) lines.push(`    { t: ${f.t}, k: [${f.k.join(',')}] },`);
  lines.push('  ],', '};', '');
  return lines.join('\n');
}

function writeRoutine(r: RoutineData, how: string): string {
  mkdirSync(ROUTINES_DIR, { recursive: true });
  const path = join(ROUTINES_DIR, `${r.id}.ts`);
  writeFileSync(path, renderTs(r, how));
  return path;
}

async function selftest(): Promise<boolean> {
  const {
    ROUTINES,
    RoutineData: Schema,
    routineSha256,
  } = await import('../packages/shared/src/dance/routine');
  const { scoreRound } = await import('../packages/shared/src/dance/score');
  let ok = true;
  for (const r of ROUTINES) {
    Schema.parse(r);
    const series = {
      schema_version: 1 as const,
      w: r.w,
      h: r.h,
      fps_cap: 30,
      sync_offset_ms: 0,
      frames: r.frames.map((f) => ({ t: f.t, n: 2, a: f.k, b: f.k })),
    };
    const res = scoreRound(r, series);
    const pass = res.a.score_x10 === 1000 && res.b.score_x10 === 1000;
    ok &&= pass;
    const grades = res.a.key_moves.map((m) => m.grade[0]).join('');
    console.log(
      `${pass ? 'ok  ' : 'FAIL'} ${r.id} v${r.version} sha256:${routineSha256(r).slice(0, 16)} ` +
        `frames=${r.frames.length} keys=${r.key_moves.length} a=${res.a.score_x10 / 10} ` +
        `b=${res.b.score_x10 / 10} raw=${res.a.raw.toFixed(4)} cont=${res.a.continuous.toFixed(3)} ` +
        `move=${res.a.movement.toFixed(3)} conv=${res.a.convention} keys=${grades}`,
    );
  }
  return ok;
}

// ---- import -------------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function importRoutine(file: string, args: string[]): Promise<void> {
  const { routineFromImport } = await import('../packages/shared/src/dance/routine-import');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RoutineImportJson;
  const routine = routineFromImport(raw, {
    id: flag(args, 'id'),
    title: flag(args, 'title'),
    song: flag(args, 'song'),
    bpm: flag(args, 'bpm'),
    firstBeatMs: flag(args, 'first-beat-ms'),
    version: flag(args, 'version'),
    durationMs: flag(args, 'duration-ms'),
    keyMoves: flag(args, 'key-moves'),
    every: flag(args, 'every'),
    video: flag(args, 'video'),
    audio: flag(args, 'audio'),
  });
  const named = routine.key_moves.filter((m) => !/^Move \d+$/.test(m.name)).length;
  console.log(
    `wrote ${writeRoutine(routine, `import ${file.split('/').pop()}`)} (${routine.frames.length} ` +
      `frames, ${routine.key_moves.length} key moves at ` +
      `${routine.key_moves.map((m) => m.t).join(',')}; ${named} named)`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'synth') {
    for (const spec of SPECS) {
      const r = synthesize(spec);
      console.log(`wrote ${writeRoutine(r, 'synth')} (${r.frames.length} frames)`);
    }
    if (!(await selftest())) process.exitCode = 1;
  } else if (cmd === 'import') {
    const file = args[0];
    if (!file) throw new Error('usage: import <routine.json> [flags]');
    await importRoutine(file, args.slice(1));
  } else if (cmd === 'selftest') {
    if (!(await selftest())) process.exitCode = 1;
  } else {
    console.error('usage: dance-routine.ts synth | import <json> [flags] | selftest');
    process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
