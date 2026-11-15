/**
 * Verdict engine shared types.
 *
 * Source of truth: docs/CONTRACTS.md (§ references point there). Everything in
 * this file is type-only (no runtime code), so modules can import it with
 * `import type`.
 *
 * Representation conventions used across engine modules (§0.2):
 * - `Pubkey`  : base58 string.
 * - `Hex32`   : 32-byte digest as lowercase hex, 64 chars, no `0x`.
 * - `Base64`  : standard base64 with padding.
 * - Integers that are u32 or smaller, frame indices, bps, percentages and
 *   USDC stake amounts (bounded by MAX_STAKE_UNITS = 10^12 < 2^53) are `number`.
 * - Onchain `u64`/`i64` account, instruction and event fields are `bigint`
 *   (see the chain section below).
 */

import type {
  CMPS,
  LEAF_CODE,
  DIRS,
  ERROR_CODES,
  EVENT_NAMES,
  INSTRUCTION_NAMES,
  LEG_CAUSES,
  MOCK_SCENARIOS,
  REL2_OPS,
  UNARY_OPS,
} from './constants.js';

// ===========================================================================
// Primitive aliases (§0.2)
// ===========================================================================

/** Solana public key, base58. */
export type Pubkey = string;
/** 32-byte hash, lowercase hex (64 chars, no 0x). */
export type Hex32 = string;
/** Arbitrary bytes, lowercase hex. */
export type Hex = string;
/** Standard base64 with padding. */
export type Base64 = string;
/** Integer basis points 0..10000. */
export type Bps = number;

/** Any JSON value accepted by `canonicalJson` (§4.1): integers only, no null. */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue | undefined };

// ===========================================================================
// §2.6 AST (normative; JSON form is identical)
// ===========================================================================

export type Cmp = (typeof CMPS)[number]; // ">=" | ">" | "<=" | "<" | "==" | "!="
export type Dir = (typeof DIRS)[number]; // "up" | "down" | "left" | "right"
export type SubRegion = 'opening' | 'interior';

/** Entity name, optionally with a sub-region suffix; `sub` only on `b` operands. */
export interface Ref {
  e: string;
  sub?: SubRegion;
}

export type ProgramKind = 'rules' | 'ai_judged' | 'market';
export type EntityKind = 'person' | 'person_any' | 'object' | 'region';
export type RegionShape = 'line' | 'zone';

export interface PersonEntity {
  name: string;
  kind: 'person';
  /** Index into `participants`. */
  participant: number;
}
export interface PersonAnyEntity {
  name: string;
  kind: 'person_any';
}
export interface ObjectEntity {
  name: string;
  kind: 'object';
  /** Normalized phrase (§2.2). */
  phrase: string;
}
export interface RegionEntity {
  name: string;
  kind: 'region';
  /** "tap" never appears in the canonical AST. */
  shape: RegionShape;
}
export type Entity = PersonEntity | PersonAnyEntity | ObjectEntity | RegionEntity;

export type Rel2 = (typeof REL2_OPS)[number];
export type UnaryOp = (typeof UNARY_OPS)[number]; // moving | present | intact | standing

export interface AndExpr {
  op: 'and';
  args: [Expr, Expr];
}
export interface OrExpr {
  op: 'or';
  args: [Expr, Expr];
}
export interface NotExpr {
  op: 'not';
  arg: Expr;
}
/** frames 1..=36000 */
export interface ThenWithinExpr {
  op: 'then_within';
  frames: number;
  first: Expr;
  then: Expr;
}
/** frames 1..=36000 */
export interface ForDurationExpr {
  op: 'for_duration';
  frames: number;
  arg: Expr;
}
/** frames 1..=36000 (absolute frame bound) */
export interface BeforeExpr {
  op: 'before';
  frames: number;
  arg: Expr;
}
export interface Rel2Expr {
  op: Rel2;
  a: Ref;
  b: Ref;
}
/** dist 0..=14143 */
export interface NearExpr {
  op: 'near';
  a: Ref;
  b: Ref;
  dist: number;
}
export interface UnaryExpr {
  op: UnaryOp;
  a: Ref;
}
/** frames 1..=36000 */
export interface AtRestExpr {
  op: 'at_rest';
  a: Ref;
  frames: number;
}
/** value 0..=100000 */
export interface SpeedExpr {
  op: 'speed';
  a: Ref;
  cmp: Cmp;
  value: number;
}
export interface DirectionExpr {
  op: 'direction';
  a: Ref;
  dir: Dir;
}
/** value 0..=1000 */
export interface RepCountExpr {
  op: 'rep_count';
  a: Ref;
  cmp: Cmp;
  value: number;
}

export type CombinatorExpr = AndExpr | OrExpr | NotExpr | ThenWithinExpr | ForDurationExpr | BeforeExpr;
export type LeafExpr =
  | Rel2Expr
  | NearExpr
  | UnaryExpr
  | AtRestExpr
  | SpeedExpr
  | DirectionExpr
  | RepCountExpr;
export type Expr = CombinatorExpr | LeafExpr;

export type CombinatorOp = CombinatorExpr['op'];
export type LeafOp = LeafExpr['op'];
export type ExprOp = Expr['op'];

export interface ExistsRule {
  kind: 'exists';
}
export interface NeverRule {
  kind: 'never';
}
/** attempts 0 = no valid_attempt */
export interface CountRule {
  kind: 'count';
  cmp: Cmp;
  k: number;
  attempts: number;
}
export interface HoldsRule {
  kind: 'holds';
  frames: number;
}
export interface BeforeRule {
  kind: 'before';
  frames: number;
}
export type Rule = ExistsRule | NeverRule | CountRule | HoldsRule | BeforeRule;
export type RuleKind = Rule['kind'];

export type MarketSide = 'yes' | 'no';
export interface MarketRef {
  venue: 'gemini';
  event_id: string;
  contract_id: string;
  side: MarketSide;
  /** Quote-time probability, 0..=10000. */
  prob_bps: number;
}

