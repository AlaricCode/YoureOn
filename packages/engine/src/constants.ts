/**
 * Verdict engine constants.
 *
 * Source of truth: docs/CONTRACTS.md. Section references (§x.y) point there.
 * This file has no imports and no side effects so every module (and the Dart /
 * Rust generators) can depend on it without cycles.
 *
 * Every value here is an integer that fits in a JS `number` (|x| < 2^53) unless it
 * is declared as a `bigint`.
 */

// ---------------------------------------------------------------------------
// §0.5 Global constants (normative; mirrored by Rust `constants.rs` and Dart)
// ---------------------------------------------------------------------------

/** Track frame rate. Frame f covers t_ms ∈ [f*100, f*100+100) after t0. */
export const FPS = 10;
export const COORD_MAX = 10000;
export const MAX_PARTICIPANTS = 8;
export const MIN_PARTICIPANTS = 2;
/** Huddle members (spec §5.3). */
export const MAX_HUDDLE = 10;
export const MAX_ENTITIES = 16;
export const MAX_LEGS = 8;
/** Bytes per encoded leg expression. */
export const MAX_EXPR_BYTES = 512;
/** Op bytes per leg expression. */
export const MAX_EXPR_NODES = 64;
/** Leaf depth = 1. */
export const MAX_EXPR_DEPTH = 12;
/** Nodes in an outcome condition. */
export const MAX_COND_NODES = 32;
/** Decisive windows per TrackBuffer. */
export const MAX_SEGMENTS = 16;
/** Bytes in TrackBuffer payload; 8 + 48 + MAX_BUFFER_PAYLOAD ≤ 10240. */
export const MAX_BUFFER_PAYLOAD = 10000;
/** Total buffer frames Σ n_frames. */
export const MAX_EVAL_FRAMES = 1024;
/** Evaluation cost cap (§3.13). */
export const MAX_EVAL_COST = 16384;
/** Max `data` bytes per `post_tracks` instruction. */
export const POST_TRACKS_CHUNK = 700;
export const MAX_WITNESSES = 8;
/** Identity checkpoints per bet. */
export const MAX_CHECKPOINTS = 8;
/** Record conf (%) below which an entity is treated as absent. */
export const PRESENCE_MIN = 30;
/** Conf (%) required at decisive frames. */
export const DECISIVE_CONF_MIN = 50;
/** Identity confidence (%) at checkpoints. */
export const ID_CONF_MIN = 60;
/** Frames between velocity samples. */
export const VEL_K = 2;
/** `moving` threshold (ups). */
export const MOVE_MIN_UPS = 300;
/** `still` threshold (ups), used by `at_rest`. */
export const STILL_MAX_UPS = 250;
/** Default `near` distance (normalized units). */
export const NEAR_DEFAULT = 500;
/** Max `near` distance. */
export const NEAR_MAX = 14143;
/** Max `speed` comparison value. */
export const SPEED_MAX = 100000;
/** Max `rep_count` value and count `k`. */
export const REPS_MAX = 1000;
/** `within attempts N` maximum. */
export const ATTEMPTS_MAX = 20;
/** `within attempts N` maximum for actor-bound legs (§2.7 CHECKPOINT_LIMIT). */
export const ATTEMPTS_MAX_ACTOR_BOUND = 8;
/** Held frames required before release. */
export const RELEASE_HOLD = 2;
/** Max frames between presence samples (lastSeen, release, crossing). */
export const RELEASE_GAP = 3;
/** Person bbox expansion (%) for "held". */
export const HAND_EXPAND_PCT = 10;
/** Frames (1 s) an object must stay unseen-outside after `disappears_into`. */
export const DISAPPEAR_FRAMES = 10;
export const DESCEND_LOOKBACK = 3;
/** How long a derived region survives its object's absence (frames). */
export const STALE_REGION_FRAMES = 30;
/** `intact` height threshold (%). */
export const INTACT_PCT = 75;
/** Default attempt window (frames, = 5 s). */
export const ATTEMPT_WINDOW_DEFAULT = 50;
/** Recording continues this long after End (look-ahead only). */
export const TAIL_MS = 2000;
export const TAIL_FRAMES = 20;
/** Max interior gap filled by `quantizeSession` (non-consensus). */
export const OCCLUSION_FILL_FRAMES = 3;
/** Object entity absence after its track ends (> DISAPPEAR_FRAMES). */
export const REBIND_DELAY_FRAMES = 15;
/** UI latch for event rows (scene check, practice). */
export const PULSE_LATCH_FRAMES = 10;
export const DEFAULT_TIME_LIMIT_S = 120;
/** rules / ai_judged programs. */
export const TIME_LIMIT_MAX_S = 3600;
/** market programs (30 days). */
export const MARKET_TIME_LIMIT_MAX_S = 2592000;
/** $0.01, every stake. */
export const MIN_STAKE_UNITS = 10000;
export const MAX_STAKE_UNITS = 1000000000000;
/** Proposed → refundable after. */
export const FUND_WINDOW_S = 900;
/** Funded → refundable after. */
export const START_WINDOW_S = 900;
/** Live past time limit → refundable after. */
export const LIVE_GRACE_S = 300;
/** Perceiving → refundable after. */
export const PERCEPTION_TIMEOUT_S = 3600;
/** PreRuled consent/dispute window. */
export const CONSENT_WINDOW_S = 120;
/** Disputed → refundable after; also PreRuled stuck escape. */
export const PANEL_TIMEOUT_S = 3600;
export const BEACON_MAX_AGE_SLOTS = 150;
/** Start sound plays this long after the WS `start` message. */
export const PLAY_DELAY_MS = 1500;
export const EVIDENCE_COMMIT_INTERVAL_S = 30;
/** Larger gap sets all witness gap bits. */
export const EVIDENCE_MAX_GAP_S = 90;
export const CHUNK_MS = 5000;
/** Hash record later than chunk end + this ⇒ `late` (advisory). */
export const CHUNK_LATE_MS = 10000;
/** Tolerated inter-chunk gap. */
export const CHUNK_GAP_MAX_MS = 500;
/** 20 MiB. */
export const MAX_CHUNK_BODY_BYTES = 20971520;
export const MAX_CHUNKS_PER_COMMIT = 24;
/** bond = max(min_i stakes[i] / DISPUTE_BOND_DIV, DISPUTE_BOND_MIN). */
export const DISPUTE_BOND_DIV = 5;
/** 0.10 USDC. */
export const DISPUTE_BOND_MIN = 100000;
export const FACE_DIM = 128;
export const VOICE_DIM = 192;
export const CIRCUIT_DIM = 192;
export const EMB_SCALE = 512;
export const TAU_FACE_BPS = 5500;
export const DELTA_FACE_BPS = 1000;
export const TAU_VOICE_BPS = 5000;
export const DELTA_VOICE_BPS = 1000;
/** Perception cross-check IoU agreement. */
export const IOU_AGREE_BPS = 5000;
export const TRACK_AGREE_BPS = 9000;
export const EVENT_TOL_FRAMES = 3;
export const PANEL_CONF_FLOOR_BPS = 6000;
/** World Mode probability clamp. */
export const PROB_CLAMP_MIN_BPS = 100;
export const PROB_CLAMP_MAX_BPS = 9900;
export const MAX_PARLAY_LEGS = 4;
/** "Camera moved" warning (centi-degrees). */
export const CAMERA_POSE_DRIFT_CDEG = 300;
/** Pay closed-set window. */
export const RECENT_HUDDLE_S = 86400;
/** §12.6 keeper interval. */
export const KEEPER_INTERVAL_S = 5;
/** Demo faucet drip. */
export const FAUCET_UNITS = 50000000;

