/**
 * One Unknown case per cause (§3.9), the panel reasons (§3.1), the checkpoint
 * guard (> MAX_CHECKPOINTS), `holds` failing on occlusion vs. on the
 * predicate, the cost cap, and market programs (§3.11, §5.5).
 */
import {
  TRACK_FLAG_CAMERA_MOTION,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
} from '../../src/constants.js';
import { compileMarket } from '../../src/lang/index.js';
import { marketHash } from '../../src/hash/index.js';
import type { Expr, MarketQuote, Program } from '../../src/types.js';
import {
  CREATOR,
  FRIEND,
  box,
  buffer,
  calib,
  col,
  makeVector,
  prog,
  ref,
  rep,
  type VectorJson,
} from './common.js';

const obj = (name: string, phrase = name) => ({ name, kind: 'object' as const, phrase });
const zone = (name: string) => ({ name, kind: 'region' as const, shape: 'zone' as const });
const SQUARE: [number, number][] = [
  [2000, 2000],
  [6000, 2000],
  [6000, 6000],
  [2000, 6000],
];

// ---------------------------------------------------------------------------
// holds: §15.2-like tower

function towerProgram(): Program {
  return prog({
    entities: [obj('tower', 'cup tower')],
    legs: [{ success: { op: 'intact', a: ref('tower') }, rule: { kind: 'holds', frames: 100 } }],
    time_limit_s: 30,
  });
}

const TALL = { x0: 4000, y0: 3000, x1: 5500, y1: 9000, conf: 90, fill: 60, id_conf: 0, pose: 0 };
const SHORT = { ...TALL, y0: 6000 }; // height 3000 < 75% of 6000

function holdsVectors(): VectorJson[] {
  const p = towerProgram();
  const c = calib();
  const out: VectorJson[] = [];
  out.push(
    makeVector({
      name: 'holds_fail_occlusion',
      description: 'holds 10s: the tower is unseen (absent) at frame 50, the first failing frame ⇒ Unknown (OCCLUSION) ⇒ panel reason 10',
      covers: ['holds_fail_occlusion', 'unknown_cause OCCLUSION'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { tower: col(105, (f) => (f === 50 ? null : { ...TALL })) }, refH: { tower: 6000 } }),
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['OCCLUSION']], decisive_frames: [[50]] },
    }),
  );
  out.push(
    makeVector({
      name: 'holds_fail_predicate',
      description: 'holds 10s: the tower is present but shorter than INTACT_PCT of ref_h at frame 50 ⇒ raw False ⇒ the other side wins',
      covers: ['holds_fail_predicate'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { tower: col(105, (f) => (f === 50 ? { ...SHORT } : { ...TALL })) }, refH: { tower: 6000 } }),
      intent: { status: 'ok', leg_results: [0], winner_mask: 2, decisive_frames: [[50]] },
    }),
  );
  out.push(
    makeVector({
      name: 'holds_intact_boundary',
      description: 'intact at exactly (y1-y0)·100 = ref_h·INTACT_PCT (4500·100 = 6000·75) holds; the leg is True',
      covers: ['primitive intact_boundary'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { tower: col(100, (f) => (f === 70 ? { ...TALL, y0: 4500 } : { ...TALL })) }, refH: { tower: 6000 } }),
      intent: { status: 'ok', leg_results: [1], winner_mask: 1 },
    }),
  );
  out.push(
    makeVector({
      name: 'unknown_coverage',
      description: 'holds 10s, but the buffer ends at frame 80 (frames 80..99 missing from F) ⇒ raw False, Unknown (COVERAGE), no failing frame',
      covers: ['unknown_cause COVERAGE'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { tower: rep({ ...TALL }, 80) }, refH: { tower: 6000 } }),
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['COVERAGE']], decisive_frames: [[]] },
    }),
  );
  out.push(
    makeVector({
      name: 'unknown_coverage_gap',
      description: 'holds 10s with two segments [0,40) and [45,105): frames 40..44 are not in F ⇒ Unknown (COVERAGE)',
      covers: ['unknown_cause COVERAGE', 'multi_segment'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { tower: rep({ ...TALL }, 100) }, segs: [[0, 40], [45, 60]], refH: { tower: 6000 } }),
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['COVERAGE']] },
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// actor-bound: a person walks into a zone