export interface Leg {
  /** 1..8 */
  id: number;
  /** market: always false */
  actor_bound: boolean;
  /** rules legs: always present (default 50, 1..=36000); market legs: 0 */
  attempt_window_frames: number;
  valid_attempt?: Expr;
  /** required for kind "rules" */
  success?: Expr;
  /** required for kind "rules" */
  rule?: Rule;
  /** required for kind "market" */
  market?: MarketRef;
}

export interface LegRefExpr {
  op: 'leg';
  id: number;
}
export interface LegAndOrExpr {
  op: 'and' | 'or';
  args: [LegExpr, LegExpr];
}
export interface LegNotExpr {
  op: 'not';
  arg: LegExpr;
}
export type LegExpr = LegRefExpr | LegAndOrExpr | LegNotExpr;
export interface YesCondition {
  op: 'yes';
}

export type Side = 0 | 1;

export interface Outcome {
  /** side that wins if condition is True */
  if_true: Side;
  /** { op: "yes" } only for ai_judged */
  condition: LegExpr | YesCondition;
  /** MUST differ from if_true */
  else: Side;
}

export interface Program {
  version: 2;
  kind: ProgramKind;
  /** 2..8, index 0 = creator */
  participants: Pubkey[];
  /** aligned; sides[0] = 0 */
  sides: Side[];
  /** [] allowed for ai_judged/market */
  entities: Entity[];
  /** [] for ai_judged */
  legs: Leg[];
  /** ai_judged only */
  question?: string;
  outcome: Outcome;
  /** rules, ai_judged: 10_000..=1_000_000_000_000 */
  stake_each?: number;
  /** market only, aligned with participants, each 10_000..=1_000_000_000_000 */
  stakes?: number[];
  /** 1..=3600 (market: ..=2_592_000) */
  time_limit_s: number;
}

// ===========================================================================
// §2.7 Compile context, errors, validation; §2.8 read-back; §12.10 rows
// ===========================================================================

export interface HuddleMember {
  wallet: Pubkey;
  display_name: string;
  enrolled: boolean;
}

export interface CompileContext {
  creator: Pubkey;
  /** confirmed members, join order, creator first */
  huddle: HuddleMember[];
}

/** Blocking validation codes (§2.7). */
export type CompileErrorCode =
  | 'PARSE_ERROR'
  | 'UNKNOWN_ENTITY'
  | 'BAD_SUBREGION'
  | 'UNKNOWN_PARTICIPANT'
  | 'PARTICIPANTS_UNRESOLVED'
  | 'NOT_ENROLLED'
  | 'DUPLICATE_PERSON'
  | 'BAD_OPERAND'
  | 'ACTOR_BOUND_MISMATCH'
  | 'UNUSED_PERSON'
  | 'BAD_RULE'
  | 'NEGATIVE_ACTOR_RULE'
  | 'CHECKPOINT_LIMIT'
  | 'BAD_OUTCOME'
  | 'LIMIT'
  | 'BAD_SIDES'
  | 'BAD_STAKE'
  | 'BAD_TIME_LIMIT'
  | 'BAD_KIND';

/** Non-blocking warning codes (§2.7). */
export type CompileWarningCode = 'UNUSED_ENTITY' | 'PULSE_DURATION' | 'UNWINNABLE';

export interface CompileError {
  /** e.g. "legs[0].success" */
  path: string;
  code: CompileErrorCode | CompileWarningCode;
  message: string;
  /** 1-based column inside the expression/rule/outcome string, for PARSE_ERROR */
  col?: number;
}

export type ParseYamlResult =
  | { ok: true; program: Program; warnings: CompileError[] }
  | { ok: false; errors: CompileError[] };

export interface ValidationResult {
  errors: CompileError[];
  warnings: CompileError[];
}

export interface ReadbackContext {
  /** participant wallet → display name */
  names: Record<Pubkey, string>;
  /** entity name → 1–3 word label (objects are lowercased in read-back) */
  labels?: Record<string, string>;
  /** market_hash hex → human label */
  markets?: Record<Hex32, string>;
}

export type ConditionField = 'valid_attempt' | 'success';

/** Scene-check / practice condition row (§12.10). */
export interface ConditionRow {
  leg: number;
  field: ConditionField;
  /** child indices from the root, e.g. "0.1" */
  path: string;
  /** ≤ 3 words */
  label: string;
}

/** `leafSignals` row: a condition row plus its per-frame boolean signal. */
export interface LeafSignalRow extends ConditionRow {
  signal: boolean[];
}

// ===========================================================================
// §5.2 Calibration JSON
// ===========================================================================

/** Normalized point `[x, y]`, each 0..10000 (§0.4). */
export type Point = [number, number];
/** Normalized bbox `[x0, y0, x1, y1]`, each 0..10000. */
export type BBox = [number, number, number, number];

export interface CameraPose {
  pitch_cdeg: number;
  roll_cdeg: number;
}

export interface CalibrationCamera {
  width_px: number;
  height_px: number;
  orientation: 'landscape' | 'portrait';
  /** JPEG of the frame used for placement */
  ref_frame_sha256?: Hex32;
  /** phone IMU, integer centi-degrees */
  pose?: CameraPose;
}

export interface EntityRef {
  entity: string;
  /** 1–3 words, Title case */
  label: string;
  bbox: BBox;
  crop_sha256?: Hex32;
}

export interface CalibrationScene {
  camera: CalibrationCamera;
  entity_refs: EntityRef[];
}

export interface LineRegion {
  entity: string;
  shape: 'line';
  points: [Point, Point];
  behind_sign: 1 | -1;
}
export interface ZoneRegion {
  entity: string;
  shape: 'zone';
  /** 3..8 vertices */
  points: Point[];
}
export type CalibrationRegion = LineRegion | ZoneRegion;

export interface Calibration {
  version: 1;
  scene: CalibrationScene;
  regions: CalibrationRegion[];
}

// ===========================================================================
// §5.1 / §5.3 / §14 Decoded binaries
// ===========================================================================

export type KindCode = 0 | 1 | 2; // rules, ai_judged, market
export type EntityKindCode = 0 | 1 | 2 | 3 | 4; // person, person_any, object, line, zone
export type RuleKindCode = 0 | 1 | 2 | 3 | 4 | 5; // exists, count, holds, never, before, market
export type CmpCode = 0 | 1 | 2 | 3 | 4 | 5;
export type DirCode = 0 | 1 | 2 | 3;
export type SubRegionCode = 0 | 1 | 2; // none, opening, interior
export type ShapeCode = 0 | 1; // line, zone
/** Leaf op byte (§5.1 leaf table). */
export type LeafCode = (typeof LEAF_CODE)[keyof typeof LEAF_CODE];

