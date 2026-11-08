import { describe, expect, it } from 'vitest';
import { PERCEPTION_TIMEOUT_S } from '../src/constants.js';
import { BorshWriter, fromHex, sha256, toHex, utf8, ZERO_HASH } from '../src/chain/bytes.js';
import { bioHashOf } from '../src/chain/hashes.js';
import { publicInputs } from '../src/chain/model/tracks.js';
import type { InstructionArgsMap, ProfileAccount } from '../src/types.js';
import { ALICE, BET, BOB, fakeDecodedProgram, fakeProgramBin, okResult, ORACLE, panelResult, World } from './chain-helpers.js';

function perceiving(w = new World()): World {
  return w.create().fundAll().start().end();
}

function postArgs(w: World, over: Partial<InstructionArgsMap['post_tracks']> = {}): InstructionArgsMap['post_tracks'] {
  const p = w.payload();
  return {
    payload_len: p.length,
    program_len: w.programBin.length,
    calibration_len: w.calibrationBin.length,
    offset: 0,
    data: p,
    finalize: true,
    perception_root: 'cd'.repeat(32),
    ...over,
  };
}

describe('chain model: post_tracks', () => {
  it('writes in sequential chunks and finalises', () => {
    const w = perceiving();
    const payload = w.payload();
    const r1 = w.ok('post_tracks', postArgs(w, { data: payload.subarray(0, 10), finalize: false }), [ORACLE.pk]);
    expect(r1.track_buffer!.header).toMatchObject({ bet: BET, written: 10, finalized: 0, payload_len: payload.length });
    expect(r1.events).toEqual([]);
    w.err('BufferLayout', 'post_tracks', postArgs(w, { offset: 5, data: payload.subarray(5, 10), finalize: false }), [
      ORACLE.pk,
    ]);
    w.err('BufferLayout', 'post_tracks', postArgs(w, { offset: 10, payload_len: payload.length + 1, data: payload.subarray(10) }), [
      ORACLE.pk,
    ]);
    w.err('BufferIncomplete', 'post_tracks', postArgs(w, { offset: 10, data: payload.subarray(10, 20) }), [ORACLE.pk]);
    const r2 = w.ok('post_tracks', postArgs(w, { offset: 10, data: payload.subarray(10) }), [ORACLE.pk]);
    expect(r2.bet.tracks_finalized).toBe(1);
    expect(r2.bet.tracks_hash).toBe(toHex(sha256(w.trackBin)));
    expect(r2.bet.perception_root).toBe('cd'.repeat(32));
    expect(r2.track_buffer!.header.finalized).toBe(1);
    expect(r2.events).toEqual([
      {
        name: 'TracksPosted',
        data: { bet: BET, perception_root: 'cd'.repeat(32), tracks_hash: r2.bet.tracks_hash, payload_len: payload.length },
      },
    ]);
    w.err('InvalidState', 'post_tracks', postArgs(w), [ORACLE.pk]);
  });

  it('size limits', () => {
    const w = perceiving();
    w.err('BufferTooLarge', 'post_tracks', postArgs(w, { payload_len: 10_001, data: new Uint8Array(0), finalize: false }), [
      ORACLE.pk,
    ]);
    w.err('BufferTooLarge', 'post_tracks', postArgs(w, { payload_len: 10_000, data: new Uint8Array(701), finalize: false }), [
      ORACLE.pk,
    ]);
    w.err('BufferLayout', 'post_tracks', postArgs(w, { payload_len: 3, program_len: 2, calibration_len: 2, data: new Uint8Array(0) }), [
      ORACLE.pk,
    ]);
    w.ok('post_tracks', postArgs(w, { payload_len: 10_000, program_len: 1, calibration_len: 1, data: new Uint8Array(700), finalize: false }), [
      ORACLE.pk,
    ]);
    w.err('BufferIncomplete', 'post_tracks', postArgs(w, { payload_len: 10_000, program_len: 1, calibration_len: 1, offset: 700, data: new Uint8Array(0) }), [ORACLE.pk]);
    const small = perceiving();
    small.ok('post_tracks', postArgs(small, { payload_len: 100, program_len: 1, calibration_len: 1, data: new Uint8Array(90), finalize: false }), [ORACLE.pk]);
    small.err('BufferTooLarge', 'post_tracks', postArgs(small, { payload_len: 100, program_len: 1, calibration_len: 1, offset: 90, data: new Uint8Array(11), finalize: false }), [ORACLE.pk]);
  });

  it('finalize validation errors', () => {
    const mk = () => perceiving();
    let w = mk();
    w.programBin = fakeProgramBin(fakeDecodedProgram({ time_limit_s: 61 }));
    w.err('ProgramHashMismatch', 'post_tracks', postArgs(w), [ORACLE.pk]);

    w = mk();
    w.calibrationBin = utf8('VCAL-other');
    w.err('CalibrationHashMismatch', 'post_tracks', postArgs(w), [ORACLE.pk]);

    w = mk();
    w.trackBin = utf8('XXXX');
    w.err('MalformedTracks', 'post_tracks', postArgs(w), [ORACLE.pk]);

    w = mk();
    w.trackBin = new Uint8Array();
    w.err('BufferLayout', 'post_tracks', postArgs(w), [ORACLE.pk]);

    w = mk();
    w.err('Unauthorized', 'post_tracks', postArgs(w), [ALICE.pk], { oracle: ALICE.pk });
  });

  it('malformed program / calibration and ProgramBetMismatch', () => {
    const w1 = new World();
    w1.programBin = utf8('garbage-program');
    perceiving(w1);
    w1.err('MalformedProgram', 'post_tracks', postArgs(w1), [ORACLE.pk]);

    const w2 = new World();
    w2.calibrationBin = utf8('NOPE');
    perceiving(w2);
    w2.err('MalformedCalibration', 'post_tracks', postArgs(w2), [ORACLE.pk]);

    for (const over of [
      { side_b_mask: 1 },
      { time_limit_s: 61 },
      { stakes: [1_000_000, 999_999] },
      { participants: [BOB.pk, ALICE.pk] },
      {
        legs: [{ ...fakeDecodedProgram().legs[0]!, flags: 1 }],
      },
    ]) {
      const w = new World();
      w.programBin = fakeProgramBin(fakeDecodedProgram(over));
      perceiving(w);
      w.err('ProgramBetMismatch', 'post_tracks', postArgs(w), [ORACLE.pk]);
    }
  });

  it('kind mismatch: calibration present for a non-rules program, or wrong kind', () => {
    const w = new World();
    w.programBin = fakeProgramBin(fakeDecodedProgram({ kind: 1 }));
    perceiving(w);
    w.err('MalformedCalibration', 'post_tracks', postArgs(w), [ORACLE.pk]);
    const w2 = new World({ flags: 2 });
    w2.programBin = fakeProgramBin(fakeDecodedProgram({ kind: 2 }));
    w2.trackBin = utf8('VMKT');
    perceiving(w2);
    w2.err('ProgramBetMismatch', 'post_tracks', postArgs(w2), [ORACLE.pk]);
  });

  it('SP1-only payload requires the sp1 feature and sets tracks_finalized = 2', () => {
    const w = new World({}, { sp1: true });
    w.trackBin = new Uint8Array();
    perceiving(w);
    const r = w.ok('post_tracks', postArgs(w), [ORACLE.pk]);
    expect(r.bet.tracks_finalized).toBe(2);
    expect(r.bet.tracks_hash).toBe(ZERO_HASH);
    w.err('TracksNotFinalized', 'run_rules', {}, [ORACLE.pk]);
  });
});