function walkerProgram(): Program {
  return prog({
    entities: [{ name: 'walker', kind: 'person', participant: 1 }, zone('goal')],
    legs: [{ success: { op: 'inside', a: ref('walker'), b: ref('goal') }, rule: { kind: 'exists' } }],
    outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
  });
}

/** walker outside until frame 10, then inside the zone (feet anchor). */
function walkerCol(n: number, extra: (f: number) => Partial<{ conf: number; id_conf: number }> = () => ({})) {
  return col(n, (f) => {
    const cx = f < 10 ? 8000 : 4000;
    return { x0: cx - 400, y0: 2000, x1: cx + 400, y1: 5000, conf: 90, fill: 50, id_conf: 90, pose: 1, ...extra(f) };
  });
}

function actorVectors(): VectorJson[] {
  const p = walkerProgram();
  const c = calib([{ entity: 'goal', shape: 'zone', points: SQUARE }]);
  const out: VectorJson[] = [];
  out.push(
    makeVector({
      name: 'actor_bound_pass',
      description: 'Actor-bound exists: the bound participant (1) is inside the zone at 10 with id_conf 90 and a verified checkpoint (1, 10) ⇒ winner side 1',
      covers: ['checkpoint pass'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20) } }),
      verified: [{ participant: 1, frame: 10 }],
      intent: { status: 'ok', leg_results: [1], winner_mask: 2, n_checkpoints: 1, checkpoints: [{ participant: 1, frame: 10 }] },
    }),
  );
  out.push(
    makeVector({
      name: 'unknown_identity_unverified',
      description: 'Same scene, but the checkpoint (1, 10) is not in the verified list ⇒ Unknown (IDENTITY)',
      covers: ['unknown_cause IDENTITY'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20) } }),
      verified: [{ participant: 1, frame: 11 }],
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['IDENTITY']], n_checkpoints: 1 },
    }),
  );
  out.push(
    makeVector({
      name: 'unknown_identity_low_id_conf',
      description: 'Verified checkpoint, but id_conf = 59 < ID_CONF_MIN at the checkpoint frame ⇒ Unknown (IDENTITY)',
      covers: ['unknown_cause IDENTITY'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20, (f) => (f === 10 ? { id_conf: 59 } : {})) } }),
      verified: [{ participant: 1, frame: 10 }],
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['IDENTITY']] },
    }),
  );
  out.push(
    makeVector({
      name: 'unknown_conf',
      description: 'The decisive frame 10 has conf 49 (present, < DECISIVE_CONF_MIN) ⇒ Unknown (CONF); CONF precedes IDENTITY',
      covers: ['unknown_cause CONF'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20, (f) => (f === 10 ? { conf: 49 } : {})) } }),
      verified: [{ participant: 1, frame: 10 }],
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['CONF']] },
    }),
  );
  out.push(
    makeVector({
      name: 'conf_at_threshold',
      description: 'The decisive frame has conf exactly DECISIVE_CONF_MIN (50) ⇒ no CONF cause',
      covers: ['primitive conf_threshold'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20, (f) => (f === 10 ? { conf: 50, id_conf: 60 } : {})) } }),
      verified: [{ participant: 1, frame: 10 }],
      intent: { status: 'ok', leg_results: [1], winner_mask: 2 },
    }),
  );
  out.push(
    makeVector({
      name: 'unknown_motion',
      description: 'track_bin flags bit0 (camera motion) ⇒ every rules leg Unknown (MOTION); checkpoints are still computed [D-40]',
      covers: ['unknown_cause MOTION'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20) }, flags: TRACK_FLAG_CROSS_CHECK_OK | TRACK_FLAG_CAMERA_MOTION }),
      verified: [{ participant: 1, frame: 10 }],
      intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['MOTION']], n_checkpoints: 1 },
    }),
  );
  out.push(
    makeVector({
      name: 'reason_12_cross_check_failed',
      description: 'flags bit1 (cross_check_ok) = 0 ⇒ needs_panel reason 12, legs 2, no causes and no checkpoints',
      covers: ['reason 12'],
      program: p,
      calibration: c,
      buffer: buffer(p, { cols: { walker: walkerCol(20) }, flags: 0 }),
      verified: [{ participant: 1, frame: 10 }],
      intent: { status: 'needs_panel', reason: 12, leg_results: [2], leg_causes: [[]], n_checkpoints: 0, checkpoints: [] },
    }),
  );
  out.push(
    makeVector({
      name: 'reason_13_window_unavailable',
      description: 'flags bit3 (window_unavailable) with S = 0 ⇒ needs_panel reason 13 (checked before bit1)',
      covers: ['reason 13'],
      program: p,
      calibration: c,
      buffer: { ...buffer(p, { cols: {} }), flags: TRACK_FLAG_WINDOW_UNAVAILABLE, segments: [] },
      intent: { status: 'needs_panel', reason: 13, leg_results: [2], leg_causes: [[]] },
    }),
  );
  return out;
}

