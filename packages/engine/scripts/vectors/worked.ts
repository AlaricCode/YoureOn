/**
 * Worked examples (§15) compiled from their YAML, run through every
 * MOCK_SCENARIO of the mock perception pipeline (§13: "Each scenario has a
 * test vector"), plus the ai_judged example §15.4.
 */
import { AI_JUDGED_TRACK_FLAGS, MOCK_SCENARIOS } from '../../src/constants.js';
import { parseYaml } from '../../src/lang/index.js';
import { simulatePipeline } from '../../src/perception/index.js';
import type { Calibration, LegCause, MockScenario, Program } from '../../src/types.js';
import { CTX2, VECTOR_MODEL_HASH, makeVector, type Intent, type VectorJson } from './common.js';

export const PAPER_BALL_YAML = `version: 2
entities:
  shooter: person(p1)
  ball:    object("crumpled paper ball")
  can:     object("trash can")
  line:    region(tap)
legs:
  - id: 1
    actor_bound: true
    valid_attempt: ball released_by shooter while shooter behind line
    success: ball disappears_into can.opening
             or (ball inside can and ball at_rest 1s)
    rule: count(success) >= 1 within attempts 3
outcome: side(shooter) wins iff leg 1 true; else side(creator)
stake_each: 5_000_000
time_limit_s: 180
`;

export const CUP_TOWER_YAML = `version: 2
entities:
  tower: object("cup tower")
  fan:   object("fan")
legs:
  - id: 1
    actor_bound: false
    success: tower intact
    rule: holds(success) for 10s
outcome: side(creator) wins iff leg 1 true; else side(other)
stake_each: 2_000_000
time_limit_s: 30
`;

export const PUSH_UPS_YAML = `version: 2
entities:
  me: person(p0)
legs:
  - id: 1
    actor_bound: true
    success: rep_count(me) >= 20
    rule: success before 60s
outcome: side(me) wins iff leg 1 true; else side(other)
stake_each: 10_000_000
time_limit_s: 90
`;

export const AI_JUDGED_YAML = `version: 2
kind: ai_judged
question: "Does Sam finish the hot sauce wing without drinking anything?"
outcome: side(B) wins iff yes; else side(A)
stake_each: 3_000_000
time_limit_s: 120
`;

export const PAPER_BALL_CALIBRATION: Calibration = {
  version: 1,
  scene: {
    camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' },
    entity_refs: [
      { entity: 'ball', label: 'Paper ball', bbox: [1200, 7000, 1500, 7500] },
      { entity: 'can', label: 'Trash can', bbox: [7600, 6200, 8800, 9400] },
      { entity: 'shooter', label: 'Maya', bbox: [500, 1500, 2500, 9800] },
    ],
  },
  regions: [{ entity: 'line', shape: 'line', points: [[3000, 6000], [3000, 10000]], behind_sign: 1 }],
};

export const CUP_TOWER_CALIBRATION: Calibration = {
  version: 1,
  scene: {
    camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' },
    entity_refs: [
      { entity: 'tower', label: 'Cup tower', bbox: [4000, 3000, 5500, 9000] },
      { entity: 'fan', label: 'Fan', bbox: [7000, 5000, 9000, 9000] },
    ],
  },
  regions: [],
};

export const PUSH_UPS_CALIBRATION: Calibration = {
  version: 1,
  scene: {
    camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' },
    entity_refs: [{ entity: 'me', label: 'Sam', bbox: [2000, 6000, 8000, 9000] }],
  },
  regions: [],
};

export function compileExample(yaml: string): Program {
  const r = parseYaml(yaml, CTX2);
  if (!r.ok) throw new Error(`worked example does not compile: ${JSON.stringify(r.errors)}`);
  return r.program;
}

export interface WorkedExample {
  key: string;
  section: string;
  yaml: string;
  calibration: Calibration;
  /** winner masks for True / False */
  maskTrue: number;
  maskFalse: number;
  /** what each scenario must produce (§13: "evaluation matches the scenario") */
  scenarios: Record<MockScenario, { reason: 0 | 10 | 12 | 13; leg: 0 | 1 | 2; cause: readonly LegCause[] }>;
}

