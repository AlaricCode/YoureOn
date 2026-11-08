/**
 * Decoder-rejection vectors (§0.6: "every decoder rejection in §5 with its
 * expected error code"), plus the extra program checks shared with
 * crates/verdict-rules (CONTRACTS-ERRATA "[verdict-rules] 1–3").
 */
import { encodeCalibration, encodeProgram, encodeTrackBin } from '../../src/encode/index.js';
import { jsonHash, marketHash, sceneHash } from '../../src/hash/index.js';
import type { Program } from '../../src/types.js';
import { CREATOR, FRIEND, THIRD, buffer, errorVector, rec, rep, type VectorJson } from './common.js';
import {
  AND,
  BEFORE,
  FOR,
  LEG,
  NOT,
  OR,
  THEN,
  W,
  YES,
  leaf,
  patched,
  rawCalibration,
  rawMarket,
  rawProgram,
  refByte,
  writeU16,
  writeU32,
  type RawLeg,
  type RawProgram,
} from './rawbin.js';
import { PAPER_BALL_CALIBRATION, PAPER_BALL_YAML, compileExample } from './worked.js';

const MP = 'MalformedProgram';
const MC = 'MalformedCalibration';
const MT = 'MalformedTracks';

// Leaf codes (§5.1)
const OVERLAPS = 0x10, INSIDE = 0x11, NEAR = 0x14, BEHIND = 0x15, MOVING = 0x20, AT_REST = 0x21, SPEED = 0x22;
const DIRECTION = 0x23, PRESENT = 0x24, ENTERS = 0x30, DISAPPEARS = 0x32, RELEASED_BY = 0x35, STANDING = 0x40, REP_COUNT = 0x41;

// §15.1 entity indices: shooter 0 (person p1), ball 1, can 2, line 3
const VA = AND(leaf(RELEASED_BY, 1, 0), leaf(BEHIND, 0, 3));
const SUCC = OR(leaf(DISAPPEARS, 1, refByte(2, 1)), AND(leaf(INSIDE, 1, 2), leaf(AT_REST, 1, 0, 10)));

function baseLeg(): RawLeg {
  return { id: 1, flags: 0b11, rule_kind: 1, rule_cmp: 0, rule_k: 1, rule_n: 3, attempt_window: 50, va: [...VA], succ: [...SUCC] };
}

/** A non-actor-bound exists leg: present(ball). */
function plainLeg(id: number, succ = leaf(PRESENT, 1)): RawLeg {
  return { id, flags: 0, rule_kind: 0, rule_cmp: 0, rule_k: 0, rule_n: 0, attempt_window: 50, va: [], succ };
}

let BASE_PROGRAM: Program;
function base(): RawProgram {
  BASE_PROGRAM ??= compileExample(PAPER_BALL_YAML);
  return {
    magic: 'VRDP',
    version: 2,
    kind: 0,
    fps: 10,
    json_hash: jsonHash(BASE_PROGRAM),
    time_limit_s: 180,
    participants: [...BASE_PROGRAM.participants],
    stakes: [5_000_000, 5_000_000],
    side_b_mask: 0b10,
    entities: [
      [0, 1],
      [2, 0],
      [2, 0],
      [3, 0],
    ],
    legs: [baseLeg()],
    if_true: 1,
    else: 0,
    cond: LEG(1),
  };
}

/** Balanced and-tree with n leaves (2n - 1 nodes). */
function balanced(n: number, mk: () => number[], op = AND): number[] {
  if (n === 1) return mk();
  const l = Math.floor(n / 2);
  return op(balanced(l, mk, op), balanced(n - l, mk, op));
}

function nested(depth: number, inner: number[]): number[] {
  let x = inner;
  for (let i = 1; i < depth; i++) x = NOT(x);
  return x;
}