/** 9 anchors for one person ⇒ more than MAX_CHECKPOINTS (§3.8 guard). */
function tooManyCheckpoints(): VectorJson {
  const p = prog({
    entities: [{ name: 'jumper', kind: 'person', participant: 0 }],
    legs: [{ success: { op: 'standing', a: ref('jumper') }, rule: { kind: 'count', cmp: '>=', k: 9, attempts: 0 } }],
  });
  // standing on even frames 0..16 ⇒ 9 rising edges
  const jumper = col(20, (f) => ({ x0: 3000, y0: 2000, x1: 5000, y1: 9000, conf: 90, fill: 50, id_conf: 90, pose: f % 2 === 0 && f <= 16 ? 1 : 0 }));
  const verified = Array.from({ length: 9 }, (_, i) => ({ participant: 0, frame: 2 * i }));
  return makeVector({
    name: 'checkpoints_more_than_8',
    description:
      'Actor-bound count(standing) >= 9: 9 anchors ⇒ 9 checkpoints > MAX_CHECKPOINTS ⇒ n_checkpoints 0, empty list, every actor-bound leg Unknown (IDENTITY). Decodable but CHECKPOINT_LIMIT at compile time',
    covers: ['checkpoints_more_than_8', 'unknown_cause IDENTITY'],
    program: p,
    calibration: calib(),
    buffer: buffer(p, { cols: { jumper } }),
    verified,
    compileInvalid: true,
    intent: { status: 'needs_panel', reason: 10, leg_results: [2], leg_causes: [['IDENTITY']], n_checkpoints: 0, checkpoints: [] },
  });
}

/** Weight-32 success: or(dis, not(and(dis, and(present, present)))) = 1+12+1+1+12+1+2+2. */
function costVector(nFrames: 252 | 253): VectorJson {
  const dis: Expr = { op: 'disappears_into', a: ref('ball'), b: ref('bin') };
  const success: Expr = {
    op: 'or',
    args: [
      dis,
      {
        op: 'not',
        arg: { op: 'and', args: [dis, { op: 'and', args: [{ op: 'present', a: ref('ball') }, { op: 'present', a: ref('ball') }] }] },
      },
    ],
  };
  const p = prog({ entities: [obj('ball'), zone('bin')], legs: [{ success, rule: { kind: 'exists' } }], time_limit_s: 60 });
  const exceeded = nFrames === 253;
  return makeVector({
    name: exceeded ? 'cost_exceeded' : 'cost_at_cap',
    description: exceeded
      ? 'cost = (253 frames + 4 setup) × 32 = 8224 > MAX_EVAL_COST ⇒ needs_panel reason 13 before any leg is evaluated'
      : 'cost = (252 frames + 4 setup) × 32 = 8192 = MAX_EVAL_COST (not exceeded) ⇒ evaluated normally',
    covers: exceeded ? ['max_eval_cost_exceeded', 'reason 13'] : ['max_eval_cost_boundary'],
    program: p,
    calibration: calib([{ entity: 'bin', shape: 'zone', points: SQUARE }]),
    buffer: buffer(p, { cols: { ball: rep(box(8000, 8000), nFrames) } }),
    intent: exceeded
      ? { status: 'needs_panel', reason: 13, leg_results: [2], leg_causes: [[]] }
      : { status: 'ok', leg_results: [1], decisive_frames: [[0]] },
  });
}