/**
 * The §0.5 table as one object, in table order. Exposed as `CONSTANTS` by the
 * public API (§14) and consumed by `npm run gen:dart`.
 */
export const GLOBAL_CONSTANTS = {
  FPS,
  COORD_MAX,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  MAX_HUDDLE,
  MAX_ENTITIES,
  MAX_LEGS,
  MAX_EXPR_BYTES,
  MAX_EXPR_NODES,
  MAX_EXPR_DEPTH,
  MAX_COND_NODES,
  MAX_SEGMENTS,
  MAX_BUFFER_PAYLOAD,
  MAX_EVAL_FRAMES,
  MAX_EVAL_COST,
  POST_TRACKS_CHUNK,
  MAX_WITNESSES,
  MAX_CHECKPOINTS,
  PRESENCE_MIN,
  DECISIVE_CONF_MIN,
  ID_CONF_MIN,
  VEL_K,
  MOVE_MIN_UPS,
  STILL_MAX_UPS,
  NEAR_DEFAULT,
  NEAR_MAX,
  SPEED_MAX,
  REPS_MAX,
  ATTEMPTS_MAX,
  RELEASE_HOLD,
  RELEASE_GAP,
  HAND_EXPAND_PCT,
  DISAPPEAR_FRAMES,
  DESCEND_LOOKBACK,
  STALE_REGION_FRAMES,
  INTACT_PCT,
  ATTEMPT_WINDOW_DEFAULT,
  TAIL_MS,
  TAIL_FRAMES,
  OCCLUSION_FILL_FRAMES,
  REBIND_DELAY_FRAMES,
  PULSE_LATCH_FRAMES,
  DEFAULT_TIME_LIMIT_S,
  TIME_LIMIT_MAX_S,
  MARKET_TIME_LIMIT_MAX_S,
  MIN_STAKE_UNITS,
  MAX_STAKE_UNITS,
  FUND_WINDOW_S,
  START_WINDOW_S,
  LIVE_GRACE_S,
  PERCEPTION_TIMEOUT_S,
  CONSENT_WINDOW_S,
  PANEL_TIMEOUT_S,
  BEACON_MAX_AGE_SLOTS,
  PLAY_DELAY_MS,
  EVIDENCE_COMMIT_INTERVAL_S,
  EVIDENCE_MAX_GAP_S,
  CHUNK_MS,
  CHUNK_LATE_MS,
  CHUNK_GAP_MAX_MS,
  MAX_CHUNK_BODY_BYTES,
  MAX_CHUNKS_PER_COMMIT,
  DISPUTE_BOND_DIV,
  DISPUTE_BOND_MIN,
  FACE_DIM,
  VOICE_DIM,
  CIRCUIT_DIM,
  EMB_SCALE,
  TAU_FACE_BPS,
  DELTA_FACE_BPS,
  TAU_VOICE_BPS,
  DELTA_VOICE_BPS,
  IOU_AGREE_BPS,
  TRACK_AGREE_BPS,
  EVENT_TOL_FRAMES,
  PANEL_CONF_FLOOR_BPS,
  PROB_CLAMP_MIN_BPS,
  PROB_CLAMP_MAX_BPS,
  MAX_PARLAY_LEGS,
  CAMERA_POSE_DRIFT_CDEG,
  RECENT_HUDDLE_S,
  KEEPER_INTERVAL_S,
  FAUCET_UNITS,
} as const;

