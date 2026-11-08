/**
 * §9.4 #1–#4: init_profile, create_bet, fund, cancel.
 */
import {
  BET_ACCOUNT_VERSION,
  BET_STATE,
  FUND_WINDOW_S,
  MARKET_TIME_LIMIT_MAX_S,
  MAX_PARTICIPANTS,
  MAX_STAKE_UNITS,
  MAX_WITNESSES,
  MIN_PARTICIPANTS,
  MIN_STAKE_UNITS,
  PROFILE_NAME_BYTES,
  REFUND_REASON,
  TIME_LIMIT_MAX_S,
} from '../../constants.js';
import type { BetAccount, InstructionArgsMap, ProfileAccount, RefundReasonCode } from '../../types.js';
import { fromHex, isValidPubkey, isZero, toHex, utf8, ZERO_HASH, ZERO_KEY } from '../bytes.js';
import { beToBigInt, BN254_R, HEAD_NONE, termsHashOf } from '../hashes.js';
import { allMask, check, type Env, participantIndex } from './env.js';
import { refundAll } from './payout.js';

const MIN_STAKE = BigInt(MIN_STAKE_UNITS);
const MAX_STAKE = BigInt(MAX_STAKE_UNITS);

function validCommitment(hex: string): boolean {
  const b = fromHex(hex.toLowerCase(), 32);
  return isZero(b) || beToBigInt(b) < BN254_R;
}

/** #1 init_profile: creates or overwrites the wallet's Profile. */
export function initProfile(_bet: BetAccount, env: Env, a: InstructionArgsMap['init_profile']): void {
  const wallet = env.signer('wallet');
  // Matches init_profile.rs: an over-long name is `BadCommitment`, checked before the commitments.
  check(utf8(a.display_name).length <= PROFILE_NAME_BYTES, 'BadCommitment');
  check(validCommitment(a.face_commit) && validCommitment(a.voice_commit), 'BadCommitment');
  const prev = env.ctx.profile;
  const existing = prev && prev.wallet === wallet ? prev : null;
  const face = a.face_commit.toLowerCase();
  const voice = a.voice_commit.toLowerCase();
  const flags = (face !== ZERO_HASH ? 1 : 0) | (voice !== ZERO_HASH ? 2 : 0);
  const profile: ProfileAccount = {
    wallet,
    face_commit: face,
    voice_commit: voice,
    display_name: a.display_name,
    name_len: utf8(a.display_name).length,
    flags,
    bump: existing?.bump ?? 0,
    created_at: existing?.created_at ?? env.now,
    updated_at: env.now,
    reserved: ZERO_HASH,
  };
  env.profile = profile;
  env.emit('ProfileUpdated', { wallet, flags });
}