describe('chain model: run_rules', () => {
  it('WINNER → PreRuled with consent deadline', () => {
    const w = perceiving().postTracks();
    w.engine.result = okResult(1, [1, 0]);
    const r = w.runRules();
    expect(r.bet).toMatchObject({
      state: 4,
      preruling: 1,
      prerule_reason: 0,
      winner_mask: 1,
      preruled_at: w.now,
      consent_deadline: w.now + 120n,
    });
    expect(r.bet.leg_results).toEqual([1, 0, 255, 255, 255, 255, 255, 255]);
    expect(r.events).toEqual([
      {
        name: 'PreRuled',
        data: { bet: BET, preruling: 1, reason: 0, winner_mask: 1, leg_results: r.bet.leg_results, consent_deadline: w.now + 120n },
      },
    ]);
  });

  it('NEEDS_PANEL → Disputed without bond', () => {
    const w = perceiving().postTracks();
    w.engine.result = panelResult(12);
    const r = w.runRules();
    expect(r.bet).toMatchObject({ state: 5, preruling: 3, prerule_reason: 12, dispute_reason: 12, dispute_bond: 0n, disputed_at: w.now });
    expect(r.events.map((e) => e.name)).toEqual(['PreRuled', 'Disputed']);
    expect(r.events[1]!.data).toEqual({ bet: BET, disputer: '11111111111111111111111111111111', reason: 12, bond: 0n });
  });

  it('requires finalized tracks, the oracle and the perception window', () => {
    const w = perceiving();
    w.err('TracksNotFinalized', 'run_rules', {}, [ORACLE.pk]);
    w.postTracks();
    w.err('Unauthorized', 'run_rules', {}, [ALICE.pk], { oracle: ALICE.pk });
    w.now = w.bet.ended_at + BigInt(PERCEPTION_TIMEOUT_S) + 1n;
    w.err('DeadlinePassed', 'run_rules', {}, [ORACLE.pk]);
    w.now -= 1n;
    w.runRules();
  });

  it('passes Bet.bio as verified checkpoints', () => {
    const w = perceiving();
    w.bet = { ...w.bet, n_bio: 1, bio: [{ participant: 1, modality: 0, frame: 41 }, ...w.bet.bio.slice(1)] };
    w.postTracks().runRules();
    expect(w.engine.lastVerified).toEqual([{ participant: 1, frame: 41 }]);
  });
});