export interface DecodedEntity {
  kind: EntityKindCode;
  /** participant index for person, else 0 */
  param: number;
}

export interface DecodedLeg {
  id: number;
  /** bit0 actor_bound, bit1 has_valid_attempt */
  flags: number;
  rule_kind: RuleKindCode;
  rule_cmp: CmpCode;
  /** count k; market: expected 1=yes/0=no; 0 otherwise */
  rule_k: number;
  /** count: attempts (0 = none); holds/before: frames; 0 otherwise */
  rule_n: number;
  /** frames; rules legs: canonical value even if unused; market: 0 */
  attempt_window: number;
  /** valid_attempt expression code (empty if none) */
  va: Uint8Array;
  /** success expression code; market legs: the 32-byte market_hash */
  succ: Uint8Array;
}

/** `decodeProgram(bin)` output (§14). */
export interface DecodedProgram {
  kind: KindCode;
  /** participants count, 2..8 */
  P: number;
  json_hash: Hex32;
  time_limit_s: number;
  participants: Pubkey[];
  /** u64 per participant; decoders enforce ≤ MAX_STAKE_UNITS, so `number` is exact */
  stakes: number[];
  side_b_mask: number;
  entities: DecodedEntity[];
  legs: DecodedLeg[];
  if_true: Side;
  else_side: Side;
  /** condition code */
  cond: Uint8Array;
  /**
   * Non-region entities referenced in at least one leg expression (incl. the
   * owning object of a sub-region ref), ascending entity index = the track
   * table order of track_bin (§5.4, [D-43]).
   */
  tracked_entities: number[];
}

/** Decoded Ref byte (§5.1). */
export interface DecodedRef {
  entity: number;
  sub: SubRegionCode;
}

/**
 * Decoded expression node tree (prefix code of §5.1), shared by the decoder
 * (validation) and the evaluator. `code` is the op byte.
 */
export type DecodedExpr =
  | { code: 0x01 | 0x02; left: DecodedExpr; right: DecodedExpr }
  | { code: 0x03; arg: DecodedExpr }
  | { code: 0x04; frames: number; first: DecodedExpr; then: DecodedExpr }
  | { code: 0x05 | 0x06; frames: number; arg: DecodedExpr }
  | {
      /** leaf code 0x10–0x41 (§5.1 leaf table) */
      code: LeafCode;
      a: DecodedRef;
      /** Ref for relational leaves, CMP/DIR code for speed/direction/rep_count, else 0 */
      b: number;
      /** i32 parameter (dist / frames / value), unused = 0 */
      p: number;
    };

/** Decoded outcome condition tree (§5.1: ops 0x01–0x03, 0x50, 0x51). */
export type DecodedCond =
  | { code: 0x01 | 0x02; left: DecodedCond; right: DecodedCond }
  | { code: 0x03; arg: DecodedCond }
  | { code: 0x50; leg_id: number }
  | { code: 0x51 };

export interface DecodedRegion {
  entity_idx: number;
  shape: ShapeCode;
  points: Point[];
  /** line: ±1; zone: 0 */
  behind_sign: -1 | 0 | 1;
}

/** `decodeCalibration(bin, decodedProgram)` output (§14). */
export interface DecodedCalibration {
  scene_hash: Hex32;
  regions: DecodedRegion[];
}

// ===========================================================================
// §5.4 / §5.5 / §5.6 Tracks and market results
// ===========================================================================

/**
 * One quantized frame of one track = the 12-byte record of §5.4.
 * Absent frames are `null` in session/buffer data (encoded as 12 zero bytes).
 */
export interface QFrame {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0..100; 0 ⇒ absent */
  conf: number;
  /** 0..100, advisory */
  fill: number;
  /** 0..100; person tracks only, else 0 */
  id_conf: number;
  /** bit0 standing, bit1 rep_low, bit2 rep_high */
  pose: number;
}

/** Alias: a track_bin record is a QFrame. */
export type TrackRecord = QFrame;

export interface TrackTableEntry {
  entity_idx: number;
  /** null ⇔ 0xFF (non-person track) */
  participant_idx: number | null;
  ref_h: number;
}

export interface TrackSegment {
  /** absolute frame index (u32) */
  frame_start: number;
  /** [frame][track]; n_frames = frames.length (u16, ≥ 1) */
  frames: (QFrame | null)[][];
}

/** Decoded / to-be-encoded track_bin (§14). */
export interface TrackBufferData {
  flags: number;
  model_hash: Hex32;
  tracks: TrackTableEntry[];
  segments: TrackSegment[];
}

export type MarketResultCode = 0 | 1 | 2; // no, yes, void

export interface MarketBinEntry {
  market_hash: Hex32;
  result: MarketResultCode;
}

/** The three parts of a TrackBuffer payload (§5.6). */
export interface PayloadParts {
  program_bin: Uint8Array;
  calibration_bin: Uint8Array;
  /** track_bin or market_bin; absent for SP1-only payloads */
  tracks_bin?: Uint8Array;
}

// ===========================================================================
// §6 Perception
// ===========================================================================

/** §6.1 one line per (frame, track) of perception job output (JSON Lines). */
export interface RawDetection {
  /** since t0, ≥ 0 */
  t_ms: number;
  /** entity name, or "person" for unbound person tracks */
  entity: string;
  /** u16, per job */
  track_id: number;
  /** x0,y0,x1,y1 in source pixels (floats allowed here) */
  bbox_px: [number, number, number, number];
  mask_area_px: number;
  /** 0..1 float */
  confidence: number;
  /** MediaPipe, person tracks only */
  pose?: { standing: boolean; elbow_deg?: number };
  /** appearance embedding (person tracks), optional */
  reid?: number[];
}

export interface QuantizeMeta {
  width_px: number;
  height_px: number;
  n_frames: number;
  model_hash: Hex32;
  flags: number;
  program: Program;
  calibration: Calibration | null;
}

