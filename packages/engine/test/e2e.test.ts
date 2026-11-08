/**
 * End-to-end engine test: §15 worked examples compiled from YAML → canonical
 * AST (contract JSON) → encodings and hashes (contract-stated bytes) → every
 * MockScenario through simulate → crossCheck → seal → extractDecisiveWindows →
 * payload → evaluate; then the real-engine chain model through full bet
 * lifecycles (consent, dispute → panel, automatic panel, refunds).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import * as E from '../src/index.js';
import type { Calibration, CompileContext, MockScenario, Program, ProfileAccount, TrackBufferData } from '../src/types.js';
import { ALICE, BET, BOB, JUDGES, ORACLE, PROGRAM_ID, VAULT, World, ata, type Key } from './chain-helpers.js';
import {
  AI_JUDGED_YAML,
  CUP_TOWER_CALIBRATION,
  CUP_TOWER_YAML,
  PAPER_BALL_CALIBRATION,
  PAPER_BALL_YAML,
  PUSH_UPS_CALIBRATION,
  PUSH_UPS_YAML,
  WORKED,
} from '../scripts/vectors/worked.js';

const CTX: CompileContext = {
  creator: ALICE.pk,
  huddle: [
    { wallet: ALICE.pk, display_name: 'Alex', enrolled: true },
    { wallet: BOB.pk, display_name: 'Maya', enrolled: true },
  ],
};

function compile(yaml: string): Program {
  const r = E.parseYaml(yaml, CTX);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.program;
}

const hex = (b: Uint8Array) => E.bytesToHex(b);

// ---------------------------------------------------------------------------
// §15 ASTs exactly as printed in the contract (placeholders → ALICE / BOB)

const AST_15_1 = {
  version: 2,
  kind: 'rules',
  participants: [ALICE.pk, BOB.pk],
  sides: [0, 1],
  entities: [
    { name: 'shooter', kind: 'person', participant: 1 },
    { name: 'ball', kind: 'object', phrase: 'crumpled paper ball' },
    { name: 'can', kind: 'object', phrase: 'trash can' },
    { name: 'line', kind: 'region', shape: 'line' },
  ],
  legs: [
    {
      id: 1,
      actor_bound: true,
      attempt_window_frames: 50,
      valid_attempt: {
        op: 'and',
        args: [
          { op: 'released_by', a: { e: 'ball' }, b: { e: 'shooter' } },
          { op: 'behind', a: { e: 'shooter' }, b: { e: 'line' } },
        ],
      },
      success: {
        op: 'or',
        args: [
          { op: 'disappears_into', a: { e: 'ball' }, b: { e: 'can', sub: 'opening' } },
          {
            op: 'and',
            args: [
              { op: 'inside', a: { e: 'ball' }, b: { e: 'can' } },
              { op: 'at_rest', a: { e: 'ball' }, frames: 10 },
            ],
          },
        ],
      },
      rule: { kind: 'count', cmp: '>=', k: 1, attempts: 3 },
    },
  ],
  outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
  stake_each: 5000000,
  time_limit_s: 180,
};

const AST_15_2 = {
  version: 2,
  kind: 'rules',
  participants: [ALICE.pk, BOB.pk],
  sides: [0, 1],
  entities: [
    { name: 'tower', kind: 'object', phrase: 'cup tower' },
    { name: 'fan', kind: 'object', phrase: 'fan' },
  ],
  legs: [
    { id: 1, actor_bound: false, attempt_window_frames: 50, success: { op: 'intact', a: { e: 'tower' } }, rule: { kind: 'holds', frames: 100 } },
  ],
  outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
  stake_each: 2000000,
  time_limit_s: 30,
};

const AST_15_3 = {
  version: 2,
  kind: 'rules',
  participants: [ALICE.pk, BOB.pk],
  sides: [0, 1],
  entities: [{ name: 'me', kind: 'person', participant: 0 }],
  legs: [
    {
      id: 1,
      actor_bound: true,
      attempt_window_frames: 50,
      success: { op: 'rep_count', a: { e: 'me' }, cmp: '>=', value: 20 },
      rule: { kind: 'before', frames: 600 },
    },
  ],
  outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
  stake_each: 10000000,
  time_limit_s: 90,
};

describe('§15 worked examples: YAML → AST → encodings → hashes', () => {
  it('§15.1 compiles to the contract AST; valid_attempt bytes, can.opening ref byte, cost, tracks', () => {
    const p = compile(PAPER_BALL_YAML);
    expect(p).toEqual(AST_15_1);
    const bin = E.encodeProgram(p);
    const dp = E.decodeProgram(bin);
    expect(hex(dp.legs[0]!.va)).toBe('013501000000000015000300000000');
    // success = or(disappears_into(ball, can.opening), and(inside(ball, can), at_rest(ball, 10)))
    expect(dp.legs[0]!.succ[0]).toBe(0x02);
    expect(dp.legs[0]!.succ[1]).toBe(0x32);
    expect(dp.legs[0]!.succ[3]).toBe(0x12); // can.opening ref byte
    expect(dp.tracked_entities).toEqual([0, 1, 2]);
    expect(dp.legs[0]!.flags).toBe(0b11);
    expect(E.evalCost(dp, 1) - E.evalCost(dp, 0)).toBe(27);
    expect(E.evalCost(dp, 1)).toBe((1 + E.EVAL_COST_SETUP_FRAMES) * 27);
    expect(E.evalCost(dp, 299)).toBeLessThanOrEqual(E.MAX_EVAL_COST);
    expect(E.evalCost(dp, 300)).toBeGreaterThan(E.MAX_EVAL_COST);
    // hashes (§4.2)
    expect(E.jsonHash(p)).toBe(hex(E.sha256(new TextEncoder().encode(E.canonicalJson(p)))));
    expect(dp.json_hash).toBe(E.jsonHash(p));
    expect(E.programHash(p)).toBe(hex(E.sha256(bin)));
    const cbin = E.encodeCalibration(PAPER_BALL_CALIBRATION, p);
    expect(E.calibrationHash(PAPER_BALL_CALIBRATION, p)).toBe(hex(E.sha256(cbin)));
    expect(E.decodeCalibration(cbin, dp).scene_hash).toBe(E.sceneHash(PAPER_BALL_CALIBRATION));
    // round trips
    expect(E.parseYaml(E.toYaml(p), CTX)).toMatchObject({ ok: true, program: p });
    expect(E.readback(p, { names: { [ALICE.pk]: 'Alex', [BOB.pk]: 'Maya' } })).toEqual([
      'Counts if: Maya releases crumpled paper ball and Maya is behind the line',
      'Wins an attempt if: crumpled paper ball goes into the opening of trash can or (crumpled paper ball is inside trash can and crumpled paper ball stays still for 1s)',
      'Needs at least 1 of 3 attempts',
      'Maya win if leg 1; otherwise Alex win',
      '$5.00 each',
      'Time limit 3m',
    ]);
  });

  it('§15.1 calibration: side(L, (1000, 9000)) = +1 ⇒ standing at x < 3000 is behind', () => {
    const p = compile(PAPER_BALL_YAML);
    const c = E.decodeCalibration(E.encodeCalibration(PAPER_BALL_CALIBRATION, p), E.decodeProgram(E.encodeProgram(p)));
    expect(c.regions).toEqual([{ entity_idx: 3, shape: 0, points: [[3000, 6000], [3000, 10000]], behind_sign: 1 }]);
  });

  it('§15.2 compiles to the contract AST; fan is unused (warning, no track); window [0, 105)', () => {
    const r = E.parseYaml(CUP_TOWER_YAML, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.program).toEqual(AST_15_2);
    expect(r.warnings.map((w) => w.code)).toContain('UNUSED_ENTITY');
    const dp = E.decodeProgram(E.encodeProgram(r.program));
    expect(dp.tracked_entities).toEqual([0]);
    const run = E.simulatePipeline(r.program, CUP_TOWER_CALIBRATION, 'pass', 1);
    expect(run.buffer.segments.map((s) => [s.frame_start, s.frames.length])).toEqual([[0, 105]]);
    const tb = E.encodeTrackBin(run.buffer);
    expect(tb.length).toBe(44 + 4 + 8 + 105 * 12); // 1,260 B of records
    expect(E.encodeCalibration(CUP_TOWER_CALIBRATION, r.program)[5]).toBe(0); // R = 0
  });

  it('§15.3 compiles to the contract AST; cost (600 + 4) × 2', () => {
    const p = compile(PUSH_UPS_YAML);
    expect(p).toEqual(AST_15_3);
    const dp = E.decodeProgram(E.encodeProgram(p));
    expect(E.evalCost(dp, 600)).toBe(1208);
    expect(dp.legs[0]!.flags).toBe(0b01);
  });

  it('§15.4 ai_judged: L = 0, condition 0x51, zero calibration hash, reason 11', () => {
    const p = compile(AI_JUDGED_YAML);
    expect(p).toMatchObject({ kind: 'ai_judged', entities: [], legs: [], outcome: { if_true: 1, condition: { op: 'yes' }, else: 0 } });
    const dp = E.decodeProgram(E.encodeProgram(p));
    expect(dp.legs).toEqual([]);
    expect(Array.from(dp.cond)).toEqual([0x51]);
    expect(E.encodeCalibration(null, p).length).toBe(0);
    expect(E.calibrationHash(null, p)).toBe('00'.repeat(32));
    const tb = E.encodeTrackBin({ flags: 0b10, model_hash: '00'.repeat(32), tracks: [], segments: [] });
    expect(E.evaluate(E.encodeProgram(p), new Uint8Array(0), tb, [])).toMatchObject({ status: 'needs_panel', reason: 11, leg_results: [] });
  });
});

// ---------------------------------------------------------------------------
// Scenario pipeline via the public API (no shortcut helpers)

interface Run {
  p: Program;
  c: Calibration;
  buffer: TrackBufferData;
  verified: { participant: number; frame: number }[];
  programBin: Uint8Array;
  calibrationBin: Uint8Array;
  trackBin: Uint8Array;
  perceptionRoot: string;
  result: E.EvalResult;
  full: E.EvalResult;
}

function pipeline(p: Program, c: Calibration, sc: MockScenario, seed: number): Run {
  const { a, b } = E.simulate(p, c, sc, seed);
  const cross = E.crossCheck(a, b, p, c);
  const sealed = E.sealSession(a, cross);
  // verified = every checkpoint the engine computed (identity proofs succeed in the mock)
  const asIfOk = { ...sealed, flags: (sealed.flags | E.TRACK_FLAG_CROSS_CHECK_OK) & ~E.TRACK_FLAG_WINDOW_UNAVAILABLE };
  const verified = E.evaluateSession(p, c, asIfOk, []).checkpoints;
  const full = E.evaluateSession(p, c, sealed, verified);
  const windows = E.extractDecisiveWindows(p, c, sealed, verified);
  const buffer = windows ?? E.windowUnavailableBuffer(p, sealed);
  const programBin = E.encodeProgram(p);
  const calibrationBin = E.encodeCalibration(c, p);
  const trackBin = E.encodeTrackBin(buffer);
  const payload = E.buildPayload(programBin, calibrationBin, trackBin);
  expect(payload.length).toBeLessThanOrEqual(E.MAX_BUFFER_PAYLOAD);
  const parts = E.splitPayload(payload); // self-delimiting program and calibration parts
  expect(parts.tracks).toEqual(E.decodeTrackBin(trackBin, E.decodeProgram(programBin)));
  const result = E.evaluate(parts.program_bin, parts.calibration_bin, parts.tracks_bin!, verified);
  return { p, c, buffer, verified, programBin, calibrationBin, trackBin, perceptionRoot: E.perceptionRoot(sealed), result, full };
}

describe('simulate → crossCheck → seal → extractDecisiveWindows → payload → evaluate', () => {
  for (const ex of WORKED) {
    for (const sc of E.MOCK_SCENARIOS) {
      it(`${ex.key} / ${sc}`, () => {
        const p = compile(ex.yaml);
        const want = ex.scenarios[sc];
        for (const seed of [1, 7]) {
          const r = pipeline(p, ex.calibration, sc, seed);
          expect(r.result.reason).toBe(want.reason);
          expect(r.result.status).toBe(want.reason === 0 ? 'ok' : 'needs_panel');
          expect(r.result.leg_results).toEqual([want.leg]);
          expect(r.result.leg_causes).toEqual([want.cause]);
          expect(r.result.winner_mask).toBe(want.leg === 1 ? ex.maskTrue : want.leg === 0 ? ex.maskFalse : 0);
          // §6.5 post-condition (whenever windows were extracted): same legs, winner, checkpoints
          if (!(r.buffer.flags & E.TRACK_FLAG_WINDOW_UNAVAILABLE)) {
            expect(r.result.leg_results).toEqual(r.full.leg_results);
            expect(r.result.winner_mask).toBe(r.full.winner_mask);
            expect(r.result.checkpoints).toEqual(r.full.checkpoints);
            expect(r.result.cost).toBeLessThanOrEqual(E.MAX_EVAL_COST);
          }
          // evaluateProgram is encode + evaluate
          expect(E.evaluateProgram(p, ex.calibration, r.buffer, r.verified)).toEqual(r.result);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Chain model with the real engine

function profile(wallet: string, updatedAt: bigint): ProfileAccount {
  return {
    wallet,
    face_commit: '00'.repeat(31) + '07',
    voice_commit: '00'.repeat(32),
    display_name: '',
    name_len: 0,
    flags: 1,
    bump: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
    reserved: '00'.repeat(32),
  };
}

function signPanel(w: World, outcome: number, signers: [Key, Key]): void {
  const M = E.panelMessage(PROGRAM_ID, BET, outcome, w.bet.evidence_root, w.bet.program_hash);
  const [a, b] = signers;
  w.prevInstruction = { program_id: E.ED25519_PROGRAM_ID, data: E.ed25519PanelIxData(a.pk, ed25519.sign(M, a.sk), b.pk, ed25519.sign(M, b.sk), M) };
}

/** A World whose chain model runs the real engine on real binaries. */
function realWorld(run: Pick<Run, 'p' | 'programBin' | 'calibrationBin' | 'trackBin'>, flags: number): World {
  const stake = BigInt(run.p.stake_each!);
  const w = new World({ flags, stakes: [stake, stake], timeLimit: run.p.time_limit_s });
  w.model = E.createChainModel();
  w.programBin = run.programBin;
  w.calibrationBin = run.calibrationBin;
  w.trackBin = run.trackBin;
  return w;
}