const common = {
  cross_fail: { reason: 12, leg: 2, cause: [] },
  motion: { reason: 10, leg: 2, cause: ['MOTION'] },
  low_conf: { reason: 10, leg: 2, cause: ['CONF'] },
  oversize: { reason: 13, leg: 2, cause: [] },
  pass: { reason: 0, leg: 1, cause: [] },
  fail: { reason: 0, leg: 0, cause: [] },
} as const;

export const WORKED: WorkedExample[] = [
  {
    key: 'ex1_paper_ball',
    section: '§15.1',
    yaml: PAPER_BALL_YAML,
    calibration: PAPER_BALL_CALIBRATION,
    maskTrue: 2,
    maskFalse: 1,
    scenarios: {
      ...common,
      no_identity: { reason: 10, leg: 2, cause: ['IDENTITY'] },
      // the ball is briefly occluded mid-flight; occlusion fill / look-ahead keep the shot valid
      occlusion: { reason: 0, leg: 1, cause: [] },
    },
  },
  {
    key: 'ex2_cup_tower',
    section: '§15.2',
    yaml: CUP_TOWER_YAML,
    calibration: CUP_TOWER_CALIBRATION,
    maskTrue: 1,
    maskFalse: 2,
    scenarios: {
      ...common,
      // not actor-bound: no identity pipeline, so the scenario passes
      no_identity: { reason: 0, leg: 1, cause: [] },
      occlusion: { reason: 10, leg: 2, cause: ['OCCLUSION'] },
    },
  },
  {
    key: 'ex3_push_ups',
    section: '§15.3',
    yaml: PUSH_UPS_YAML,
    calibration: PUSH_UPS_CALIBRATION,
    maskTrue: 1,
    maskFalse: 2,
    scenarios: {
      ...common,
      no_identity: { reason: 10, leg: 2, cause: ['IDENTITY'] },
      occlusion: { reason: 0, leg: 1, cause: [] },
    },
  },
];

/** Seed used by every scenario vector. */
export const SCENARIO_SEED = 1;

export function workedVectors(): VectorJson[] {
  const out: VectorJson[] = [];
  for (const ex of WORKED) {
    const p = compileExample(ex.yaml);
    for (const sc of MOCK_SCENARIOS) {
      const want = ex.scenarios[sc];
      const run = simulatePipeline(p, ex.calibration, sc, SCENARIO_SEED);
      const intent: Intent = {
        status: want.reason === 0 ? 'ok' : 'needs_panel',
        reason: want.reason,
        leg_results: [want.leg],
        leg_causes: [[...want.cause]],
        winner_mask: want.leg === 1 ? ex.maskTrue : want.leg === 0 ? ex.maskFalse : 0,
      };
      const covers = [`worked_example ${ex.section}`, `mock_scenario ${sc}`];
      if (sc === 'pass' || sc === 'fail') covers.push(`worked_example ${sc}`);
      if (want.cause.length) covers.push(`unknown_cause ${want.cause[0]}`);
      out.push(
        makeVector({
          name: `${ex.key}_${sc}`,
          description: `${ex.section} compiled from its YAML; engine.simulate(…, "${sc}", seed ${SCENARIO_SEED}) → crossCheck → seal → extractDecisiveWindows${
            run.window_unavailable ? ' (null → window_unavailable buffer)' : ''
          } → evaluate`,
          covers,
          program: p,
          calibration: ex.calibration,
          buffer: run.buffer,
          verified: run.verified,
          intent,
        }),
      );
    }
  }
  const ai = compileExample(AI_JUDGED_YAML);
  out.push(
    makeVector({
      name: 'ex4_ai_judged',
      description: '§15.4 ai_judged: L = 0, condition 0x51, minimal track_bin (T = 0, S = 0, flags 0b10) → needs_panel reason 11',
      covers: ['worked_example §15.4', 'ai_judged'],
      program: ai,
      calibration: null,
      buffer: { flags: AI_JUDGED_TRACK_FLAGS, model_hash: VECTOR_MODEL_HASH, tracks: [], segments: [] },
      intent: { status: 'needs_panel', reason: 11, leg_results: [], winner_mask: 0 },
    }),
  );
  return out;
}