export interface SessionTrack {
  entity: string;
  entity_idx: number;
  participant_idx: number | null;
  /** y1 - y0 at the entity's first present frame in the session (0 if never present) */
  ref_h: number;
  /** length n_frames */
  frames: (QFrame | null)[];
}

export interface SessionTracks {
  fps: 10;
  n_frames: number;
  model_hash: Hex32;
  flags: number;
  /** every non-region entity, entity order (unreferenced ones too; persons only in outcome stay all-null) */
  tracks: SessionTrack[];
}

/** §6.3 */
export interface CrossCheckResult {
  ok: boolean;
  entity_agreement_bps: Record<string, number>;
  event_mismatches: string[];
  phone_agreement_bps?: Record<string, number>;
}

/** `model_hash` preimage (§4.2): hashed with canonicalJson, so integers/strings only. */
export interface ModelSpec {
  image: string;
  weights_sha256: Hex32;
  /** phrases in entity order */
  prompts: string[];
  settings: { [key: string]: CanonicalJsonValue };
}

export type VideoBodyFormat = 'mp4' | 'mjpeg';

/** §6.0 perception job request body (`POST {PERCEPTION_URL}/jobs`). */
export interface PerceptionJobRequest {
  bet: Pubkey;
  job_nonce: string;
  fps: 10;
  offset_ms: number;
  video_urls: { index: number; url: string; sha256: Hex32; start_ms: number; duration_ms: number; body_format: VideoBodyFormat }[];
  prompts: { entity: string; phrase: string }[];
  entity_refs: EntityRef[];
  need_pose: boolean;
  need_reid: boolean;
}

/** §6.0 `GET {PERCEPTION_URL}/jobs/:id` response. */
export interface PerceptionJobStatus {
  status: 'queued' | 'running' | 'done' | 'failed';
  model_hash: Hex32;
  flags: number;
  /** JSON Lines of RawDetection */
  detections_url: string;
  host: { provider: string; job_id: string; url: string; market: string };
}

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** `simulate(p, c, scenario, seed)` output (§14). */
export interface SimulateResult {
  a: SessionTracks;
  b: SessionTracks;
  raw?: RawDetection[];
}

// ===========================================================================
// §3 Evaluation
// ===========================================================================

export type LegValue = 0 | 1 | 2; // False, True, Unknown
export type LegCause = (typeof LEG_CAUSES)[number];
export type EvalStatus = 'ok' | 'needs_panel';
export type EvalReason = 0 | 10 | 11 | 12 | 13;
export type EvalPreruling = 1 | 3;

/** A verified / computed identity checkpoint (participant index, absolute frame). */
export interface Checkpoint {
  participant: number;
  frame: number;
}
/** `verified` input of `evaluate` (onchain: `Bet.bio`). */
export type VerifiedCheckpoint = Checkpoint;

export interface EvalAttempt {
  /** leg index in program order */
  leg: number;
  frame: number;
  success_frame: number | null;
}

/** §3.12 */
export interface EvalResult {
  status: EvalStatus;
  /** 0 when ok */
  reason: EvalReason;
  preruling: EvalPreruling;
  /** u8 */
  winner_mask: number;
  /** per leg in program order; onchain [u8;8] padded with 0xFF */
  leg_results: LegValue[];
  /** per leg; [] when not Unknown or when needs_panel came from §3.1 steps 2–4 */
  leg_causes: LegCause[][];
  /** per leg, list of frames */
  decisive_frames: number[][];
  attempts: EvalAttempt[];
  checkpoints: Checkpoint[];
  n_checkpoints: number;
  cost: number;
}

export interface EvalOptions {
  /** default MAX_EVAL_COST; SP1 guest / full-session evaluation: Infinity */
  maxCost?: number;
}

// ===========================================================================
// §8 Identity
// ===========================================================================

export type Modality = 'face' | 'voice';
export type ModalityCode = 0 | 1; // face, voice

/** Anonymous person track, session-length (§8.5). */
export interface PersonTrack {
  track_id: number;
  frames: (QFrame | null)[];
}

export interface IdObservation {
  frame: number;
  modality: Modality;
  /** null for voice observations not yet attached to a track */
  track_id: number | null;
  /** all M candidates */
  scores: { candidate: number; cos_bps: number }[];
}

export interface ReidLink {
  from_track: number;
  to_track: number;
  sim_bps: number;
}

export interface StitchedFrame {
  track_id: number;
  /** conf_p(t, f), 0..100 */
  conf: number;
}

export interface FusedTimeline {
  n_frames: number;
  n_candidates: number;
  /** [participant][frame] */
  stitched: (StitchedFrame | null)[][];
}

/** A closed-set candidate: its index in the candidate list and enrolled template. */
export interface MatchCandidate {
  candidate: number;
  /** quantized template, i8 values in [-127, 127] */
  template: Int8Array;
}

/** `closedSetMatch` output (§8.3). */
export interface ClosedSetMatch {
  matched: boolean;
  /** best candidate index (ties → lower index), null if no candidates */
  best: number | null;
  cos1: number;
  /** second-best score (0 if only one candidate) */
  cos2: number;
  /** cos_bps per candidate, in candidate-list order */
  scores: { candidate: number; cos_bps: number }[];
}

/** snarkjs `proof.json` shape (decimal strings, projective coordinates). */
export interface SnarkjsProof {
  pi_a: [string, string, string] | string[];
  pi_b: [[string, string], [string, string], [string, string]] | string[][];
  pi_c: [string, string, string] | string[];
  protocol?: string;
  curve?: string;
}

/** groth16-solana encoding (§8.6): a 64 B (y negated), b 128 B, c 64 B, big-endian. */
export interface EncodedGroth16Proof {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
}

/** Inputs for `biometricPublicInputs(...)` (§8.6), in public-signal order. */
export interface BiometricPublicInputArgs {
  /** 32-byte big-endian commitment (Profile face_commit / voice_commit) */
  commitment: Uint8Array;
  bet: Pubkey;
  /** final Bet.evidence_root */
  evidence_root: Uint8Array;
  participant_idx: number;
  frame: number;
  modality: ModalityCode;
  tau_bps: number;
}