export function rejectionVectors(): VectorJson[] {
  const out: VectorJson[] = [];
  const p0 = base();
  const goodProgram = rawProgram(p0);
  // The independent builder must agree with the encoder on the valid base case.
  const enc = encodeProgram(compileExample(PAPER_BALL_YAML));
  if (Buffer.compare(Buffer.from(goodProgram), Buffer.from(enc)) !== 0) throw new Error('rawProgram(base) ≠ encodeProgram(§15.1)');
  const goodCal = encodeCalibration(PAPER_BALL_CALIBRATION, BASE_PROGRAM);
  const shooter = rec(500, 1500, 2500, 9800, { id_conf: 90, pose: 1 });
  const goodBuf = buffer(BASE_PROGRAM, {
    cols: { shooter: rep(shooter, 5), ball: rep(rec(1850, 4850, 2150, 5150), 5), can: rep(rec(7600, 6200, 8800, 9400), 5) },
  });
  const goodTracks = encodeTrackBin(goodBuf);

  const prog = (name: string, description: string, mod: (r: RawProgram) => void, error = MP, covers = ['decoder_rejection program_bin']): void => {
    const r = base();
    mod(r);
    out.push(errorVector(`reject_program_${name}`, description, { program_bin: rawProgram(r), calibration_bin: goodCal, track_bin: goodTracks }, error, covers));
  };
  const progBin = (name: string, description: string, bin: Uint8Array): void => {
    out.push(errorVector(`reject_program_${name}`, description, { program_bin: bin, calibration_bin: goodCal, track_bin: goodTracks }, MP, ['decoder_rejection program_bin']));
  };
  const leg0 = (r: RawProgram) => r.legs[0]!;

  // --- header
  prog('bad_magic', 'magic "VRDQ"', (r) => (r.magic = 'VRDQ'));
  prog('bad_version', 'format_version 3', (r) => (r.version = 3));
  prog('bad_fps', 'fps 30', (r) => (r.fps = 30));
  prog('bad_kind', 'kind 3', (r) => (r.kind = 3));
  prog('participants_1', 'P = 1 (< 2)', (r) => {
    r.participants = [CREATOR];
    r.stakes = [5_000_000];
    r.side_b_mask = 0;
  });
  prog('participants_9', 'P = 9 (> MAX_PARTICIPANTS)', (r) => {
    r.participants = Array.from({ length: 9 }, (_, i) => [CREATOR, FRIEND, THIRD][i % 3]!);
    r.stakes = new Array(9).fill(5_000_000);
  });
  prog('side_b_mask_bit0', 'side_b_mask with bit 0 (creator) set', (r) => (r.side_b_mask = 0b11));
  prog('side_b_mask_zero', 'side_b_mask = 0 (side 1 empty)', (r) => (r.side_b_mask = 0));
  prog('side_b_mask_bit_ge_p', 'side_b_mask bit 2 with P = 2', (r) => (r.side_b_mask = 0b110));
  prog('stake_below_min', 'stakes 9_999 (< MIN_STAKE_UNITS)', (r) => (r.stakes = [9_999, 9_999]));
  prog('stake_above_max', 'stakes 10^12 + 1 (> MAX_STAKE_UNITS)', (r) => (r.stakes = [1_000_000_000_001, 1_000_000_000_001]));
  prog('stakes_unequal', 'rules program with unequal stakes', (r) => (r.stakes = [5_000_000, 6_000_000]));
  prog('time_limit_0', 'time_limit_s 0', (r) => (r.time_limit_s = 0));
  prog('time_limit_3601', 'time_limit_s 3601 (> TIME_LIMIT_MAX_S for rules)', (r) => (r.time_limit_s = 3601));

  // --- entities
  prog('entity_kind_5', 'entity kind 5', (r) => (r.entities[1] = [5, 0]));
  prog('entities_17', 'E = 17 (> MAX_ENTITIES)', (r) => {
    while (r.entities.length < 17) r.entities.push([2, 0]);
  });
  prog('entity_param_nonzero', 'object entity with param 1 (unused field ≠ 0)', (r) => (r.entities[1] = [2, 1]));
  prog('person_param_ge_p', 'person entity bound to participant 2 with P = 2', (r) => (r.entities[0] = [0, 2]));
  prog('duplicate_person', 'two person entities bound to the same participant', (r) => r.entities.push([0, 1]));

  // --- legs
  prog('legs_0', 'rules program with L = 0', (r) => (r.legs = []));
  prog('legs_9', 'L = 9 (> MAX_LEGS)', (r) => {
    r.legs = Array.from({ length: 9 }, (_, i) => plainLeg(i + 1));
  });
  prog('leg_ids_duplicate', 'two legs with id 1', (r) => (r.legs = [plainLeg(1), plainLeg(1)]));
  prog('leg_ids_unordered', 'leg ids 2, 1 (not ascending)', (r) => (r.legs = [plainLeg(2), plainLeg(1)]));
  prog('leg_id_0', 'leg id 0', (r) => {
    r.legs = [plainLeg(0)];
    r.cond = LEG(0);
  });
  prog('leg_flags_reserved', 'leg flags bit 2 set', (r) => (leg0(r).flags = 0b111));
  prog('actor_bound_mismatch', 'leg references a person entity but flags bit0 = 0', (r) => (leg0(r).flags = 0b10));
  prog('actor_bound_without_person', 'flags bit0 = 1 on a leg without person references', (r) => (r.legs = [{ ...plainLeg(1), flags: 1 }]));
  prog('has_va_mismatch', 'flags bit1 = 0 with va_len > 0', (r) => (leg0(r).flags = 0b01));
  prog('rule_kind_6', 'rule_kind 6', (r) => (leg0(r).rule_kind = 6));
  prog('rule_kind_market_in_rules', 'rule_kind 5 (market) in a rules program', (r) => {
    r.legs = [{ ...plainLeg(1), rule_kind: 5, attempt_window: 0, succ: new Array(32).fill(7) }];
  });
  prog('count_cmp_6', 'count cmp 6', (r) => (leg0(r).rule_cmp = 6));
  prog('count_k_1001', 'count k 1001 (> REPS_MAX)', (r) => (r.legs = [{ ...plainLeg(1), rule_kind: 1, rule_k: 1001 }]));
  prog('count_attempts_21', 'count within attempts 21 (> ATTEMPTS_MAX)', (r) => {
    r.legs = [{ ...plainLeg(1), flags: 0b10, rule_kind: 1, rule_k: 1, rule_n: 21, va: leaf(PRESENT, 2) }];
  });
  prog('actor_attempts_9', 'actor-bound count within attempts 9 (> 8)', (r) => (leg0(r).rule_n = 9));
  prog('count_attempts_without_va', 'count within attempts 3 without valid_attempt', (r) => (r.legs = [{ ...plainLeg(1), rule_kind: 1, rule_k: 1, rule_n: 3 }]));
  prog('va_without_attempts', 'valid_attempt with count and rule_n = 0', (r) => (leg0(r).rule_n = 0));
  prog('va_on_exists', 'valid_attempt on an exists leg', (r) => {
    r.legs = [{ ...plainLeg(1), flags: 0b10, va: leaf(PRESENT, 2) }];
  });
  prog('exists_unused_fields', 'exists leg with rule_k = 1 (unused field ≠ 0)', (r) => (r.legs = [{ ...plainLeg(1), rule_k: 1 }]));
  prog('holds_frames_0', 'holds with rule_n 0', (r) => (r.legs = [{ ...plainLeg(1), rule_kind: 2 }]));
  prog('holds_frames_over_limit', 'holds 1801 frames with time_limit_s 180', (r) => (r.legs = [{ ...plainLeg(1), rule_kind: 2, rule_n: 1801 }]));
  prog('before_cmp_nonzero', 'before with rule_cmp 1 (unused field ≠ 0)', (r) => (r.legs = [{ ...plainLeg(1), rule_kind: 4, rule_cmp: 1, rule_n: 100 }]));
  prog('attempt_window_0', 'rules leg with attempt_window 0', (r) => (leg0(r).attempt_window = 0));
  prog('negative_actor_never', 'actor-bound never (NEGATIVE_ACTOR_RULE)', (r) => {
    r.legs = [{ ...plainLeg(1), flags: 1, rule_kind: 3, succ: leaf(STANDING, 0) }];
  });
  prog('negative_actor_count_lt', 'actor-bound count < 3 (NEGATIVE_ACTOR_RULE)', (r) => {
    r.legs = [{ ...plainLeg(1), flags: 1, rule_kind: 1, rule_cmp: 3, rule_k: 3, succ: leaf(STANDING, 0) }];
  });
  prog('negative_actor_count_ge_0', 'actor-bound count >= 0 (NEGATIVE_ACTOR_RULE)', (r) => {
    r.legs = [{ ...plainLeg(1), flags: 1, rule_kind: 1, rule_cmp: 0, rule_k: 0, succ: leaf(STANDING, 0) }];
  });
  prog('va_len_overrun', 'va_len larger than the remaining bytes', (r) => (leg0(r).va_len = 4000));

  // --- expression code
  const succ = (name: string, description: string, code: number[], error = MP) =>
    prog(`expr_${name}`, description, (r) => (r.legs = [plainLeg(1, code)]), error);
  succ('unknown_leaf_code', 'leaf code 0x17', leaf(0x17, 1, 2));
  succ('unknown_op_code', 'op code 0x07', [0x07, ...leaf(PRESENT, 1)]);
  succ('leg_op_in_leg_expr', '0x50 (leg) inside a leg expression', AND(leaf(PRESENT, 1), LEG(1)));
  succ('yes_in_leg_expr', '0x51 (yes) inside a leg expression', YES);
  succ('ref_out_of_range', 'ref entity 4 with E = 4', leaf(PRESENT, 4));
  succ('ref_bits_6_7', 'ref byte with bits 6–7 set', leaf(PRESENT, 0x41));
  succ('subregion_on_a', 'a operand with a sub-region (0x12)', leaf(INSIDE, refByte(2, 1), 1));
  succ('subregion_on_line', 'b = line region with .opening', leaf(INSIDE, 1, refByte(3, 1)));
  succ('subregion_on_person', 'b = person with .interior', leaf(INSIDE, 1, refByte(0, 2)));
  succ('subregion_code_3', 'sub-region code 3', leaf(INSIDE, 1, refByte(2, 3)));
  succ('a_is_region', 'present(a = line region)', leaf(PRESENT, 3));
  succ('behind_b_object', 'behind with b = object', leaf(BEHIND, 1, 2));
  succ('inside_b_line', 'inside with b = line region', leaf(INSIDE, 1, 3));
  succ('enters_b_line', 'enters with b = line region', leaf(ENTERS, 1, 3));
  succ('disappears_into_b_object', 'disappears_into with b = plain object (must be .opening or zone)', leaf(DISAPPEARS, 1, 2));
  succ('disappears_into_b_interior', 'disappears_into with b = .interior', leaf(DISAPPEARS, 1, refByte(2, 2)));
  succ('released_by_b_object', 'released_by with b = object', leaf(RELEASED_BY, 1, 2));
  succ('standing_a_object', 'standing with a = object', leaf(STANDING, 1));
  succ('rep_count_a_object', 'rep_count with a = object', leaf(REP_COUNT, 1, 0, 5));
  succ('overlaps_p_nonzero', 'overlaps with p = 1 (unused field ≠ 0)', leaf(OVERLAPS, 1, 2, 1));
  succ('moving_b_nonzero', 'moving with b = 1 (unused field ≠ 0)', leaf(MOVING, 1, 1));
  succ('near_14144', 'near distance 14144 (> NEAR_MAX)', leaf(NEAR, 1, 2, 14144));
  succ('near_negative', 'near distance -1', leaf(NEAR, 1, 2, -1));
  succ('at_rest_0', 'at_rest 0 frames', leaf(AT_REST, 1, 0, 0));
  succ('at_rest_36001', 'at_rest 36001 frames', leaf(AT_REST, 1, 0, 36001));
  succ('speed_cmp_6', 'speed CMP code 6', leaf(SPEED, 1, 6, 100));
  succ('speed_100001', 'speed value 100001 (> SPEED_MAX)', leaf(SPEED, 1, 0, 100001));
  succ('direction_4', 'direction code 4', leaf(DIRECTION, 1, 4));
  succ('rep_count_1001', 'rep_count value 1001 (> REPS_MAX)', leaf(REP_COUNT, 0, 0, 1001));
  succ('then_within_0', 'then_within 0 frames', THEN(0, leaf(PRESENT, 1), leaf(PRESENT, 2)));
  succ('for_duration_36001', 'for_duration 36001 frames', FOR(36001, leaf(PRESENT, 1)));
  succ('before_0', 'before 0 frames', BEFORE(0, leaf(PRESENT, 1)));
  succ('before_36001', 'before 36001 frames', BEFORE(36001, leaf(PRESENT, 1)));
  succ('depth_13', 'expression depth 13 (> MAX_EXPR_DEPTH)', nested(13, leaf(PRESENT, 1)));
  succ('nodes_65', 'expression with 65 nodes (> MAX_EXPR_NODES), depth 7', balanced(33, () => leaf(PRESENT, 1)));
  succ('truncated_leaf', 'succ_len cuts a leaf short', leaf(PRESENT, 1).slice(0, 5));
  prog('expr_trailing_in_code', 'success code with a trailing byte after a complete expression', (r) => (r.legs = [plainLeg(1, [...leaf(PRESENT, 1), 0x24])]));

  // --- condition
  const cond = (name: string, description: string, c: number[]) => prog(`cond_${name}`, description, (r) => (r.cond = c));
  cond('leg_missing', 'condition names leg 2, which does not exist', LEG(2));
  cond('leaf_code', 'leaf code inside the condition', leaf(PRESENT, 1));
  cond('then_within', 'then_within (0x04) inside the condition', THEN(5, LEG(1), LEG(1)));
  cond('yes_in_rules', 'condition 0x51 in a rules program', YES);
  cond('nodes_33', 'condition with 33 nodes (> MAX_COND_NODES)', balanced(17, () => LEG(1), OR));
  cond('depth_13', 'condition depth 13', nested(13, LEG(1)));
  cond('empty', 'cond_len 0', []);
  prog('if_true_eq_else', 'outcome if_true == else', (r) => (r.else = 1));
  prog('if_true_2', 'outcome if_true = 2', (r) => (r.if_true = 2));
  prog('cond_len_overrun', 'cond_len larger than the remaining bytes', (r) => (r.cond_len = 3));
  prog('trailing_bytes', 'one byte after the condition code', (r) => (r.trailing = [0]));
  progBin('truncated_header', 'program_bin cut inside the header (43 bytes)', goodProgram.slice(0, 43));
  progBin('empty', 'empty program_bin', new Uint8Array(0));

  // --- ai_judged / market programs
  const aiBase = (): RawProgram => ({ ...base(), kind: 1, entities: [], legs: [], cond: [...YES], time_limit_s: 120, stakes: [3_000_000, 3_000_000], if_true: 1, else: 0 });
  const ai = (name: string, description: string, mod: (r: RawProgram) => void, cal: Uint8Array = new Uint8Array(0), tracks: Uint8Array = Uint8Array.from([0x56, 0x54, 0x52, 0x4b, 1, 10, 0, 0, 2, 0, 0, 0, ...new Array(32).fill(0)]), error = MP) => {
    const r = aiBase();
    mod(r);
    out.push(errorVector(`reject_ai_judged_${name}`, description, { program_bin: rawProgram(r), calibration_bin: cal, track_bin: tracks }, error, [`decoder_rejection ${error === MP ? 'program_bin' : error === MC ? 'calibration_bin' : 'track_bin'}`]));
  };
  ai('with_leg', 'ai_judged program with L = 1', (r) => (r.legs = [plainLeg(1)]));
  ai('cond_not_yes', 'ai_judged condition not(yes)', (r) => (r.cond = NOT(YES)));
  ai('cond_leg', 'ai_judged condition leg 1', (r) => (r.cond = LEG(1)));
  ai('calibration_nonempty', 'ai_judged with a non-empty calibration_bin', () => {}, rawCalibration({ scene_hash: '00'.repeat(32), regions: [] }), undefined, MC);
  ai(
    'tracks_with_track',
    'ai_judged track_bin with T = 1 (the program references no entity)',
    () => {},
    new Uint8Array(0),
    Uint8Array.from([0x56, 0x54, 0x52, 0x4b, 1, 10, 1, 0, 2, 0, 0, 0, ...new Array(32).fill(0), 0, 0xff, 0, 0]),
    MT,
  );
  ai(
    'tracks_bit3_with_segment',
    'ai_judged track_bin with flags bit3 and S = 1',
    () => {},
    new Uint8Array(0),
    Uint8Array.from([0x56, 0x54, 0x52, 0x4b, 1, 10, 0, 1, 0x0a, 0, 0, 0, ...new Array(32).fill(0), 0, 0, 0, 0, 1, 0, 0, 0]),
    MT,
  );

  const H1 = marketHash('E1', 'C1');
  const marketLeg = (id: number, hash = H1, k = 1): RawLeg => ({
    id,
    flags: 0,
    rule_kind: 5,
    rule_cmp: 0,
    rule_k: k,
    rule_n: 0,
    attempt_window: 0,
    va: [],
    succ: Array.from(Buffer.from(hash, 'hex')),
  });
  const mkBase = (): RawProgram => ({
    ...base(),
    kind: 2,
    entities: [],
    legs: [marketLeg(1)],
    cond: LEG(1),
    if_true: 0,
    else: 1,
    stakes: [3_000_000, 7_000_000],
    time_limit_s: 100_000,
  });
  const goodMarket = rawMarket([{ hash: H1, result: 1 }]);
  const mk = (name: string, description: string, mod: (r: RawProgram) => void, cal: Uint8Array = new Uint8Array(0), mbin: Uint8Array = goodMarket, error = MP) => {
    const r = mkBase();
    mod(r);
    out.push(
      errorVector(`reject_market_${name}`, description, { program_bin: rawProgram(r), calibration_bin: cal, market_bin: mbin }, error, [
        `decoder_rejection ${error === MP ? 'program_bin' : error === MC ? 'calibration_bin' : 'market_bin'}`,
      ]),
    );
  };
  mk('leg_succ_31', 'market leg with succ_len 31', (r) => (r.legs[0]!.succ = r.legs[0]!.succ.slice(0, 31)));
  mk('leg_k_2', 'market leg with expected result 2', (r) => (r.legs[0]!.rule_k = 2));
  mk('leg_window_nonzero', 'market leg with attempt_window 50', (r) => (r.legs[0]!.attempt_window = 50));
  mk('leg_flags', 'market leg with flags 1', (r) => (r.legs[0]!.flags = 1));
  mk('rules_leg', 'a rules leg (exists) in a market program', (r) => (r.legs = [{ ...plainLeg(1), succ: leaf(PRESENT, 0) }]));
  mk('time_limit_2592001', 'market time_limit_s 2592001 (> MARKET_TIME_LIMIT_MAX_S)', (r) => (r.time_limit_s = 2_592_001));
  mk('calibration_nonempty', 'market program with a non-empty calibration_bin', () => {}, rawCalibration({ scene_hash: '00'.repeat(32), regions: [] }), goodMarket, MC);
  mk('bin_duplicate_hash', 'market_bin with a duplicate market_hash', () => {}, undefined, rawMarket([{ hash: H1, result: 1 }, { hash: H1, result: 0 }]), MT);
  mk('bin_result_3', 'market_bin result 3', () => {}, undefined, rawMarket([{ hash: H1, result: 3 }]), MT);
  mk('bin_trailing', 'market_bin with a trailing byte', () => {}, undefined, rawMarket([{ hash: H1, result: 1 }], { trailing: [0] }), MT);
  mk('bin_bad_magic', 'market_bin magic "VMKX"', () => {}, undefined, rawMarket([{ hash: H1, result: 1 }], { magic: 'VMKX' }), MT);
  mk('bin_bad_version', 'market_bin version 2', () => {}, undefined, rawMarket([{ hash: H1, result: 1 }], { version: 2 }), MT);
  mk('bin_reserved', 'market_bin reserved ≠ 0', () => {}, undefined, rawMarket([{ hash: H1, result: 1 }], { reserved: 1 }), MT);
  mk('bin_truncated', 'market_bin n = 2 with one entry', () => {}, undefined, rawMarket([{ hash: H1, result: 1 }], { n: 2 }), MT);
  mk('bin_is_vtrk', 'a VTRK track_bin in place of the market_bin', () => {}, undefined, goodTracks, MT);

  // --- calibration_bin (§5.3)
  const sh = sceneHash(PAPER_BALL_CALIBRATION);
  const LINE = { entity_idx: 3, shape: 0, points: [[3000, 6000], [3000, 10000]] as [number, number][], behind_sign: 1 };
  const goodCalRaw = rawCalibration({ scene_hash: sh, regions: [LINE] });
  if (Buffer.compare(Buffer.from(goodCalRaw), Buffer.from(goodCal)) !== 0) throw new Error('rawCalibration(base) ≠ encodeCalibration(§15.1)');
  const cal = (name: string, description: string, bin: Uint8Array, programBin = goodProgram) =>
    out.push(errorVector(`reject_calibration_${name}`, description, { program_bin: programBin, calibration_bin: bin, track_bin: goodTracks }, MC, ['decoder_rejection calibration_bin']));
  const calR = (regions: typeof LINE[], o: Parameters<typeof rawCalibration>[0] extends infer T ? Partial<T> : never = {}) => rawCalibration({ scene_hash: sh, regions, ...o });
  cal('bad_magic', 'magic "VCAX"', calR([LINE], { magic: 'VCAX' }));
  cal('bad_version', 'version 2', calR([LINE], { version: 2 }));
  cal('reserved', 'reserved ≠ 0', calR([LINE], { reserved: 1 }));
  cal('empty_for_rules', 'empty calibration_bin for a rules program', new Uint8Array(0));
  cal('missing_region', 'R = 0 while the program has a line region', calR([]));
  cal('duplicate_region', 'the line region twice', calR([LINE, LINE]));
  cal('region_for_object', 'a region for entity 2 (object)', calR([{ ...LINE, entity_idx: 2 }, LINE]));
  cal('shape_mismatch', 'zone shape for a line entity', calR([{ entity_idx: 3, shape: 1, points: [[0, 0], [100, 0], [0, 100]], behind_sign: 0 }]));
  cal('shape_2', 'shape code 2', calR([{ ...LINE, shape: 2 }]));
  cal('coord_10001', 'x = 10001', calR([{ ...LINE, points: [[10001, 6000], [3000, 10000]] }]));
  cal('degenerate_line', 'line with a == b', calR([{ ...LINE, points: [[3000, 6000], [3000, 6000]] }]));
  cal('line_3_points', 'line with 3 points', calR([{ ...LINE, points: [[3000, 6000], [3000, 10000], [0, 0]] }]));
  cal('behind_sign_0', 'line behind_sign 0', calR([{ ...LINE, behind_sign: 0 }]));
  cal('behind_sign_2', 'line behind_sign 2', calR([{ ...LINE, behind_sign: 2 }]));
  cal('trailing_bytes', 'one byte after the last region', calR([LINE], { trailing: [0] }));
  cal('truncated', 'n_points 2 with one point present', calR([LINE]).slice(0, 48));
  // zone program: replace the line entity by a zone (and use enters instead of behind)
  const zr = base();
  zr.entities[3] = [4, 0];
  zr.legs[0]!.va = AND(leaf(RELEASED_BY, 1, 0), leaf(INSIDE, 0, 3));
  const zoneProgram = rawProgram(zr);
  const ZONE = { entity_idx: 3, shape: 1, points: [[0, 0], [5000, 0], [5000, 5000]] as [number, number][], behind_sign: 0 };
  {
    // sanity: the zone base is valid
    const ok = errorVectorOk(zoneProgram, calR([ZONE]), goodTracks);
    if (!ok) throw new Error('zone base program does not decode');
  }
  cal('zone_2_points', 'zone with 2 vertices', calR([{ ...ZONE, points: [[0, 0], [5000, 0]] }]), zoneProgram);
  cal('zone_9_points', 'zone with 9 vertices', calR([{ ...ZONE, points: Array.from({ length: 9 }, (_, i) => [i * 1000, (i % 2) * 1000] as [number, number]) }]), zoneProgram);
  cal('zone_behind_sign', 'zone with behind_sign 1', calR([{ ...ZONE, behind_sign: 1 }]), zoneProgram);
  cal('zone_coord_10001', 'zone with y = 10001', calR([{ ...ZONE, points: [[0, 0], [5000, 10001], [5000, 5000]] }]), zoneProgram);
  // two regions out of order
  const tr = base();
  tr.entities.push([4, 0]);
  const twoRegionProgram = rawProgram(tr);
  const Z4 = { ...ZONE, entity_idx: 4 };
  if (!errorVectorOk(twoRegionProgram, calR([LINE, Z4]), goodTracks)) throw new Error('two-region base does not decode');
  cal('regions_unsorted', 'regions for entities 4, 3 (not ascending)', calR([Z4, LINE]), twoRegionProgram);

  // --- track_bin (§5.4); goodTracks: T = 3, S = 1 (frames [0,5)), records at 64
  const T0 = 44;
  const SEG0 = 44 + 12;
  const REC0 = SEG0 + 8;
  const trk = (name: string, description: string, bin: Uint8Array) =>
    out.push(errorVector(`reject_tracks_${name}`, description, { program_bin: goodProgram, calibration_bin: goodCal, track_bin: bin }, MT, ['decoder_rejection track_bin']));
  const tp = (name: string, description: string, patch: (b: Uint8Array) => void) => trk(name, description, patched(goodTracks, patch));
  const rec0 = (t: number, frame = 0) => REC0 + 12 * (frame * 3 + t);
  tp('bad_magic', 'magic "VTRX"', (b) => (b[3] = 0x58));
  tp('bad_version', 'version 2', (b) => (b[4] = 2));
  tp('bad_fps', 'fps 30', (b) => (b[5] = 30));
  tp('flags_bit5', 'flags bit 5 set', (b) => (b[8] = 0x22));
  tp('reserved_header', 'header reserved byte ≠ 0', (b) => (b[10] = 1));
  tp('table_entity_mismatch', 'track 1 names entity 2 (must be the 2nd referenced entity, 1)', (b) => (b[T0 + 4] = 2));
  tp('table_participant_mismatch', 'person track with participant_idx 0 (program says 1)', (b) => (b[T0 + 1] = 0));
  tp('table_object_participant', 'object track with participant_idx 0 (must be 0xFF)', (b) => (b[T0 + 5] = 0));
  tp('segment_reserved', 'segment reserved ≠ 0', (b) => (b[SEG0 + 6] = 1));
  tp('id_conf_on_object', 'id_conf 50 on an object record', (b) => (b[rec0(1) + 10] = 50));
  tp('pose_on_object', 'pose 1 on an object record', (b) => (b[rec0(2) + 11] = 1));
  tp('pose_low_and_high', 'pose with rep_low and rep_high both set', (b) => (b[rec0(0) + 11] = 0b111));
  tp('pose_bit3', 'pose bit 3 set', (b) => (b[rec0(0) + 11] = 0b1001));
  tp('conf_101', 'conf 101', (b) => (b[rec0(1) + 8] = 101));
  tp('fill_101', 'fill 101', (b) => (b[rec0(1) + 9] = 101));
  tp('id_conf_101', 'id_conf 101 on the person track', (b) => (b[rec0(0) + 10] = 101));
  tp('x0_gt_x1', 'x0 > x1', (b) => writeU16(b, rec0(1), 2200));
  tp('y1_10001', 'y1 = 10001', (b) => writeU16(b, rec0(2) + 6, 10001));
  tp('absent_nonzero', 'conf 0 with non-zero coordinates', (b) => (b[rec0(1) + 8] = 0));
  tp('frame_beyond_limit', 'segment starting at LIMIT + TAIL_FRAMES - 4 = 1816 with 5 frames', (b) => writeU32(b, SEG0, 1816));
  tp('n_frames_0', 'segment with n_frames 0', (b) => writeU16(b, SEG0 + 4, 0));
  tp('s0_without_bit3', 'S = 0 with flags bit3 clear', (b) => (b[7] = 0));
  tp('s1_with_bit3', 'S = 1 with flags bit3 set', (b) => (b[8] = 0x0a));
  trk('t_mismatch', 'T = 2 (the program references 3 entities)', withTracks(goodBuf, (d) => d.tracks.splice(2, 1)));
  trk('record_short', 'record section one byte short', goodTracks.slice(0, goodTracks.length - 1));
  trk('record_long', 'record section one byte long', Uint8Array.from([...goodTracks, 0]));
  trk('empty', 'empty track_bin for a rules program', new Uint8Array(0));
  trk('segments_overlap', 'segment 2 starts inside segment 1', segmented([[0, 5], [4, 5]]));
  trk('segments_unordered', 'segments [10,15) then [0,5)', segmented([[10, 5], [0, 5]]));
  trk('segments_17', 'S = 17 (> MAX_SEGMENTS)', segmented(Array.from({ length: 17 }, (_, i) => [i * 2, 1] as [number, number])));
  trk('frames_1025', 'Σ n_frames = 1025 (> MAX_EVAL_FRAMES)', segmented([[0, 1000], [1000, 25]]));

  // --- decode order: program → calibration → tracks, first error wins
  out.push(
    errorVector('reject_order_program_first', 'bad program and bad calibration ⇒ MalformedProgram', { program_bin: patched(goodProgram, (b) => (b[4] = 3)), calibration_bin: calR([], { magic: 'VCAX' }), track_bin: new Uint8Array(0) }, MP, ['decoder_rejection order']),
    errorVector('reject_order_calibration_second', 'bad calibration and bad tracks ⇒ MalformedCalibration', { program_bin: goodProgram, calibration_bin: calR([], { magic: 'VCAX' }), track_bin: new Uint8Array(0) }, MC, ['decoder_rejection order']),
  );
  return out;

  function segmented(segs: [number, number][]): Uint8Array {
    // Build sorted, then rewrite the segment table to the requested (possibly invalid) layout.
    const total = segs.reduce((s, [, n]) => s + n, 0);
    const w = new W().ascii('VTRK').u8(1).u8(10).u8(3).u8(segs.length).u8(2).u8(0).u8(0).u8(0).bytes(Buffer.from(goodBuf.model_hash, 'hex'));
    for (const t of goodBuf.tracks) w.u8(t.entity_idx).u8(t.participant_idx ?? 0xff).u16(t.ref_h);
    for (const [start, n] of segs) w.u32(start).u16(n).u16(0);
    const frame = goodTracks.slice(REC0, REC0 + 36);
    for (let i = 0; i < total; i++) w.bytes(frame);
    return w.done();
  }
}

function withTracks(b: ReturnType<typeof buffer>, mod: (d: ReturnType<typeof buffer>) => void): Uint8Array {
  const d = structuredClone(b);
  mod(d);
  for (const s of d.segments) s.frames = s.frames.map((fr) => fr.slice(0, d.tracks.length));
  // encodeTrackBin is program-agnostic: it writes whatever table it is given.
  return encodeTrackBin(d);
}

function errorVectorOk(program_bin: Uint8Array, calibration_bin: Uint8Array, track_bin: Uint8Array): boolean {
  try {
    errorVector('probe', '', { program_bin, calibration_bin, track_bin }, 'ok');
    return true;
  } catch {
    return false;
  }
}
