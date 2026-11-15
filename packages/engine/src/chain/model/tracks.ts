/**
 * §9.4 #8 post_tracks, #9 run_rules, #13 verify_biometric_proof, #14 verify_sp1_run.
 */
import {
  BET_STATE,
  CONSENT_WINDOW_S,
  MAX_BUFFER_PAYLOAD,
  MAX_CHECKPOINTS,
  PERCEPTION_TIMEOUT_S,
  POST_TRACKS_CHUNK,
  SP1_PUBLIC_VALUES_BYTES,
  TAU_FACE_BPS,
  TAU_VOICE_BPS,
} from '../../constants.js';
import type {
  BetAccount,
  DecodedProgram,
  ErrorCode,
  InstructionArgsMap,
  TrackBufferAccount,
  VerifiedCheckpoint,
} from '../../types.js';
import { BorshReader, bytesEqual, fromHex, isZero, pubkeyBytes, sha256, toHex, ZERO_HASH, ZERO_KEY } from '../bytes.js';
import { bigIntToBe32, bioHashOf } from '../hashes.js';
import { ChainError, check, type Env, fail } from './env.js';

/** Splits a finalized TrackBuffer payload into its §5.6 parts. */
export function payloadParts(tb: TrackBufferAccount): {
  program: Uint8Array;
  calibration: Uint8Array;
  tracks: Uint8Array | null;
} {
  const { program_len: pl, calibration_len: cl, payload_len: n } = tb.header;
  const p = tb.payload.subarray(0, n);
  return {
    program: p.subarray(0, pl),
    calibration: p.subarray(pl, pl + cl),
    tracks: n === pl + cl ? null : p.subarray(pl + cl),
  };
}

function oracleSigner(bet: BetAccount, env: Env): void {
  const o = env.signer('oracle');
  check(o === bet.oracle, 'Unauthorized');
}

function malformedCode(e: unknown, fallback: ErrorCode): ErrorCode {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'MalformedProgram' || code === 'MalformedCalibration' || code === 'MalformedTracks') return code;
  return fallback;
}

/** `ProgramBetMismatch` check: the decoded program must describe this Bet. */
function programMatchesBet(dp: DecodedProgram, bet: BetAccount): boolean {
  if (dp.P !== bet.n_participants) return false;
  for (let i = 0; i < dp.P; i++) {
    if (dp.participants[i] !== bet.participants[i]) return false;
    if (BigInt(dp.stakes[i]!) !== bet.stakes[i]) return false;
  }
  if (dp.side_b_mask !== bet.side_b_mask) return false;
  if (dp.time_limit_s !== bet.time_limit_s) return false;
  const kindFlags = dp.kind === 1 ? 0x02 : dp.kind === 2 ? 0x04 : 0;
  if ((bet.flags & 0x06) !== kindFlags) return false;
  const actorBound = dp.legs.some((l) => (l.flags & 1) !== 0) ? 1 : 0;
  return (bet.flags & 1) === actorBound;
}