/** Private + public circuit witness input for `BiometricMatch(192)` (§8.6). */
export interface BiometricProverInput {
  commitment: string;
  bet_field: string;
  evidence_field: string;
  participant_idx: string;
  frame: string;
  modality: string;
  tau_bps: string;
  result: string;
  /** 192 values; negatives as decimal strings `p - |x|` */
  enrolled: string[];
  salt: string;
  observed: string[];
}

/** Per-modality biometric secret held (encrypted) by the backend (§8.4). */
export interface EnrollmentSecret {
  /** 192 i8 values (face zero-padded from 128) */
  q: Int8Array;
  /** 31 random bytes interpreted little-endian */
  salt: bigint;
}

// ===========================================================================
// §7 Evidence integrity
// ===========================================================================

export type WitnessKind = 'camera' | 'audio' | 'detections';
export type WitnessKindCode = 0 | 1 | 2;

/** Inputs to `chainGenesis` (§7.2 G_w). */
export interface ChainGenesisArgs {
  bet: Pubkey;
  witness_key: Pubkey;
  kind: WitnessKindCode;
  /** u64 */
  beacon_slot: bigint;
  /** 32 bytes */
  beacon_hash: Uint8Array;
}

/** Inputs to `chunkHash` (§7.2 c_i). */
export interface ChunkHashArgs {
  /** G_w for i = 0, else c_{i-1} (32 bytes) */
  prev: Uint8Array;
  /** u32 */
  index: number;
  kind: WitnessKindCode;
  /** i64 device-local ms since the witness started recording */
  start_ms: number;
  /** u32 */
  duration_ms: number;
  /** sha256(body), 32 bytes */
  body_sha256: Uint8Array;
}

export interface MerkleSibling {
  hash: Hex32;
  side: 'L' | 'R';
}

/** §7.3 inclusion proof JSON. */
export interface MerkleProof {
  leaf: Hex32;
  index: number;
  siblings: MerkleSibling[];
}

/** One witness head for the rolling evidence root (§7.4). */
export interface WitnessHead {
  witness_key: Pubkey;
  /** u32; 0xFFFFFFFF = no chunks yet */
  index: number;
  /** c_index, or G_w when index = 0xFFFFFFFF (32 bytes) */
  hash: Uint8Array;
}

/** `decodeBeacon` output (§7.5). */
export interface DecodedBeacon {
  slot: bigint;
  /** beacon_hash[0..8] */
  hashPrefix: Uint8Array;
  /** sample index of t0 (immediately after the last symbol) */
  t0Sample: number;
}

/** Normalized Scribe output (§7.6). */
export interface ScribeTranscript {
  segments: { speaker: string; start_ms: number; end_ms: number; text: string }[];
  events: { type: string; at_ms: number }[];
}

// ===========================================================================
// §10 Replay booth
// ===========================================================================

export type ExhibitKind =
  | 'clip'
  | 'audio'
  | 'tracks'
  | 'transcript'
  | 'identity'
  | 'program'
  | 'flags'
  | 'rerun'
  | 'phone';

export interface ChainLink {
  index: number;
  kind: number;
  start_ms: number;
  duration_ms: number;
  body_sha256: Hex32;
  /**
   * First link only, when `from_index > 0`: `c_{from-1}` (§10.1 "included as
   * the prev of the first link"). Omitted when `from_index = 0` (prev = G_w).
   */
  prev?: Hex32;
}

export interface ExhibitChainProof {
  witness: string;
  from_index: number;
  /** from_index..head */
  links: ChainLink[];
  /** leaf_w (§7.4) in evidence_root */
  head_proof: MerkleProof;
}

export interface Exhibit {
  /** "E1", "E2", … in creation order */
  id: string;
  kind: ExhibitKind;
  /** "cam1".."cam8" / "mic1".."mic8" */
  witness: string | null;
  t_start_ms: number;
  t_end_ms: number;
  /** GET /bets/:id/exhibits/:eid */
  uri: string;
  sha256: Hex32;
  chain_proofs: ExhibitChainProof[];
}

export interface AdvocateBrief {
  side: Side;
  /** ≤ 600 chars */
  claim: string;
  citations: string[];
  exhibits: string[];
}

/** 0 no contest, 1 side 0 wins, 2 side 1 wins */
export type PanelOutcome = 0 | 1 | 2;

export interface JudgeOutput {
  outcome: PanelOutcome;
  confidence_bps: number;
  /** ≤ 1000 chars */
  rationale: string;
}

/** Inputs to `judgeCommit` (§10.4). */
export interface JudgeCommitArgs {
  bet: Pubkey;
  /** judge index 0..2 */
  judge: number;
  outcome: PanelOutcome;
  confidence_bps: number;
  rationale: string;
  /** 32 bytes */
  nonce: Uint8Array;
}

export interface JudgeCommitRecord {
  judge: number;
  commit: Hex32;
  at_ms: number;
}

export interface JudgeReveal {
  judge: number;
  outcome: PanelOutcome;
  confidence_bps: number;
  rationale: string;
  /** 32 bytes hex */
  nonce: Hex32;
}

/** `panelQuorum(reveals)` output (§10.5). */
export interface PanelRuling {
  outcome: PanelOutcome;
  /** count per outcome among judges with confidence ≥ PANEL_CONF_FLOOR_BPS, indexed by outcome */
  votes: [number, number, number];
  /** two lowest-index judges that voted for the ruling (No contest default: [0, 1]) */
  signers: [number, number];
}

export type BoothStatus = 'collecting' | 'judging' | 'ruled' | 'submitted';

export interface BoothRecord {
  status: BoothStatus;
  exhibits: Exhibit[];
  briefs: AdvocateBrief[];
  commits: JudgeCommitRecord[];
  reveals: JudgeReveal[];
  ruling: { outcome: PanelOutcome; votes: [number, number, number] } | null;
  tx_signature: string | null;
}

// ===========================================================================
// §11 World Mode
// ===========================================================================

export interface WorldContract {
  id: string;
  label: string;
  prob_bps: number;
  bid_bps?: number;
  ask_bps?: number;
}