export type GlobalConstantName = keyof typeof GLOBAL_CONSTANTS;

// ---------------------------------------------------------------------------
// §2 Rule language: limits and lexical patterns
// ---------------------------------------------------------------------------

/** Supported program `version`. */
export const PROGRAM_VERSION = 2;
/** Max frames for any DSL duration parameter (then_within, for_duration, before, at_rest). */
export const MAX_DURATION_FRAMES = 36000;
/** Min frames for any DSL duration parameter. */
export const MIN_DURATION_FRAMES = 1;
/** Leg ids are 1..MAX_LEGS. */
export const MIN_LEG_ID = 1;
export const MIN_TIME_LIMIT_S = 1;
/** ai_judged `question` length bounds (chars). */
export const QUESTION_MIN_CHARS = 1;
export const QUESTION_MAX_CHARS = 280;
/** Zone polygons have 3..8 vertices (§2.2, §5.2). */
export const ZONE_MIN_POINTS = 3;
export const ZONE_MAX_POINTS = 8;
export const LINE_POINTS = 2;
/** `person("Display Name")` max length (§2.2 pattern). */
export const PERSON_NAME_MAX_CHARS = 32;
/** Raw `object("...")` phrase max length before normalization (§2.2 pattern). */
export const OBJECT_PHRASE_RAW_MAX_CHARS = 64;
/** Normalized phrase max length (§2.2: 1 + 47). */
export const OBJECT_PHRASE_MAX_CHARS = 48;
/** Max entity name length (§2.2). */
export const ENTITY_NAME_MAX_CHARS = 24;