/** #8 post_tracks. */
export function postTracks(bet: BetAccount, env: Env, a: InstructionArgsMap['post_tracks']): void {
  oracleSigner(bet, env);
  check(bet.state === BET_STATE.Perceiving, 'InvalidState');
  check(bet.tracks_finalized === 0, 'InvalidState');
  check(a.payload_len <= MAX_BUFFER_PAYLOAD, 'BufferTooLarge');
  check(a.data.length <= POST_TRACKS_CHUNK, 'BufferTooLarge');
  check(a.program_len + a.calibration_len <= a.payload_len, 'BufferLayout');

  const prev = env.ctx.track_buffer;
  let tb: TrackBufferAccount;
  if (!prev) {
    tb = {
      header: {
        bet: env.betKey,
        payload_len: a.payload_len,
        program_len: a.program_len,
        calibration_len: a.calibration_len,
        written: 0,
        finalized: 0,
        bump: 0,
      },
      payload: new Uint8Array(a.payload_len),
    };
  } else {
    const h = prev.header;
    check(h.bet === env.betKey, 'BufferLayout');
    check(
      h.payload_len === a.payload_len && h.program_len === a.program_len && h.calibration_len === a.calibration_len,
      'BufferLayout',
    );
    check(h.finalized === 0, 'InvalidState');
    tb = { header: { ...h }, payload: prev.payload.slice() };
    if (tb.payload.length !== h.payload_len) {
      const p = new Uint8Array(h.payload_len);
      p.set(tb.payload.subarray(0, Math.min(tb.payload.length, h.payload_len)));
      tb.payload = p;
    }
  }
  check(a.offset === tb.header.written, 'BufferLayout');
  check(a.offset + a.data.length <= tb.header.payload_len, 'BufferTooLarge');
  tb.payload.set(a.data, a.offset);
  tb.header.written += a.data.length;
  env.trackBuffer = tb;

  if (!a.finalize) return;

  check(tb.header.written === tb.header.payload_len, 'BufferIncomplete');
  const parts = payloadParts(tb);
  check(toHex(sha256(parts.program)) === bet.program_hash, 'ProgramHashMismatch');
  if (parts.calibration.length === 0) check(bet.calibration_hash === ZERO_HASH, 'CalibrationHashMismatch');
  else check(toHex(sha256(parts.calibration)) === bet.calibration_hash, 'CalibrationHashMismatch');

  // Order matches post_tracks.rs validate_payload: program, calibration, program↔bet,
  // SP1-only layout, then tracks.

  const hooks = env.opts.hooks;
  let dp: DecodedProgram;
  try {
    dp = hooks.decodeProgram(parts.program);
  } catch (e) {
    fail(malformedCode(e, 'MalformedProgram'));
  }
  try {
    if (dp.kind === 0) hooks.decodeCalibration(parts.calibration, dp);
    else check(parts.calibration.length === 0, 'MalformedCalibration');
  } catch (e) {
    if (e instanceof ChainError) throw e;
    fail(malformedCode(e, 'MalformedCalibration'));
  }
  check(programMatchesBet(dp, bet), 'ProgramBetMismatch');
  if (parts.tracks === null) check(env.opts.sp1, 'BufferLayout');
  if (parts.tracks !== null) {
    try {
      if (dp.kind === 2) hooks.decodeMarketBin(parts.tracks);
      else hooks.decodeTrackBin(parts.tracks, dp);
    } catch (e) {
      fail(malformedCode(e, 'MalformedTracks'));
    }
  }

  const pr = a.perception_root.toLowerCase();
  fromHex(pr, 32);
  bet.perception_root = pr;
  if (parts.tracks === null) {
    bet.tracks_hash = ZERO_HASH;
    bet.tracks_finalized = 2;
  } else {
    bet.tracks_hash = toHex(sha256(parts.tracks));
    bet.tracks_finalized = 1;
  }
  tb.header.finalized = 1;
  env.emit('TracksPosted', {
    bet: env.betKey,
    perception_root: bet.perception_root,
    tracks_hash: bet.tracks_hash,
    payload_len: tb.header.payload_len,
  });
}

/** Records a pre-ruling (shared by run_rules and verify_sp1_run). */
function applyPreruling(
  bet: BetAccount,
  env: Env,
  preruling: number,
  reason: number,
  winnerMask: number,
  legResults: number[],
): void {
  bet.preruling = preruling as BetAccount['preruling'];
  bet.prerule_reason = reason;
  bet.winner_mask = winnerMask;
  bet.leg_results = legResults.slice(0, 8);
  while (bet.leg_results.length < 8) bet.leg_results.push(0xff);
  bet.preruled_at = env.now;
  if (preruling === 1) {
    bet.state = BET_STATE.PreRuled;
    bet.consent_deadline = env.now + BigInt(CONSENT_WINDOW_S);
  } else {
    bet.state = BET_STATE.Disputed;
    bet.consent_deadline = 0n;
    bet.dispute_reason = reason as BetAccount['dispute_reason'];
    bet.dispute_bond = 0n;
    bet.disputer = ZERO_KEY;
    bet.disputed_at = env.now;
  }
  env.emit('PreRuled', {
    bet: env.betKey,
    preruling,
    reason,
    winner_mask: winnerMask,
    leg_results: [...bet.leg_results],
    consent_deadline: bet.consent_deadline,
  });
  if (preruling !== 1) {
    env.emit('Disputed', { bet: env.betKey, disputer: ZERO_KEY, reason, bond: 0n });
  }
}

function verifiedCheckpoints(bet: BetAccount): VerifiedCheckpoint[] {
  return bet.bio.slice(0, bet.n_bio).map((b) => ({ participant: b.participant, frame: b.frame }));
}

/** #9 run_rules. */
export function runRules(bet: BetAccount, env: Env): void {
  oracleSigner(bet, env);
  check(bet.state === BET_STATE.Perceiving, 'InvalidState');
  check(bet.tracks_finalized === 1, 'TracksNotFinalized');
  check(env.now <= bet.ended_at + BigInt(PERCEPTION_TIMEOUT_S), 'DeadlinePassed');
  const tb = env.ctx.track_buffer;
  check(!!tb && tb.header.finalized === 1 && tb.header.bet === env.betKey, 'TracksNotFinalized');
  const parts = payloadParts(tb);
  check(parts.tracks !== null, 'TracksNotFinalized');
  let r;
  try {
    r = env.opts.hooks.evaluate(parts.program, parts.calibration, parts.tracks, verifiedCheckpoints(bet));
  } catch (e) {
    fail(malformedCode(e, 'MalformedTracks'));
  }
  const legs = r.leg_results.map((v) => v as number);
  check(legs.length <= 8, 'MalformedProgram');
  if (r.preruling === 1) applyPreruling(bet, env, 1, 0, r.winner_mask, legs);
  else applyPreruling(bet, env, 3, r.reason, 0, legs);
}