export interface WorldEvent {
  id: string;
  title: string;
  category: string;
  close_time_ms: number;
  status: 'open' | 'closed' | 'resolved';
  contracts: WorldContract[];
  resolution?: { contract_id: string; result: 'yes' | 'no' | 'void' }[];
}

/** One pick of a World Mode quote (one leg). */
export interface MarketPick {
  event_id: string;
  contract_id: string;
  side: MarketSide;
  /** quote-time probability of the contract's "yes" (0..10000) */
  prob_bps: number;
  close_time_ms: number;
  /** event title, for the draft title only (not hashed) */
  event_title?: string;
}

/** `compileMarket(quote, proposer, counterparty, nowMs)` quote input (§11.4). */
export interface MarketQuote {
  /** 1..MAX_PARLAY_LEGS picks, distinct contracts, leg order */
  picks: MarketPick[];
  /** total pot T in USDC units (§11.2) */
  total_units: number;
}

/** `stakeSplit` output (§11.2), bigint. */
export interface StakeSplit {
  proposer_stake: bigint;
  counterparty_stake: bigint;
}

// ===========================================================================
// §9 Onchain program: accounts, instructions, events, chain model
//
// Field representation for Borsh data in TS:
//   Pubkey → base58 string; [u8;32] → Hex32; u8/u16/u32 → number;
//   u64/i64 → bigint; bool → boolean; fixed arrays → arrays of exactly that
//   length; Vec<T> → T[]; Vec<u8> → Uint8Array.
// ===========================================================================

export type ErrorCode = (typeof ERROR_CODES)[number];
export type InstructionName = (typeof INSTRUCTION_NAMES)[number];
export type VerdictEventName = (typeof EVENT_NAMES)[number];

/** Bet state code (§9.2): 0 Proposed … 7 Refunded. */
export type BetStateCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type BetStateName =
  | 'Proposed'
  | 'Funded'
  | 'Live'
  | 'Perceiving'
  | 'PreRuled'
  | 'Disputed'
  | 'Settled'
  | 'Refunded';
/** Bet `preruling` (§9.2): 0 none / 1 WINNER / 2 NO_CONTEST / 3 NEEDS_PANEL. */
export type PrerulingCode = 0 | 1 | 2 | 3;
/** 0 none / 1 CONSENT / 2 RULE / 3 PANEL / 4 REFUND. */
export type SettlePathCode = 0 | 1 | 2 | 3 | 4;
/** 0 none / 1..4 participant reasons / 10..13 automatic reasons. */
export type DisputeReasonCode = 0 | 1 | 2 | 3 | 4 | 10 | 11 | 12 | 13;
/** 0 none / 1..8 (§9.2). */
export type RefundReasonCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** 0 no / 1 yes / 2 SP1-only. */
export type TracksFinalizedCode = 0 | 1 | 2;

/** §9.3 BioCheck (6 bytes Borsh). */
export interface BioCheck {
  participant: number;
  modality: ModalityCode;
  frame: number;
}

/** §9.3 Profile (Borsh, space 8 + 179), fields in order. */
export interface ProfileAccount {
  wallet: Pubkey;
  face_commit: Hex32;
  voice_commit: Hex32;
  /** decoded UTF-8 of display_name[0..name_len] */
  display_name: string;
  name_len: number;
  /** bit0 face, bit1 voice */
  flags: number;
  bump: number;
  created_at: bigint;
  updated_at: bigint;
  /** 32 bytes, zero */
  reserved: Hex32;
}

/** §9.3 Bet (Borsh, space 8 + 1580), fields in order. */
export interface BetAccount {
  /** = 1 */
  version: number;
  bump: number;
  vault_bump: number;
  state: BetStateCode;
  /** bit0 any_actor_bound, bit1 ai_judged, bit2 market */
  flags: number;
  creator: Pubkey;
  nonce: bigint;
  mint: Pubkey;
  oracle: Pubkey;
  /** length 3 */
  judges: Pubkey[];
  n_participants: number;
  /** length 8; unused slots = all-zero key (base58 "11111111111111111111111111111111") */
  participants: Pubkey[];
  /** length 8 (u64) */
  stakes: bigint[];
  side_b_mask: number;
  funded_mask: number;
  stake_each: bigint;
  time_limit_s: number;
  program_hash: Hex32;
  calibration_hash: Hex32;
  acceptance_audio_hash: Hex32;
  created_at: bigint;
  fund_deadline: bigint;
  funded_at: bigint;
  started_at: bigint;
  beacon_slot: bigint;
  beacon_hash: Hex32;
  n_witnesses: number;
  /** length 8; unused = zero key */
  witnesses: Pubkey[];
  /** length 8; unused = 0xFF */
  witness_kinds: number[];
  /** length 8; unused/none = 0xFFFFFFFF */
  witness_heads: number[];
  /** length 8; G_w for a registered witness with no chunks; zero for unused slots */
  witness_head_hashes: Hex32[];
  gap_mask: number;
  evidence_seq: number;
  evidence_root: Hex32;
  last_commit_at: bigint;
  ended_at: bigint;
  perception_root: Hex32;
  tracks_hash: Hex32;
  tracks_finalized: TracksFinalizedCode;
  preruling: PrerulingCode;
  prerule_reason: number;
  winner_mask: number;
  /** length 8; unused = 0xFF */
  leg_results: number[];
  preruled_at: bigint;
  consent_deadline: bigint;
  consent_mask: number;
  /** all-zero key when none */
  disputer: Pubkey;
  dispute_bond: bigint;
  dispute_reason: DisputeReasonCode;
  disputed_at: bigint;
  n_bio: number;
  /** length 8; unused entries zero */
  bio: BioCheck[];
  settled_at: bigint;
  settle_path: SettlePathCode;
  final_winner_mask: number;
  refund_reason: RefundReasonCode;
  /** 64 bytes, zero (hex, 128 chars) */
  reserved: Hex;
}

/** §9.3 TrackBuffer zero-copy header (48 bytes). */
export interface TrackBufferHeader {
  bet: Pubkey;
  payload_len: number;
  program_len: number;
  calibration_len: number;
  written: number;
  finalized: number;
  bump: number;
}