// ---------------------------------------------------------------------------
// Market (§11, §3.11)

const QUOTE_SINGLE: MarketQuote = {
  picks: [{ event_id: 'FED-2026-12', contract_id: 'CUT-25', side: 'yes', prob_bps: 3000, close_time_ms: 1_797_000_000_000 }],
  total_units: 10_000_000,
};

function marketVectors(): VectorJson[] {
  const out: VectorJson[] = [];
  const single = compileMarket(QUOTE_SINGLE, CREATOR, FRIEND, 1_795_000_000_000);
  const h = marketHash('FED-2026-12', 'CUT-25');
  const cases: [string, string, 0 | 1 | 2 | null, 0 | 1 | 2][] = [
    ['market_single_yes', 'Single-leg market (side yes) resolved yes ⇒ leg True', 1, 1],
    ['market_single_no', 'Single-leg market (side yes) resolved no ⇒ leg False', 0, 0],
    ['unknown_void', 'market_bin result 2 (void) ⇒ Unknown (VOID)', 2, 2],
    ['market_missing_entry', 'No market_bin entry for the leg ⇒ Unknown (VOID)', null, 2],
  ];
  for (const [name, description, result, leg] of cases) {
    out.push(
      makeVector({
        name,
        description,
        covers: ['market', ...(leg === 2 ? ['unknown_cause VOID'] : [])],
        program: single,
        calibration: null,
        market: result === null ? [] : [{ market_hash: h, result }],
        readbackCtx: { names: {}, markets: { [h]: 'Fed cuts 25bp in December' } },
        intent: { leg_results: [leg], leg_causes: [leg === 2 ? ['VOID'] : []] },
      }),
    );
  }
  const parlay = compileMarket(
    {
      picks: [
        { event_id: 'NBA-FINALS-2027', contract_id: 'LAL', side: 'no', prob_bps: 8000, close_time_ms: 1_800_000_000_000 },
        { event_id: 'BTC-EOY-2026', contract_id: 'ABOVE-150K', side: 'yes', prob_bps: 4000, close_time_ms: 1_798_000_000_000 },
      ],
      total_units: 25_000_000,
    },
    CREATOR,
    FRIEND,
    1_795_000_000_000,
  );
  out.push(
    makeVector({
      name: 'market_parlay',
      description: 'Two-leg parlay (no + yes): both resolve as picked, plus an unrelated extra entry ⇒ True',
      covers: ['market', 'market_parlay'],
      program: parlay,
      calibration: null,
      market: [
        { market_hash: marketHash('NBA-FINALS-2027', 'LAL'), result: 0 },
        { market_hash: marketHash('BTC-EOY-2026', 'ABOVE-150K'), result: 1 },
        { market_hash: marketHash('OTHER', 'X'), result: 2 },
      ],
      intent: { leg_results: [1, 1] },
    }),
  );
  return out;
}

export function causeVectors(): VectorJson[] {
  return [...holdsVectors(), ...actorVectors(), tooManyCheckpoints(), costVector(252), costVector(253), ...marketVectors()];
}