function profileFor(wallet: string, updatedAt: bigint, face = '00'.repeat(31) + '07'): ProfileAccount {
  return {
    wallet,
    face_commit: face,
    voice_commit: ZERO_HASH,
    display_name: '',
    name_len: 0,
    flags: 1,
    bump: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
    reserved: ZERO_HASH,
  };
}

function bioArgs(over: Partial<InstructionArgsMap['verify_biometric_proof']> = {}): InstructionArgsMap['verify_biometric_proof'] {
  return {
    participant: 1,
    modality: 0,
    frame: 41,
    tau_bps: 5500,
    proof_a: new Uint8Array(64).fill(2),
    proof_b: new Uint8Array(128),
    proof_c: new Uint8Array(64),
    ...over,
  };
}

describe('chain model: verify_biometric_proof', () => {
  it('appends a BioCheck, dedupes, and caps at 8', () => {
    const w = perceiving();
    w.profile = profileFor(BOB.pk, w.bet.created_at);
    const r = w.ok('verify_biometric_proof', bioArgs(), [ORACLE.pk], { profile: 'x' });
    expect(r.bet.n_bio).toBe(1);
    expect(r.bet.bio[0]).toEqual({ participant: 1, modality: 0, frame: 41 });
    expect(r.events).toEqual([{ name: 'BiometricVerified', data: { bet: BET, participant_idx: 1, modality: 0, frame: 41 } }]);
    w.ok('verify_biometric_proof', bioArgs({ modality: 0 }), [ORACLE.pk]);
    expect(w.bet.n_bio).toBe(1);
    for (let f = 1; f <= 7; f++) w.ok('verify_biometric_proof', bioArgs({ frame: 41 + f }), [ORACLE.pk]);
    expect(w.bet.n_bio).toBe(8);
    w.err('TooManyCheckpoints', 'verify_biometric_proof', bioArgs({ frame: 100 }), [ORACLE.pk]);
  });

  it('checks profile, commitment, tau and the proof', () => {
    const w = perceiving();
    w.profile = profileFor(BOB.pk, w.bet.created_at + 1n);
    w.err('ProfileTooNew', 'verify_biometric_proof', bioArgs(), [ORACLE.pk]);
    w.profile = profileFor(ALICE.pk, w.bet.created_at);
    w.err('NotParticipant', 'verify_biometric_proof', bioArgs(), [ORACLE.pk]);
    w.err('NotParticipant', 'verify_biometric_proof', bioArgs({ participant: 2 }), [ORACLE.pk]);
    w.profile = profileFor(BOB.pk, w.bet.created_at);
    w.err('MissingCommitment', 'verify_biometric_proof', bioArgs({ modality: 1, tau_bps: 5000 }), [ORACLE.pk]);
    w.err('TauTooLow', 'verify_biometric_proof', bioArgs({ tau_bps: 5499 }), [ORACLE.pk]);

    let seen: Uint8Array[] = [];
    const ctxVerifier = (inputs: Uint8Array[]) => {
      seen = inputs;
      return false;
    };
    const r = w.model.apply(
      w.bet,
      { name: 'verify_biometric_proof', args: bioArgs(), signers: [ORACLE.pk], accounts: { oracle: ORACLE.pk, bet: BET } },
      { ...w.ctx(), verifyGroth16: ctxVerifier },
    );
    expect(r).toEqual({ error: 'BadProof' });
    expect(seen).toEqual(publicInputs(fromHex(w.profile!.face_commit), BET, fromHex(w.bet.evidence_root), 1, 41, 0, 5500));
    expect(seen[1]![0]).toBe(0);
    expect(seen[7]![31]).toBe(1);
    // mock-zk proof (proof_a = 0x01 × 64) is accepted even with a rejecting verifier
    const r2 = w.model.apply(
      w.bet,
      {
        name: 'verify_biometric_proof',
        args: bioArgs({ proof_a: new Uint8Array(64).fill(1) }),
        signers: [ORACLE.pk],
        accounts: { oracle: ORACLE.pk, bet: BET },
      },
      { ...w.ctx(), verifyGroth16: ctxVerifier },
    );
    expect('error' in r2).toBe(false);
  });
});