/** #2 create_bet. */
export function createBet(bet: BetAccount, env: Env, a: InstructionArgsMap['create_bet']): void {
  check(bet.version === 0, 'InvalidState');
  const creator = env.signer('creator');
  const oracle = env.signer('oracle');
  const P = a.participants.length;

  // Order follows Rust `validate_terms` (create_bet.rs).
  // participants: count, creator first, nonzero + distinct, oracle not a participant
  check(P >= MIN_PARTICIPANTS && P <= MAX_PARTICIPANTS, 'BadParticipants');
  check(a.participants[0] === creator, 'BadParticipants');
  check(a.participants.every(isValidPubkey) && a.participants.every((k) => k !== ZERO_KEY), 'BadParticipants');
  check(new Set(a.participants).size === P, 'BadParticipants');
  check(!a.participants.includes(oracle), 'BadParticipants');

  // flags (§9.2)
  const f = a.flags;
  check(Number.isInteger(f) && (f & ~0x07) === 0, 'BadFlags');
  const ai = (f & 0x02) !== 0;
  const market = (f & 0x04) !== 0;
  check(!(ai && market), 'BadFlags');
  check(!((ai || market) && (f & 0x01) !== 0), 'BadFlags');

  // sides
  const m = a.side_b_mask;
  check(Number.isInteger(m) && (m & 1) === 0 && m !== 0 && m >> P === 0, 'BadSides');

  // stakes: length, then values
  check(a.stakes.length === P, 'BadStake');
  if (market) {
    check(a.stake_each === 0n, 'BadStake');
    check(a.stakes.every((s) => s >= MIN_STAKE && s <= MAX_STAKE), 'BadStake');
  } else {
    check(a.stake_each >= MIN_STAKE && a.stake_each <= MAX_STAKE, 'BadStake');
    check(a.stakes.every((s) => s === a.stake_each), 'BadStake');
  }

  // time limit per kind
  const maxT = market ? MARKET_TIME_LIMIT_MAX_S : TIME_LIMIT_MAX_S;
  check(Number.isInteger(a.time_limit_s) && a.time_limit_s >= 1 && a.time_limit_s <= maxT, 'BadTimeLimit');

  // judges
  const j = a.judges;
  check(j.length === 3 && new Set(j).size === 3, 'BadJudges');
  check(j.every((k) => isValidPubkey(k) && k !== ZERO_KEY), 'BadJudges');
  check(j.every((k) => !a.participants.includes(k)), 'BadJudges');
  check(j.every((k) => k !== oracle), 'BadJudges');

  check(a.program_hash.toLowerCase() !== ZERO_HASH, 'ProgramHashMismatch');

  bet.version = BET_ACCOUNT_VERSION;
  bet.state = BET_STATE.Proposed;
  bet.flags = f;
  bet.creator = creator;
  bet.nonce = a.nonce;
  bet.mint = env.account('mint');
  bet.oracle = oracle;
  bet.judges = [...j];
  bet.n_participants = P;
  bet.participants = [...a.participants, ...Array<string>(MAX_PARTICIPANTS - P).fill(ZERO_KEY)];
  bet.stakes = [...a.stakes, ...Array<bigint>(MAX_PARTICIPANTS - P).fill(0n)];
  bet.side_b_mask = m;
  bet.funded_mask = 0;
  bet.stake_each = a.stake_each;
  bet.time_limit_s = a.time_limit_s;
  bet.program_hash = a.program_hash.toLowerCase();
  bet.calibration_hash = ZERO_HASH;
  bet.acceptance_audio_hash = a.acceptance_audio_hash.toLowerCase();
  bet.created_at = env.now;
  bet.fund_deadline = env.now + BigInt(FUND_WINDOW_S);
  bet.witnesses = Array<string>(MAX_WITNESSES).fill(ZERO_KEY);
  bet.witness_kinds = Array<number>(MAX_WITNESSES).fill(0xff);
  bet.witness_heads = Array<number>(MAX_WITNESSES).fill(HEAD_NONE);
  bet.witness_head_hashes = Array<string>(MAX_WITNESSES).fill(ZERO_HASH);
  bet.leg_results = Array<number>(8).fill(0xff);
  bet.disputer = ZERO_KEY;

  env.emit('BetCreated', {
    bet: env.betKey,
    creator,
    nonce: a.nonce,
    participants: [...a.participants],
    stakes: [...a.stakes],
    side_b_mask: m,
    flags: f,
    program_hash: bet.program_hash,
    time_limit_s: a.time_limit_s,
    fund_deadline: bet.fund_deadline,
  });
}

/** #3 fund. */
export function fund(bet: BetAccount, env: Env, a: InstructionArgsMap['fund']): void {
  check(bet.state === BET_STATE.Proposed, 'InvalidState');
  check(env.now <= bet.fund_deadline, 'DeadlinePassed');
  const signer = env.signer('participant');
  const i = participantIndex(bet, signer);
  check(i >= 0, 'NotParticipant');
  check(((bet.funded_mask >> i) & 1) === 0, 'AlreadyFunded');
  check(a.program_hash.toLowerCase() === bet.program_hash, 'ConsentMismatch');
  const terms = toHex(termsHashOf(bet.oracle, bet.judges, bet.acceptance_audio_hash));
  check(a.terms_hash.toLowerCase() === terms, 'ConsentMismatch');
  const cal = a.calibration_hash.toLowerCase();
  if ((bet.flags & 0x06) !== 0) {
    check(cal === ZERO_HASH, 'CalibrationMismatch');
  } else {
    // Rules bets always carry a calibration (fund.rs; errata [anchor] 3).
    check(cal !== ZERO_HASH, 'CalibrationMismatch');
    if (bet.calibration_hash === ZERO_HASH) bet.calibration_hash = cal;
    else check(cal === bet.calibration_hash, 'CalibrationMismatch');
  }
  const src = env.account('participant_token');
  env.checkTokenOwner(src, signer);
  const amount = bet.stakes[i]!;
  env.transfer(src, env.account('vault'), amount);
  bet.funded_mask |= 1 << i;
  const all = bet.funded_mask === allMask(bet);
  if (all) {
    bet.state = BET_STATE.Funded;
    bet.funded_at = env.now;
  }
  env.emit('Funded', {
    bet: env.betKey,
    participant: signer,
    participant_idx: i,
    amount,
    funded_mask: bet.funded_mask,
    all_funded: all,
    calibration_hash: bet.calibration_hash,
  });
}

/** #4 cancel: creator, Proposed only; refunds funded stakes (reason 7). */
export function cancel(bet: BetAccount, env: Env): void {
  const creator = env.signer('creator');
  check(creator === bet.creator, 'Unauthorized');
  check(bet.state === BET_STATE.Proposed, 'InvalidState');
  env.checkOracleAccount(bet);
  env.emit('BetCancelled', { bet: env.betKey });
  refundAll(bet, env, REFUND_REASON.cancelled as RefundReasonCode);
}