/** TrackBuffer account model: header + payload bytes written so far. */
export interface TrackBufferAccount {
  header: TrackBufferHeader;
  /** length payload_len; bytes ≥ header.written are zero */
  payload: Uint8Array;
}

// ---- §9.4 instruction arguments (Borsh, in listed order) ------------------

export interface WitnessArg {
  key: Pubkey;
  kind: WitnessKindCode;
}

export interface HeadArg {
  index: number;
  hash: Hex32;
}

export interface InstructionArgsMap {
  init_profile: { face_commit: Hex32; voice_commit: Hex32; display_name: string };
  create_bet: {
    nonce: bigint;
    participants: Pubkey[];
    stakes: bigint[];
    side_b_mask: number;
    stake_each: bigint;
    time_limit_s: number;
    flags: number;
    program_hash: Hex32;
    acceptance_audio_hash: Hex32;
    judges: [Pubkey, Pubkey, Pubkey];
  };
  fund: { calibration_hash: Hex32; program_hash: Hex32; terms_hash: Hex32 };
  cancel: Record<string, never>;
  start: { beacon_slot: bigint; witnesses: WitnessArg[] };
  commit_evidence: { seq: number; heads: HeadArg[] };
  end: { seq: number; heads: HeadArg[] };
  post_tracks: {
    payload_len: number;
    program_len: number;
    calibration_len: number;
    offset: number;
    data: Uint8Array;
    finalize: boolean;
    perception_root: Hex32;
  };
  run_rules: Record<string, never>;
  consent: { winner_mask: number; evidence_root: Hex32 };
  dispute: { reason: number; evidence_root: Hex32 };
  settle_panel: { outcome: PanelOutcome };
  verify_biometric_proof: {
    participant: number;
    modality: ModalityCode;
    frame: number;
    tau_bps: number;
    /** 64 bytes */
    proof_a: Uint8Array;
    /** 128 bytes */
    proof_b: Uint8Array;
    /** 64 bytes */
    proof_c: Uint8Array;
  };
  verify_sp1_run: { public_values: Uint8Array; proof: Uint8Array };
  refund: Record<string, never>;
}

/** Account names per instruction, in IDL order (§9.4; the IDL is authoritative). */
export interface InstructionAccountsMap {
  init_profile: 'payer' | 'wallet' | 'profile' | 'system_program';
  create_bet:
    | 'payer'
    | 'creator'
    | 'oracle'
    | 'bet'
    | 'vault'
    | 'mint'
    | 'token_program'
    | 'system_program';
  fund: 'participant' | 'bet' | 'vault' | 'participant_token' | 'token_program';
  cancel: 'creator' | 'bet' | 'vault' | 'oracle' | 'track_buffer' | 'token_program';
  start: 'authority' | 'bet' | 'slot_hashes';
  commit_evidence: 'oracle' | 'bet';
  end: 'authority' | 'bet';
  post_tracks: 'payer' | 'oracle' | 'bet' | 'track_buffer' | 'system_program';
  run_rules: 'oracle' | 'bet' | 'track_buffer';
  consent: 'authority' | 'bet' | 'vault' | 'oracle' | 'track_buffer' | 'token_program';
  dispute: 'disputer' | 'bet' | 'vault' | 'disputer_token' | 'token_program';
  settle_panel: 'bet' | 'vault' | 'oracle' | 'track_buffer' | 'token_program' | 'instructions';
  verify_biometric_proof: 'oracle' | 'bet' | 'profile';
  verify_sp1_run: 'oracle' | 'bet';
  refund: 'bet' | 'vault' | 'oracle' | 'track_buffer' | 'token_program';
}

/** An instruction applied to the chain model. */
export interface ChainInstruction<N extends InstructionName = InstructionName> {
  name: N;
  args: InstructionArgsMap[N];
  /** base58 keys that signed the transaction */
  signers: Pubkey[];
  /** named accounts (§9.4 order) */
  accounts: Partial<Record<InstructionAccountsMap[N], Pubkey>>;
  /**
   * "Payout accounts" (remaining accounts): SPL token accounts, one per
   * participant in participant order, for cancel/consent/settle_panel/refund.
   */
  remaining_accounts?: Pubkey[];
}

/** SlotHashes sysvar entry (descending by slot). */
export interface SlotHashEntry {
  slot: bigint;
  hash: Hex32;
}

/** The instruction immediately before the current one (instructions sysvar). */
export interface SiblingInstruction {
  program_id: Pubkey;
  data: Uint8Array;
}

/** Environment the pure chain model needs to apply one instruction. */
export interface ChainContext {
  /** Clock unix_timestamp (i64 seconds) */
  now_s: bigint;
  /** Clock slot */
  slot: bigint;
  /** SlotHashes sysvar (descending by slot, ≤ 512 entries) */
  slot_hashes: SlotHashEntry[];
  /** Verdict program id (needed for the §9.7 panel message). */
  program_id?: Pubkey;
  /** Profile account for verify_biometric_proof / init_profile. */
  profile?: ProfileAccount | null;
  /** TrackBuffer account state for post_tracks / run_rules / close paths. */
  track_buffer?: TrackBufferAccount | null;
  /** Instruction at current_index - 1 (settle_panel Ed25519 check). */
  prev_instruction?: SiblingInstruction | null;
  /**
   * Groth16 verifier (snarkjs or mock). Called with the §8.6 public inputs
   * (8 × 32-byte BE) and the encoded proof; omitted ⇒ accept (mock).
   */
  verifyGroth16?: (publicInputs: Uint8Array[], proof: EncodedGroth16Proof) => boolean;
  /** Owner of each SPL token account passed (payout/participant/disputer), for BadTokenAccount checks. */
  token_owners?: Record<Pubkey, Pubkey>;
  /** Vault token balance (dust rule, §9.4). Defaults to the accounted amount. */
  vault_amount?: bigint;
}

/** One SPL token transfer emitted by the chain model. */
export interface ChainTransfer {
  /** source token account */
  from: Pubkey;
  /** destination token account */
  to: Pubkey;
  amount: bigint;
}

/** A closed account and its rent destination. */
export interface ChainClose {
  account: Pubkey;
  rent_to: Pubkey;
}