function sp1Values(w: World, over: { preruling?: number; reason?: number; mask?: number; program?: string } = {}): Uint8Array {
  return new BorshWriter(171)
    .hash(over.program ?? w.bet.program_hash)
    .hash(w.bet.calibration_hash)
    .hash(w.bet.perception_root)
    .hash(w.bet.evidence_root)
    .raw(bioHashOf(w.bet.bio.slice(0, w.bet.n_bio)))
    .u8(over.preruling ?? 1)
    .u8(over.reason ?? 0)
    .u8(over.mask ?? 2)
    .raw(new Uint8Array([0, 255, 255, 255, 255, 255, 255, 255]))
    .toBytes();
}

describe('chain model: verify_sp1_run', () => {
  it('is disabled by default', () => {
    const w = perceiving();
    w.err('Sp1Disabled', 'verify_sp1_run', { public_values: new Uint8Array(171), proof: new Uint8Array() }, [ORACLE.pk]);
  });

  it('applies the proven pre-ruling and settles with path RULE', () => {
    const w = new World({}, { sp1: true });
    w.trackBin = new Uint8Array();
    perceiving(w).postTracks();
    w.err('ProgramHashMismatch', 'verify_sp1_run', { public_values: sp1Values(w, { program: 'ab'.repeat(32) }), proof: new Uint8Array() }, [
      ORACLE.pk,
    ]);
    w.err('BadProof', 'verify_sp1_run', { public_values: sp1Values(w, { mask: 0 }), proof: new Uint8Array() }, [ORACLE.pk]);
    w.err('BadProof', 'verify_sp1_run', { public_values: sp1Values(w).subarray(1), proof: new Uint8Array() }, [ORACLE.pk]);
    const r = w.ok('verify_sp1_run', { public_values: sp1Values(w), proof: new Uint8Array() }, [ORACLE.pk]);
    expect(r.bet).toMatchObject({ state: 4, preruling: 1, winner_mask: 2 });
    w.now = w.bet.consent_deadline + 1n;
    const s = w.ok('consent', { winner_mask: 2, evidence_root: w.bet.evidence_root }, [ORACLE.pk], { authority: ORACLE.pk });
    expect(s.bet.settle_path).toBe(2);
  });

  it('a proven NEEDS_PANEL goes to Disputed', () => {
    const w = new World({}, { sp1: true, verifySp1: () => true });
    w.trackBin = new Uint8Array();
    perceiving(w).postTracks();
    const r = w.ok('verify_sp1_run', { public_values: sp1Values(w, { preruling: 3, reason: 13, mask: 0 }), proof: new Uint8Array() }, [
      ORACLE.pk,
    ]);
    expect(r.bet).toMatchObject({ state: 5, dispute_reason: 13 });
  });

  it('rejects when the verifier fails', () => {
    const w = new World({}, { sp1: true, verifySp1: () => false });
    w.trackBin = new Uint8Array();
    perceiving(w).postTracks();
    w.err('BadProof', 'verify_sp1_run', { public_values: sp1Values(w), proof: new Uint8Array() }, [ORACLE.pk]);
  });
});