/** Entity name pattern (§2.2). Names must also not be reserved words. */
export const ENTITY_NAME_RE = /^[a-z][a-z0-9_]{0,23}$/;
/** `person(...)` entity value (§2.2). Group 1 = base58 key | pN | any | "Display Name" (quoted). */
export const PERSON_ENTITY_RE = /^person\(([1-9A-HJ-NP-Za-km-z]{32,44}|p[0-9]|any|"[^"]{1,32}")\)$/;
/** `object("...")` entity value (§2.2). Group 1 = raw phrase. */
export const OBJECT_ENTITY_RE = /^object\("([^"]{1,64})"\)$/;
/** `region(...)` entity value (§2.2). */
export const REGION_ENTITY_RE = /^region\((tap|line|zone)\)$/;
/** Normalized object phrase (§2.2). */
export const OBJECT_PHRASE_RE = /^[a-z0-9][a-z0-9 '\-]{0,47}$/;
/** Integer-with-separators string accepted for int fields (§2.5, [D-4]). */
export const INT_SEPARATOR_RE = /^[0-9]{1,16}(_[0-9]{3})*$/;
/** Base58 alphabet (Bitcoin / Solana). */
export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Top-level YAML keys, in canonical `toYaml` order (§2.5, §2.9). */
export const YAML_TOP_KEYS = [
  'version',
  'kind',
  'participants',
  'sides',
  'entities',
  'legs',
  'question',
  'outcome',
  'stake_each',
  'stakes',
  'time_limit_s',
] as const;
/** Synonym accepted for `kind: ai_judged` (§2.5). Not emitted by `toYaml`. */
export const YAML_AI_JUDGED_SYNONYM_KEY = 'ai_judged';
/** Leg keys, in canonical `toYaml` order (§2.5, §2.9). */
export const YAML_LEG_KEYS = [
  'id',
  'actor_bound',
  'valid_attempt',
  'success',
  'rule',
  'attempt_window_s',
  'market',
] as const;
/** Market leg sub-keys (§2.5). */
export const YAML_MARKET_KEYS = ['event_id', 'contract_id', 'side', 'prob_bps', 'venue'] as const;
export const DEFAULT_MARKET_VENUE = 'gemini';

/** Reserved words (§2.5.4). Entity names must not be one of these. */
export const RESERVED_WORDS = [
  'and', 'or', 'not', 'while', 'then_within', 'for_duration', 'before', 'before_deadline',
  'near', 'moving', 'present', 'intact', 'standing', 'at_rest', 'speed', 'direction', 'rep_count',
  'overlaps', 'inside', 'above', 'below', 'behind', 'beyond', 'enters', 'leaves', 'disappears_into',
  'touches', 'crosses', 'released_by', 'count', 'within', 'attempts', 'success', 'never', 'holds',
  'for', 'leg', 'side', 'wins', 'iff', 'else', 'yes', 'creator', 'other', 'any', 'tap', 'line',
  'zone', 'up', 'down', 'left', 'right', 'opening', 'interior', 'true', 'false',
] as const;

/** Binary relation primitives (§2.5.2 REL2), in grammar order. */
export const REL2_OPS = [
  'overlaps', 'inside', 'above', 'below', 'behind', 'beyond',
  'enters', 'leaves', 'disappears_into', 'touches', 'crosses', 'released_by',
] as const;
/** Unary state primitives with no parameter. */
export const UNARY_OPS = ['moving', 'present', 'intact', 'standing'] as const;
/** Event (pulse) primitives (§3.5). */
export const EVENT_OPS = ['enters', 'leaves', 'touches', 'crosses', 'released_by', 'disappears_into'] as const;
/** Primitives whose `b` must be a line region (§2.7). */
export const LINE_ONLY_OPS = ['behind', 'beyond', 'crosses'] as const;
/** Primitives whose `a` must be a person / person_any (§2.7). */
export const PERSON_A_OPS = ['standing', 'rep_count'] as const;
export const CMPS = ['>=', '>', '<=', '<', '==', '!='] as const;
export const DIRS = ['up', 'down', 'left', 'right'] as const;
export const SUBREGIONS = ['opening', 'interior'] as const;

/** Read-back words for CMP (§2.8). */
export const CMP_WORDS = {
  '>=': 'at least',
  '>': 'more than',
  '<=': 'at most',
  '<': 'fewer than',
  '==': 'exactly',
  '!=': 'not exactly',
} as const;

// ---------------------------------------------------------------------------
// §5 Binary encodings
// ---------------------------------------------------------------------------

/** "VRDP" */
export const PROGRAM_MAGIC = Uint8Array.of(0x56, 0x52, 0x44, 0x50);
export const PROGRAM_FORMAT_VERSION = 2;
/** "VCAL" */
export const CALIBRATION_MAGIC = Uint8Array.of(0x56, 0x43, 0x41, 0x4c);
export const CALIBRATION_VERSION = 1;
/** "VTRK" */
export const TRACK_MAGIC = Uint8Array.of(0x56, 0x54, 0x52, 0x4b);
export const TRACK_VERSION = 1;
/** "VMKT" */
export const MARKET_MAGIC = Uint8Array.of(0x56, 0x4d, 0x4b, 0x54);
export const MARKET_BIN_VERSION = 1;

/** program_bin fixed header size before participant keys (§5.1). */
export const PROGRAM_HEADER_BYTES = 44;
/** Fixed part of an encoded leg (id..attempt_window), before va_len (§5.1). */
export const LEG_FIXED_BYTES = 12;
/** Leaf node size: op byte + a + b + i32 p (§5.1). */
export const LEAF_NODE_BYTES = 7;
/** calibration_bin header size before regions (§5.3). */
export const CALIBRATION_HEADER_BYTES = 40;
/** track_bin header size before the track table (§5.4). */
export const TRACK_HEADER_BYTES = 44;
export const TRACK_TABLE_ENTRY_BYTES = 4;
export const SEGMENT_TABLE_ENTRY_BYTES = 8;
/** One track record (§5.4). */
export const TRACK_RECORD_BYTES = 12;
/** market_bin header bytes (§5.5). */
export const MARKET_BIN_HEADER_BYTES = 8;
/** market_hash + result. */
export const MARKET_BIN_ENTRY_BYTES = 33;
/** Market legs carry exactly a 32-byte market_hash as their success code (§5.1). */
export const MARKET_HASH_BYTES = 32;
/** Max u16 segment length. */
export const MAX_SEGMENT_FRAMES = 0xffff;

/** Program kind codes (§5.1). */
export const KIND_CODE = { rules: 0, ai_judged: 1, market: 2 } as const;
/** Entity kind codes (§2.2, §5.1). Region `line`/`zone` use 3/4. */
export const ENTITY_KIND_CODE = { person: 0, person_any: 1, object: 2, line: 3, zone: 4 } as const;
/** Rule kind codes (§5.1). */
export const RULE_KIND_CODE = { exists: 0, count: 1, holds: 2, never: 3, before: 4, market: 5 } as const;
/** CMP codes (§5.1). */
export const CMP_CODE = { '>=': 0, '>': 1, '<=': 2, '<': 3, '==': 4, '!=': 5 } as const;
/** DIR codes (§5.1). */
export const DIR_CODE = { up: 0, down: 1, left: 2, right: 3 } as const;
/** Sub-region codes in a Ref byte, bits 4–5 (§5.1). */
export const SUBREGION_CODE = { none: 0, opening: 1, interior: 2 } as const;
/** Ref byte layout (§5.1). */
export const REF_ENTITY_MASK = 0x0f;
export const REF_SUB_SHIFT = 4;
export const REF_SUB_MASK = 0x30;
export const REF_RESERVED_MASK = 0xc0;
/** Calibration region shape codes (§5.3). */
export const SHAPE_CODE = { line: 0, zone: 1 } as const;
/** Leg flag bits (§5.1). */
export const LEG_FLAG_ACTOR_BOUND = 0x01;
export const LEG_FLAG_HAS_VALID_ATTEMPT = 0x02;
export const LEG_FLAG_RESERVED_MASK = 0xfc;
/** Market leg expected result encoded in rule_k (§5.1). */
export const MARKET_EXPECTED = { yes: 1, no: 0 } as const;
/** market_bin result codes (§5.5). */
export const MARKET_RESULT = { no: 0, yes: 1, void: 2 } as const;
/** `participant_idx` in the track table for non-person tracks (§5.4). */
export const NO_PARTICIPANT = 0xff;

/** Combinator / condition op codes (§5.1). */
export const OP_AND = 0x01;
export const OP_OR = 0x02;
export const OP_NOT = 0x03;
export const OP_THEN_WITHIN = 0x04;
export const OP_FOR_DURATION = 0x05;
export const OP_BEFORE = 0x06;
export const OP_LEG = 0x50;
export const OP_YES = 0x51;

/** Leaf op codes (§5.1 leaf table). */
export const LEAF_CODE = {
  overlaps: 0x10,
  inside: 0x11,
  above: 0x12,
  below: 0x13,
  near: 0x14,
  behind: 0x15,
  beyond: 0x16,
  moving: 0x20,
  at_rest: 0x21,
  speed: 0x22,
  direction: 0x23,
  present: 0x24,
  intact: 0x25,
  enters: 0x30,
  leaves: 0x31,
  disappears_into: 0x32,
  touches: 0x33,
  crosses: 0x34,
  released_by: 0x35,
  standing: 0x40,
  rep_count: 0x41,
} as const;

/** track_bin flag bits (§5.4). */
export const TRACK_FLAG_CAMERA_MOTION = 0x01;
export const TRACK_FLAG_CROSS_CHECK_OK = 0x02;
export const TRACK_FLAG_AUDIO_DISAGREE = 0x04;
export const TRACK_FLAG_WINDOW_UNAVAILABLE = 0x08;
export const TRACK_FLAG_PHONE_DISAGREE = 0x10;
export const TRACK_FLAG_RESERVED_MASK = 0xe0;
/** Record pose bits (§5.4). */
export const POSE_STANDING = 0x01;
export const POSE_REP_LOW = 0x02;
export const POSE_REP_HIGH = 0x04;
export const POSE_RESERVED_MASK = 0xf8;
/** Minimal ai_judged track_bin flags: cross_check_ok only (§5.6). */
export const AI_JUDGED_TRACK_FLAGS = 0b10;

// ---------------------------------------------------------------------------
// §3 Evaluation
// ---------------------------------------------------------------------------

/** Leg values (§3.7). */
export const LEG_FALSE = 0;
export const LEG_TRUE = 1;
export const LEG_UNKNOWN = 2;
/** Padding for unused onchain `leg_results` slots (§3.12, §9.3). */
export const LEG_RESULT_UNUSED = 0xff;

/** Pre-ruling codes (§3.10, §9.2). 0 = none (onchain only). */
export const PRERULING_NONE = 0;
export const PRERULING_WINNER = 1;
export const PRERULING_NO_CONTEST = 2;
export const PRERULING_NEEDS_PANEL = 3;

/** NEEDS_PANEL reasons (§3.10). 0 when ok. */
export const REASON_OK = 0;
export const REASON_LOW_CONFIDENCE = 10;
export const REASON_AI_JUDGED = 11;
export const REASON_CROSS_CHECK_FAILED = 12;
/** Also used for the cost cap. */
export const REASON_WINDOW_UNAVAILABLE = 13;

/** Unknown causes in application order (§3.9), plus VOID for market legs (§3.11). */
export const LEG_CAUSES = ['MOTION', 'COVERAGE', 'OCCLUSION', 'CONF', 'IDENTITY', 'VOID'] as const;

/** Cost weights per node (§3.13). */
export const COST_COMBINATOR = 1;
export const COST_STATE_LEAF = 2;
export const COST_EVENT_LEAF = 4;
export const COST_DISAPPEARS_INTO = 12;

/** `rising(X)` at absolute frame 0 has no predecessor. */
export const FIRST_FRAME = 0;

// ---------------------------------------------------------------------------
// §6 Perception (non-consensus but deterministic)
// ---------------------------------------------------------------------------

/** Milliseconds per frame (1000 / FPS). */
export const FRAME_MS = 100;
/** Pose: `elbow_deg < 90` → rep_low; `elbow_deg > 160` → rep_high (§6.2). */
export const ELBOW_LOW_DEG = 90;
export const ELBOW_HIGH_DEG = 160;
/** Track ids in RawDetection are u16 (§6.1). */
export const MAX_TRACK_ID = 0xffff;
/** Label used for unbound person tracks in RawDetection (§6.1). */
export const RAW_PERSON_ENTITY = 'person';
/** Camera motion: median background flow > 1% of width for > 5 consecutive frames (§6.2). */
export const CAMERA_MOTION_FLOW_PCT = 1;
export const CAMERA_MOTION_MIN_FRAMES = 5;

/** §6.5 decisive-window extraction. */
export const WINDOW_PAD_FRAMES = 20;
export const ATTEMPT_WINDOW_TAIL_PAD = 10;
export const HOLDS_WINDOW_TAIL_PAD = 5;
/** Windows whose gap is < this are merged. */
export const WINDOW_MERGE_GAP = 10;
/** Widening step on post-condition failure. */
export const WINDOW_WIDEN_FRAMES = 20;
/** Widen retries before trying full coverage. */
export const WINDOW_WIDEN_RETRIES = 3;

// ---------------------------------------------------------------------------
// §4 / §7 / §8 / §10 Domain-separation tags (raw ASCII, no terminator)
// ---------------------------------------------------------------------------

export const TAG_ACCEPT_SIG = 'VERDICT/ACCEPT-SIG/v1';
export const TAG_ACCEPT = 'VERDICT/ACCEPT/v1';
export const TAG_TERMS = 'VERDICT/TERMS/v1';
export const TAG_CHAIN = 'VERDICT/CHAIN/v1';
export const TAG_CHUNK = 'VERDICT/CHUNK/v1';
export const TAG_CHUNK_SIG = 'VERDICT/CHUNK-SIG/v1';
export const TAG_PANEL = 'VERDICT/PANEL/v1';
export const TAG_JUDGE_COMMIT = 'VERDICT/JUDGE-COMMIT/v1';
/** `market_hash = sha256("gemini:" + event_id + ":" + contract_id)` (§4.2). */
export const MARKET_HASH_PREFIX = 'gemini:';
/** Mock chain deterministic slot hash seed: `sha256("mock-slot" ‖ u64 slot)` (§13). */
export const MOCK_SLOT_TAG = 'mock-slot';

/** Merkle prefixes (§7.3). Leaves are hashed by callers with 0x00. */
export const MERKLE_LEAF_PREFIX = 0x00;
export const MERKLE_NODE_PREFIX = 0x01;
/** Witness head index meaning "no chunks yet" (§7.4). */
export const HEAD_INDEX_NONE = 0xffffffff;

/** Witness kind codes (§7.1). */
export const WITNESS_KIND_CODE = { camera: 0, audio: 1, detections: 2 } as const;
/** Unused onchain witness kind slot (§9.3). */
export const WITNESS_KIND_UNUSED = 0xff;

// ---------------------------------------------------------------------------
// §7.5 Freshness beacon (16-FSK)
// ---------------------------------------------------------------------------

/** u64 slot ‖ hash[0..8] ‖ crc16 (BE). */
export const BEACON_PAYLOAD_BYTES = 18;
export const BEACON_HASH_PREFIX_BYTES = 8;
export const BEACON_TONE_BASE_HZ = 2000;
export const BEACON_TONE_STEP_HZ = 250;
export const BEACON_TONES = 16;
export const BEACON_SYMBOL_MS = 50;
export const BEACON_PREAMBLE = [0, 15, 0, 15, 0, 15] as const;
/** 6 preamble + 36 payload symbols = 2.10 s. */
export const BEACON_SYMBOLS = 42;
export const BEACON_SAMPLE_RATE = 48000;
/** Samples per symbol at 48 kHz. */
export const BEACON_SYMBOL_SAMPLES = 2400;
/** Linear ramp length at each symbol edge. */
export const BEACON_RAMP_SAMPLES = 240;
export const BEACON_AMPLITUDE = 0.25;
/** Decoder: Goertzel step and analysed middle span of each symbol. */
export const BEACON_DECODE_STEP_MS = 5;
export const BEACON_DECODE_MIDDLE_MS = 40;
export const BEACON_DECODE_MIN_RATE = 16000;
export const BEACON_DECODE_MAX_RATE = 48000;
/** CRC-16/CCITT-FALSE parameters. */
export const CRC16_POLY = 0x1021;
export const CRC16_INIT = 0xffff;

// ---------------------------------------------------------------------------
// §8 Identity
// ---------------------------------------------------------------------------

/** Modality codes (§8.6 public signal 5, BioCheck.modality). */
export const MODALITY_CODE = { face: 0, voice: 1 } as const;
export const EMB_CLAMP = 127;
/** u_i = q_i + 128 (§8.4). */
export const EMB_OFFSET = 128;
/** Field elements in the commitment packing: 6 × 31 bytes + 6 bytes (§8.4). */
export const PACK_FIELDS = 7;
export const PACK_BYTES_PER_FIELD = 31;
/** Salt is 31 uniformly random bytes, little-endian (§8.4). */
export const SALT_BYTES = 31;
/** BN254 scalar field modulus r. */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** BN254 base field modulus p (for proof_a y-negation, §8.6). */
export const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
/** Biometric public input count (§8.6). */
export const BIOMETRIC_PUBLIC_INPUTS = 8;

/** §8.5 fusion. */
export const FACE_SAMPLE_EVERY = 3;
export const REID_SIM_MIN_BPS = 7000;
export const REID_LOOKBACK_FRAMES = 50;
export const REID_INHERIT_NUM = 8000;
export const SCORE_DECAY_NUM = 9977;
export const FACE_NONMATCH_NUM = 7000;
export const SCORE_DEN = 10000;
export const OBS_WEIGHT_BASE = 1000;
export const OBS_WEIGHT_MAX = 4000;
export const CONF_SMOOTHING = 1000;
/** Max closed-set candidates in-game (M ≤ 10). */
export const MAX_CANDIDATES = MAX_HUDDLE;
/** Prover input: face observations within [frame - 30, frame] (§8.6). */
export const PROVER_FACE_LOOKBACK_FRAMES = 30;
/** Embedder enrollment: 3–5 face frames, 3 voice phrases (§8.2). */
export const ENROLL_FACE_MIN = 3;
export const ENROLL_FACE_MAX = 5;
export const ENROLL_VOICE_PHRASES = 3;

// ---------------------------------------------------------------------------
// §9 Onchain program
// ---------------------------------------------------------------------------

/** Bet state codes (§9.2). */
export const BET_STATE = {
  Proposed: 0,
  Funded: 1,
  Live: 2,
  Perceiving: 3,
  PreRuled: 4,
  Disputed: 5,
  Settled: 6,
  Refunded: 7,
} as const;
/** settle_path (§9.2). */
export const SETTLE_PATH = { none: 0, CONSENT: 1, RULE: 2, PANEL: 3, REFUND: 4 } as const;
/** dispute_reason (§9.2). */
export const DISPUTE_REASON = {
  wrong_outcome: 1,
  wrong_identity: 2,
  bad_tracking: 3,
  other: 4,
  LOW_CONFIDENCE: 10,
  AI_JUDGED: 11,
  CROSS_CHECK_FAILED: 12,
  WINDOW_UNAVAILABLE: 13,
} as const;
/** refund_reason (§9.2). */
export const REFUND_REASON = {
  fund_timeout: 1,
  no_contest: 2,
  start_timeout: 3,
  live_timeout: 4,
  perception_timeout: 5,
  panel_timeout: 6,
  cancelled: 7,
  consent_timeout: 8,
} as const;
/** Bet `flags` (§9.2). */
export const BET_FLAG_ANY_ACTOR_BOUND = 0x01;
export const BET_FLAG_AI_JUDGED = 0x02;
export const BET_FLAG_MARKET = 0x04;
/** tracks_finalized (§9.2). */
export const TRACKS_NOT_FINALIZED = 0;
export const TRACKS_FINALIZED = 1;
export const TRACKS_SP1_ONLY = 2;
/** settle_panel outcome (§9.4 #12, §10.3). */
export const PANEL_OUTCOME = { no_contest: 0, side0: 1, side1: 2 } as const;

/** Account sizes (§9.3), excluding the 8-byte discriminator. */
export const ANCHOR_DISCRIMINATOR_BYTES = 8;
export const PROFILE_ACCOUNT_BYTES = 179;
export const BET_ACCOUNT_BYTES = 1580;
export const TRACK_BUFFER_HEADER_BYTES = 48;
/** Payload offset in TrackBuffer account data (8 + 48). */
export const TRACK_BUFFER_PAYLOAD_OFFSET = 56;
export const MAX_ACCOUNT_DATA_BYTES = 10240;
export const PROFILE_NAME_BYTES = 32;
export const BIO_CHECK_BYTES = 6;
export const BET_RESERVED_BYTES = 64;
export const PROFILE_RESERVED_BYTES = 32;
export const BET_ACCOUNT_VERSION = 1;
export const JUDGES = 3;

/** PDA seeds (§9.1). */
export const SEED_PROFILE = 'profile';
export const SEED_BET = 'bet';
export const SEED_VAULT = 'vault';
export const SEED_TRACKS = 'tracks';
/** Discriminator preimage prefixes. */
export const DISC_ACCOUNT_PREFIX = 'account:';
export const DISC_GLOBAL_PREFIX = 'global:';
export const DISC_EVENT_PREFIX = 'event:';

/** External program / sysvar ids (§9.1, §9.7). */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';
export const INSTRUCTIONS_SYSVAR_ID = 'Sysvar1nstructions1111111111111111111111111';
export const SLOT_HASHES_SYSVAR_ID = 'SysvarS1otHashes111111111111111111111111111';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const CIRCLE_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** SlotHashes layout (§9.1). */
export const SLOT_HASHES_ENTRY_BYTES = 40;
export const SLOT_HASHES_MAX_ENTRIES = 512;

/** Compute budgets (§3.13, §9.4). */
export const RUN_RULES_CU = 1_400_000;
export const RUN_RULES_CU_BENCH_MAX = 1_200_000;
export const VERIFY_BIOMETRIC_CU = 300_000;
/** Max legacy transaction size (§9.1). */
export const MAX_TX_BYTES = 1232;

/** §9.7 panel message and Ed25519 instruction layout. */
export const PANEL_MESSAGE_BYTES = 145;
export const ED25519_PANEL_IX_BYTES = 367;
export const ED25519_OFFSET_UNUSED_INDEX = 0xffff;
export const ED25519_PANEL_OFFSETS = [
  {
    signature_offset: 62,
    public_key_offset: 30,
    message_data_offset: 222,
    message_data_size: 145,
  },
  {
    signature_offset: 158,
    public_key_offset: 126,
    message_data_offset: 222,
    message_data_size: 145,
  },
] as const;

/** sp1 public values: 5 × 32 hashes + preruling + reason + winner_mask + leg_results[8] (§9.4 #14). */
export const SP1_PUBLIC_VALUES_BYTES = 5 * 32 + 3 + 8;

/** Anchor error code base (§9.6). */
export const ERROR_CODE_BASE = 6000;
/** §9.6 error names, in order: code = ERROR_CODE_BASE + index. */
export const ERROR_CODES = [
  'InvalidState',
  'NotParticipant',
  'AlreadyFunded',
  'BadParticipants',
  'BadStake',
  'BadSides',
  'BadTimeLimit',
  'BadJudges',
  'CalibrationMismatch',
  'DeadlinePassed',
  'DeadlineNotReached',
  'Unauthorized',
  'BeaconSlotNotFound',
  'BeaconTooOld',
  'TooManyWitnesses',
  'EvidenceSeq',
  'EvidenceHeads',
  'EvidenceRegress',
  'BufferTooLarge',
  'BufferLayout',
  'BufferIncomplete',
  'ProgramHashMismatch',
  'CalibrationHashMismatch',
  'MalformedProgram',
  'MalformedCalibration',
  'MalformedTracks',
  'ProgramBetMismatch',
  'TracksNotFinalized',
  'AlreadyConsented',
  'ConsentMismatch',
  'InsufficientQuorum',
  'BadOutcome',
  'BadProof',
  'TauTooLow',
  'MissingCommitment',
  'TooManyCheckpoints',
  'Sp1Disabled',
  'BadTokenAccount',
  'MathOverflow',
  'NotRefundable',
  'BadReason',
  'BadCommitment',
  'ProfileTooNew',
  'BadEd25519Instruction',
  'BadFlags',
] as const;

/** §9.4 instruction names, in table order. */
export const INSTRUCTION_NAMES = [
  'init_profile',
  'create_bet',
  'fund',
  'cancel',
  'start',
  'commit_evidence',
  'end',
  'post_tracks',
  'run_rules',
  'consent',
  'dispute',
  'settle_panel',
  'verify_biometric_proof',
  'verify_sp1_run',
  'refund',
] as const;

/** §9.5 event names, in table order. */
export const EVENT_NAMES = [
  'ProfileUpdated',
  'BetCreated',
  'Funded',
  'BetCancelled',
  'BetStarted',
  'EvidenceCommitted',
  'BetEnded',
  'TracksPosted',
  'BiometricVerified',
  'PreRuled',
  'Consented',
  'Disputed',
  'Settled',
  'Refunded',
] as const;

// ---------------------------------------------------------------------------
// §10 Replay booth, §11 World Mode, §12 display, §13 mocks
// ---------------------------------------------------------------------------

/** Judge collection timeout (§10.4). */
export const JUDGE_COMMIT_TIMEOUT_S = 120;
/** Exhibit span around a decisive frame (§10.1). */
export const EXHIBIT_PAD_MS = 2000;
/** AI-judged / no decisive frame: last 6 s; up to 4 evenly spaced 4 s clips (§10.1). */
export const EXHIBIT_TAIL_MS = 6000;
export const EXHIBIT_EXTRA_CLIPS = 4;
export const EXHIBIT_EXTRA_CLIP_MS = 4000;
/** Judge frame sampling for J1/J2 (§10.3). */
export const JUDGE_FRAME_SAMPLE_FPS = 2;
export const ADVOCATE_CLAIM_MAX_CHARS = 600;
export const JUDGE_RATIONALE_MAX_CHARS = 1000;
/** Exhibit slots per advocate (+1 with a side-owned camera witness) (§10.2). */
export const ADVOCATE_EXHIBIT_SLOTS = 3;
export const CITATION_RE = /^(cam|mic)[1-8]@[0-9]{1,5}(\.[0-9])?s$/;
/** Mock judges (§13). */
export const MOCK_JUDGE_CONF_BPS = 8000;
export const MOCK_JUDGE_AI_CONF_BPS = 7000;

/** Market time limit: ceil((close - now)/1000) + 1 day (§11.4). */
export const MARKET_RESOLUTION_GRACE_S = 86400;
/** Market stake granularity: whole cents (§11.2). */
export const STAKE_GRANULARITY_UNITS = 10000;
export const BPS_DENOM = 10000;
export const MARKET_TITLE_MAX_CHARS = 40;
export const DRAFT_TITLE_MAX_CHARS = 40;

/** USDC base units per dollar (§0.2). */
export const USDC_UNITS = 1000000;
/** Unicode minus used for negative money (§12.9). */
export const MONEY_MINUS = '−';

/** MOCK_SCENARIO values (§13). */
export const MOCK_SCENARIOS = [
  'pass',
  'fail',
  'cross_fail',
  'motion',
  'low_conf',
  'no_identity',
  'oversize',
  'occlusion',
] as const;

// ---------------------------------------------------------------------------
// Public `CONSTANTS` object (§14)
// ---------------------------------------------------------------------------

/** The value exported as `CONSTANTS` from the engine entry point. */
export const CONSTANTS = GLOBAL_CONSTANTS;