export type ChainApplyResult =
  | {
      bet: BetAccount;
      events: VerdictEvent[];
      transfers: ChainTransfer[];
      /** updated TrackBuffer (post_tracks), if any */
      track_buffer?: TrackBufferAccount | null;
      /** updated Profile (init_profile), if any */
      profile?: ProfileAccount | null;
      /** accounts closed by this instruction (vault, track_buffer) */
      closed?: ChainClose[];
    }
  | { error: ErrorCode };

/** Arguments for `chainModel.initialBet` (the zero-initialised account before `create_bet`). */
export interface InitialBetArgs {
  bump: number;
  vault_bump: number;
}

export interface ChainModel {
  initialBet(args: InitialBetArgs): BetAccount;
  apply(bet: BetAccount, ix: ChainInstruction, ctx: ChainContext): ChainApplyResult;
}

// ---- §9.5 events ---------------------------------------------------------

export interface VerdictEventMap {
  ProfileUpdated: { wallet: Pubkey; flags: number };
  BetCreated: {
    bet: Pubkey;
    creator: Pubkey;
    nonce: bigint;
    participants: Pubkey[];
    stakes: bigint[];
    side_b_mask: number;
    flags: number;
    program_hash: Hex32;
    time_limit_s: number;
    fund_deadline: bigint;
  };
  Funded: {
    bet: Pubkey;
    participant: Pubkey;
    participant_idx: number;
    amount: bigint;
    funded_mask: number;
    all_funded: boolean;
    calibration_hash: Hex32;
  };
  BetCancelled: { bet: Pubkey };
  BetStarted: { bet: Pubkey; beacon_slot: bigint; beacon_hash: Hex32; started_at: bigint; n_witnesses: number };
  EvidenceCommitted: { bet: Pubkey; seq: number; root: Hex32; gap_mask: number; is_final: boolean };
  BetEnded: { bet: Pubkey; evidence_root: Hex32; ended_at: bigint };
  TracksPosted: { bet: Pubkey; perception_root: Hex32; tracks_hash: Hex32; payload_len: number };
  BiometricVerified: { bet: Pubkey; participant_idx: number; modality: ModalityCode; frame: number };
  PreRuled: {
    bet: Pubkey;
    preruling: number;
    reason: number;
    winner_mask: number;
    /** length 8 */
    leg_results: number[];
    consent_deadline: bigint;
  };
  Consented: { bet: Pubkey; participant: Pubkey; consent_mask: number };
  Disputed: { bet: Pubkey; disputer: Pubkey; reason: number; bond: bigint };
  Settled: {
    bet: Pubkey;
    path: number;
    winner_mask: number;
    pot: bigint;
    /** length 8 */
    payouts: bigint[];
  };
  Refunded: {
    bet: Pubkey;
    reason: number;
    /** length 8 */
    amounts: bigint[];
  };
}

/** A typed Verdict event. */
export type VerdictEvent = {
  [N in VerdictEventName]: { name: N; data: VerdictEventMap[N] };
}[VerdictEventName];

/**
 * JSON-decoded event data (§12.5): Pubkey → base58, [u8;32] → hex,
 * u64/i64 → decimal string, smaller ints → number, bool → boolean,
 * arrays of u8 → number arrays.
 */
export type JsonEventData<T> = {
  [K in keyof T]: T[K] extends bigint
    ? string
    : T[K] extends bigint[]
      ? string[]
      : T[K];
};

export interface DecodedEventJson<N extends VerdictEventName = VerdictEventName> {
  name: N;
  data: JsonEventData<VerdictEventMap[N]>;
}

// ---- §9.8 settlement -----------------------------------------------------

/** `payouts(bet, winnerMask, bondUpheld)` output. */
export interface PayoutResult {
  pot: bigint;
  /** length n_participants; total transferred to participant i (bond refund included) */
  payouts: bigint[];
  /** amount returned to the disputer (0 when upheld or no bond) */
  bond_refund: bigint;
}

// ===========================================================================
// lang module (§2): surface-level draft program accepted by `canonicalize`
//
// `parseYaml` first builds a `ProgramDraft` (the YAML surface after expression
// parsing; persons, `region(tap)`, sides and defaults still unresolved), then
// `canonicalize` turns it into a canonical `Program`. Every canonical
// `Program` is also a valid `ProgramDraft`, so `canonicalize` is idempotent.
// ===========================================================================

/** A `person(...)` entity whose member is not resolved yet. */
export interface DraftPersonEntity {
  name: string;
  kind: 'person';
  /** Raw member reference: base58 pubkey, `pN` (huddle index) or a display name (unquoted). */
  member: string;
}
/** A region whose shape may still be `tap` (§2.2 [D-1]). */
export interface DraftRegionEntity {
  name: string;
  kind: 'region';
  shape: RegionShape | 'tap';
}
export type DraftEntity = Entity | DraftPersonEntity | DraftRegionEntity;

/** Unresolved outcome side reference (§2.4 SideRef); a bare 0|1 is already resolved. */
export type SideRefInput =
  | Side
  | { side: 'creator' | 'other' | 'A' | 'B' }
  | { entity: string };

export interface DraftMarketRef {
  venue?: 'gemini';
  event_id: string;
  contract_id: string;
  side: MarketSide;
  prob_bps: number;
}

export interface DraftLeg {
  id: number;
  actor_bound: boolean;
  /** omitted ⇒ default (rules: ATTEMPT_WINDOW_DEFAULT, market: 0) */
  attempt_window_frames?: number;
  valid_attempt?: Expr;
  success?: Expr;
  rule?: Rule;
  market?: DraftMarketRef;
}

export interface DraftOutcome {
  if_true: SideRefInput;
  condition: LegExpr | YesCondition;
  else: SideRefInput;
}

/** Sides as a list aligned with participants, or the map form `{A: [...], B: [...]}` (names or pubkeys). */
export type SidesInput = Side[] | { A: string[]; B: string[] };

export interface ProgramDraft {
  version: 2;
  kind?: ProgramKind;
  participants?: Pubkey[];
  sides?: SidesInput;
  entities: DraftEntity[];
  legs: DraftLeg[];
  question?: string;
  outcome: DraftOutcome;
  stake_each?: number;
  stakes?: number[];
  time_limit_s?: number;
}