function proveCheckpoints(w: World, verified: { participant: number; frame: number }[]): void {
  for (const cp of verified) {
    w.profile = profile(w.bet.participants[cp.participant]!, w.bet.created_at);
    w.ok('verify_biometric_proof', {
      participant: cp.participant,
      modality: 0,
      frame: cp.frame,
      tau_bps: E.TAU_FACE_BPS,
      proof_a: new Uint8Array(64).fill(1), // mock-zk proof
      proof_b: new Uint8Array(128),
      proof_c: new Uint8Array(64),
    }, [ORACLE.pk]);
  }
}

const consentArgs = (w: World) => ({ winner_mask: w.bet.winner_mask, evidence_root: w.bet.evidence_root });

describe('chain model lifecycle with the real engine', () => {
  it('§15.1 pass: create → fund → start → end → biometric proofs → post_tracks (700 B chunks) → run_rules → consent → Settled', () => {
    const run = pipeline(compile(PAPER_BALL_YAML), PAPER_BALL_CALIBRATION, 'pass', 1);
    const w = realWorld(run, 1);
    w.create().fundAll().start().end();
    expect(w.bet.state).toBe(3);
    expect(w.bet.calibration_hash).toBe(E.calibrationHash(PAPER_BALL_CALIBRATION, run.p));
    proveCheckpoints(w, run.verified);
    expect(w.bet.n_bio).toBe(1);
    w.postTracks(w.payload(), E.POST_TRACKS_CHUNK, run.perceptionRoot);
    const posted = w.last as Exclude<typeof w.last, null | { error: string }>;
    expect(posted.events.at(-1)).toMatchObject({ name: 'TracksPosted', data: { tracks_hash: hex(E.sha256(run.trackBin)), perception_root: run.perceptionRoot } });
    const pre = w.runRules();
    expect(pre.events[0]).toMatchObject({ name: 'PreRuled', data: { preruling: 1, reason: 0, winner_mask: 2 } });
    expect(w.bet.state).toBe(4);
    w.ok('consent', consentArgs(w), [ALICE.pk], { authority: ALICE.pk });
    const done = w.ok('consent', consentArgs(w), [BOB.pk], { authority: BOB.pk });
    expect(done.bet).toMatchObject({ state: 6, settle_path: 1, final_winner_mask: 2 });
    expect(done.events.at(-1)).toMatchObject({ name: 'Settled', data: { winner_mask: 2, pot: 10_000_000n } });
    expect(done.transfers).toEqual([{ from: VAULT, to: ata(BOB.pk), amount: 10_000_000n }]);
  });

  it('§15.1 pass without the identity proof ⇒ IDENTITY ⇒ automatic panel (reason 10)', () => {
    const run = pipeline(compile(PAPER_BALL_YAML), PAPER_BALL_CALIBRATION, 'pass', 1);
    const w = realWorld(run, 1);
    w.create().fundAll().start().end().postTracks();
    const pre = w.runRules();
    expect(pre.bet).toMatchObject({ state: 5, dispute_reason: 10, dispute_bond: 0n });
  });

  it('§15.3 fail: the loser disputes, the panel overturns, the bond is returned', () => {
    const run = pipeline(compile(PUSH_UPS_YAML), PUSH_UPS_CALIBRATION, 'fail', 1);
    expect(run.result.winner_mask).toBe(2);
    const w = realWorld(run, 1);
    w.create().fundAll().start().end().postTracks();
    w.runRules();
    expect(w.bet).toMatchObject({ state: 4, winner_mask: 2 });
    const d = w.ok('dispute', { reason: 1, evidence_root: w.bet.evidence_root }, [ALICE.pk], { disputer: ALICE.pk, disputer_token: ata(ALICE.pk) });
    expect(d.bet).toMatchObject({ state: 5, dispute_bond: 2_000_000n }); // max(10e6 / 5, 1e5)
    signPanel(w, 1, [JUDGES[0], JUDGES[2]]);
    const s = w.ok('settle_panel', { outcome: 1 }, []);
    expect(s.bet).toMatchObject({ state: 6, settle_path: 3, final_winner_mask: 1 });
    expect(s.events.at(-1)).toMatchObject({ name: 'Settled', data: { pot: 20_000_000n, payouts: [22_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] } });
  });

  it('§15.2 cross_fail: automatic panel (reason 12), no contest ⇒ Refunded (2)', () => {
    const run = pipeline(compile(CUP_TOWER_YAML), CUP_TOWER_CALIBRATION, 'cross_fail', 1);
    const w = realWorld(run, 0);
    w.create().fundAll().start().end().postTracks();
    const pre = w.runRules();
    expect(pre.events.map((e) => e.name)).toEqual(['PreRuled', 'Disputed']);
    expect(w.bet).toMatchObject({ state: 5, dispute_reason: 12 });
    signPanel(w, 0, [JUDGES[1], JUDGES[2]]);
    const r = w.ok('settle_panel', { outcome: 0 }, []);
    expect(r.bet).toMatchObject({ state: 7, refund_reason: 2 });
    expect(r.events.at(-1)).toMatchObject({ name: 'Refunded', data: { amounts: [2_000_000n, 2_000_000n, 0n, 0n, 0n, 0n, 0n, 0n] } });
  });

  it('§15.2 oversize: reason 13, the panel never rules ⇒ refund after PANEL_TIMEOUT_S (6)', () => {
    const run = pipeline(compile(CUP_TOWER_YAML), CUP_TOWER_CALIBRATION, 'oversize', 1);
    const w = realWorld(run, 0);
    w.create().fundAll().start().end().postTracks();
    w.runRules();
    expect(w.bet).toMatchObject({ state: 5, dispute_reason: 13 });
    w.now = w.bet.disputed_at + BigInt(E.PANEL_TIMEOUT_S);
    w.err('NotRefundable', 'refund', {}, []);
    w.now += 1n;
    expect(w.ok('refund', {}, []).bet).toMatchObject({ state: 7, refund_reason: 6 });
  });

  it('§15.4 ai_judged: reason 11 ⇒ panel rules side 1', () => {
    const p = compile(AI_JUDGED_YAML);
    const programBin = E.encodeProgram(p);
    const trackBin = E.encodeTrackBin({ flags: 0b10, model_hash: '00'.repeat(32), tracks: [], segments: [] });
    const w = realWorld({ p, programBin, calibrationBin: new Uint8Array(0), trackBin }, 2);
    w.create().fundAll().start([]).end().postTracks();
    w.runRules();
    expect(w.bet).toMatchObject({ state: 5, dispute_reason: 11 });
    signPanel(w, 2, [JUDGES[0], JUDGES[1]]);
    expect(w.ok('settle_panel', { outcome: 2 }, []).bet).toMatchObject({ state: 6, final_winner_mask: 2 });
  });

  it('silence = consent after the window; refund paths before start', () => {
    const run = pipeline(compile(CUP_TOWER_YAML), CUP_TOWER_CALIBRATION, 'pass', 1);
    const w = realWorld(run, 0);
    w.create().fundAll().start().end().postTracks();
    w.runRules();
    expect(w.bet.winner_mask).toBe(1);
    w.now = w.bet.consent_deadline + 1n;
    expect(w.ok('consent', consentArgs(w), [ORACLE.pk], { authority: ORACLE.pk }).bet).toMatchObject({ state: 6, settle_path: 1 });

    const f = realWorld(run, 0).create().fund(ALICE);
    f.now = f.bet.fund_deadline + 1n;
    expect(f.ok('refund', {}, []).bet).toMatchObject({ state: 7, refund_reason: 1 });

    const s = realWorld(run, 0).create().fundAll().start().end().postTracks();
    s.now = s.bet.ended_at + BigInt(E.PERCEPTION_TIMEOUT_S) + 1n;
    s.err('DeadlinePassed', 'run_rules', {}, [ORACLE.pk]);
    expect(s.ok('refund', {}, []).bet).toMatchObject({ state: 7, refund_reason: 5 });
  });

  it('post_tracks finalize rejects a program that does not match the bet, and malformed tracks', () => {
    const run = pipeline(compile(CUP_TOWER_YAML), CUP_TOWER_CALIBRATION, 'pass', 1);
    /** Posts all but the last chunk, then expects the finalizing chunk to fail. */
    const finalizeFails = (w: World, error: string) => {
      const p = w.payload();
      const base = { payload_len: p.length, program_len: w.programBin.length, calibration_len: w.calibrationBin.length };
      let off = 0;
      for (; off + E.POST_TRACKS_CHUNK < p.length; off += E.POST_TRACKS_CHUNK) {
        w.ok('post_tracks', { ...base, offset: off, data: p.subarray(off, off + E.POST_TRACKS_CHUNK), finalize: false, perception_root: '00'.repeat(32) }, [ORACLE.pk]);
      }
      w.err(error, 'post_tracks', { ...base, offset: off, data: p.subarray(off), finalize: true, perception_root: run.perceptionRoot }, [ORACLE.pk]);
    };
    // the bet says 3 USDC each, the program says 2 USDC each
    const w = realWorld(run, 0);
    w.opts.stakes = [3_000_000n, 3_000_000n];
    w.create().fundAll().start().end();
    finalizeFails(w, 'ProgramBetMismatch');

    const m = realWorld(run, 0);
    m.trackBin = Uint8Array.from(run.trackBin);
    m.trackBin[8] = 0xe2; // reserved flag bits 5–7
    m.create().fundAll().start().end();
    finalizeFails(m, 'MalformedTracks');
  });
});

describe('scene-check rows: lang conditionRows ≡ eval leafSignals (minus the signal)', () => {
  for (const ex of WORKED) {
    it(ex.key, () => {
      const p = compile(ex.yaml);
      const labels: Record<string, string> = {};
      for (const r of ex.calibration.scene.entity_refs) labels[r.entity] = r.label;
      const { a } = E.simulate(p, ex.calibration, 'pass', 1);
      const sig = E.leafSignals(p, ex.calibration, a);
      expect(sig.map(({ signal: _s, ...row }) => row)).toEqual(E.conditionRows(p, labels));
      for (const row of sig) expect(row.signal.length).toBe(a.n_frames);
    });
  }
});