/** §8.6 public inputs (8 × 32-byte big-endian). */
export function publicInputs(
  commitment: Uint8Array,
  bet: string,
  evidenceRoot: Uint8Array,
  participant: number,
  frame: number,
  modality: number,
  tauBps: number,
): Uint8Array[] {
  const field = (b: Uint8Array): Uint8Array => {
    const out = b.slice();
    out[0] = 0;
    return out;
  };
  return [
    commitment.slice(),
    field(pubkeyBytes(bet)),
    field(evidenceRoot),
    bigIntToBe32(BigInt(participant)),
    bigIntToBe32(BigInt(frame)),
    bigIntToBe32(BigInt(modality)),
    bigIntToBe32(BigInt(tauBps)),
    bigIntToBe32(1n),
  ];
}

/** #13 verify_biometric_proof. */
export function verifyBiometricProof(
  bet: BetAccount,
  env: Env,
  a: InstructionArgsMap['verify_biometric_proof'],
): void {
  oracleSigner(bet, env);
  check(bet.state === BET_STATE.Perceiving, 'InvalidState');
  // Order and codes match verify_biometric_proof.rs.
  check(Number.isInteger(a.participant) && a.participant < bet.n_participants, 'NotParticipant');
  const profile = env.ctx.profile;
  check(!!profile && profile.wallet === bet.participants[a.participant], 'NotParticipant');
  check(profile.updated_at <= bet.created_at, 'ProfileTooNew');
  check(a.modality === 0 || a.modality === 1, 'BadReason');
  const commitHex = (a.modality === 0 ? profile.face_commit : profile.voice_commit).toLowerCase();
  const commitment = fromHex(commitHex, 32);
  check(!isZero(commitment), 'MissingCommitment');
  check(a.tau_bps >= (a.modality === 0 ? TAU_FACE_BPS : TAU_VOICE_BPS), 'TauTooLow');
  check(a.proof_a.length === 64 && a.proof_b.length === 128 && a.proof_c.length === 64, 'BadProof');

  const inputs = publicInputs(
    commitment,
    env.betKey,
    fromHex(bet.evidence_root, 32),
    a.participant,
    a.frame,
    a.modality,
    a.tau_bps,
  );
  const mockOk = a.proof_a.every((b) => b === 0x01);
  const verifier = env.ctx.verifyGroth16;
  const ok = mockOk || !verifier || verifier(inputs, { a: a.proof_a, b: a.proof_b, c: a.proof_c });
  check(ok, 'BadProof');

  const dup = bet.bio
    .slice(0, bet.n_bio)
    .some((b) => b.participant === a.participant && b.frame === a.frame);
  if (!dup) {
    check(bet.n_bio < MAX_CHECKPOINTS, 'TooManyCheckpoints');
    bet.bio[bet.n_bio] = { participant: a.participant, modality: a.modality, frame: a.frame };
    bet.n_bio += 1;
  }
  env.emit('BiometricVerified', {
    bet: env.betKey,
    participant_idx: a.participant,
    modality: a.modality,
    frame: a.frame,
  });
}

/** #14 verify_sp1_run (feature `sp1`). */
export function verifySp1Run(bet: BetAccount, env: Env, a: InstructionArgsMap['verify_sp1_run']): void {
  check(env.opts.sp1, 'Sp1Disabled');
  oracleSigner(bet, env);
  check(bet.state === BET_STATE.Perceiving, 'InvalidState');
  check(bet.tracks_finalized === 2, 'TracksNotFinalized');
  check(env.now <= bet.ended_at + BigInt(PERCEPTION_TIMEOUT_S), 'DeadlinePassed');
  check(a.public_values.length === SP1_PUBLIC_VALUES_BYTES, 'BadProof');
  const r = new BorshReader(a.public_values);
  const programHash = r.hash();
  const calibrationHash = r.hash();
  const perceptionRoot = r.hash();
  const evidenceRoot = r.hash();
  const bioHash = r.raw(32);
  const preruling = r.u8();
  const reason = r.u8();
  const winnerMask = r.u8();
  const legResults = r.array(8, (x) => x.u8());
  check(programHash === bet.program_hash, 'ProgramHashMismatch');
  check(calibrationHash === bet.calibration_hash, 'CalibrationHashMismatch');
  check(perceptionRoot === bet.perception_root, 'BadProof');
  check(evidenceRoot === bet.evidence_root, 'BadProof');
  check(bytesEqual(bioHash, bioHashOf(bet.bio.slice(0, bet.n_bio))), 'BadProof');
  const verifier = env.opts.verifySp1;
  check(!verifier || verifier(a.public_values, a.proof), 'BadProof');
  if (preruling === 1) {
    check(reason === 0 && winnerMask !== 0 && winnerMask >> bet.n_participants === 0, 'BadProof');
  } else {
    check(preruling === 3 && [10, 11, 12, 13].includes(reason) && winnerMask === 0, 'BadProof');
  }
  check(legResults.every((v) => v <= 2 || v === 0xff), 'BadProof');
  applyPreruling(bet, env, preruling, reason, winnerMask, legResults);
}
