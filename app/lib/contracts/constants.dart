// Global constants, CONTRACTS.md §0.5.
//
// Mirrors packages/engine/src/constants.ts. `npm run gen:dart` regenerates
// this file from the engine; the names and values are the contract's.
// ignore_for_file: constant_identifier_names

/// track frame rate
const int FPS = 10;
const int COORD_MAX = 10000;
/// per bet
const int MAX_PARTICIPANTS = 8;
const int MIN_PARTICIPANTS = 2;
/// huddle members (spec §5.3)
const int MAX_HUDDLE = 10;
const int MAX_ENTITIES = 16;
const int MAX_LEGS = 8;
/// per encoded leg expression
const int MAX_EXPR_BYTES = 512;
/// per leg expression (node = op byte)
const int MAX_EXPR_NODES = 64;
/// leaf depth = 1
const int MAX_EXPR_DEPTH = 12;
/// outcome condition
const int MAX_COND_NODES = 32;
/// decisive windows per TrackBuffer
const int MAX_SEGMENTS = 16;
/// bytes in TrackBuffer payload; MUST satisfy 8 + 48 + MAX_BUFFER_PAYLOAD ≤ 10240, so never raise above 10184
const int MAX_BUFFER_PAYLOAD = 10000;
/// total buffer frames Σ n_frames
const int MAX_EVAL_FRAMES = 1024;
/// evaluation cost cap (§3.13; was 16384, see D-47)
const int MAX_EVAL_COST = 8192;
/// frames charged per unit of weight for per-node set-up: cost = (|F| + EVAL_COST_SETUP_FRAMES) × Σw (§3.13)
const int EVAL_COST_SETUP_FRAMES = 4;
/// max data bytes per post_tracks instruction
const int POST_TRACKS_CHUNK = 700;
const int MAX_WITNESSES = 8;
/// identity checkpoints per bet
const int MAX_CHECKPOINTS = 8;
/// record conf (%) below which an entity is treated as absent
const int PRESENCE_MIN = 30;
/// conf (%) required at decisive frames
const int DECISIVE_CONF_MIN = 50;
/// identity confidence (%) at checkpoints
const int ID_CONF_MIN = 60;
/// frames between velocity samples
const int VEL_K = 2;
/// moving threshold
const int MOVE_MIN_UPS = 300;
/// still threshold (used by at_rest); vectors at 1 px and 5 px jitter
const int STILL_MAX_UPS = 250;
/// default near distance
const int NEAR_DEFAULT = 500;
/// max near distance
const int NEAR_MAX = 14143;
/// max speed comparison value
const int SPEED_MAX = 100000;
/// max rep_count value and count k
const int REPS_MAX = 1000;
/// within attempts N (actor-bound legs: 8)
const int ATTEMPTS_MAX = 20;
/// held frames required before release
const int RELEASE_HOLD = 2;
/// max frames between presence samples (lastSeen, release, crossing)
const int RELEASE_GAP = 3;
/// person bbox expansion for "held"
const int HAND_EXPAND_PCT = 10;
/// frames (1 s) an object must stay unseen-outside after disappears_into
const int DISAPPEAR_FRAMES = 10;
/// frames
const int DESCEND_LOOKBACK = 3;
/// how long a derived region survives its object's absence
const int STALE_REGION_FRAMES = 30;
/// intact height threshold
const int INTACT_PCT = 75;
/// frames (5 s)
const int ATTEMPT_WINDOW_DEFAULT = 50;
/// recording continues after End; look-ahead-only frames
const int TAIL_MS = 2000;
/// recording continues after End; look-ahead-only frames
const int TAIL_FRAMES = 20;
/// max interior gap filled by quantizeSession (non-consensus)
const int OCCLUSION_FILL_FRAMES = 3;
/// object entity absence after its track ends (> DISAPPEAR_FRAMES)
const int REBIND_DELAY_FRAMES = 15;
/// UI latch for event rows (scene check, practice)
const int PULSE_LATCH_FRAMES = 10;
/// compiler default
const int DEFAULT_TIME_LIMIT_S = 120;
/// rules / ai_judged programs
const int TIME_LIMIT_MAX_S = 3600;
/// market programs (30 days)
const int MARKET_TIME_LIMIT_MAX_S = 2592000;
/// $0.01, every stake
const int MIN_STAKE_UNITS = 10000;
const int MAX_STAKE_UNITS = 1000000000000;
/// Proposed → refundable after
const int FUND_WINDOW_S = 900;
/// Funded → refundable after
const int START_WINDOW_S = 900;
/// Live past time limit → refundable after
const int LIVE_GRACE_S = 300;
/// Perceiving → refundable after
const int PERCEPTION_TIMEOUT_S = 3600;
/// PreRuled consent/dispute window
const int CONSENT_WINDOW_S = 120;
/// Disputed → refundable after; also PreRuled stuck escape
const int PANEL_TIMEOUT_S = 3600;
const int BEACON_MAX_AGE_SLOTS = 150;
/// start sound plays this long after the WS start message
const int PLAY_DELAY_MS = 1500;
/// target
const int EVIDENCE_COMMIT_INTERVAL_S = 30;
/// larger gap sets all witness gap bits
const int EVIDENCE_MAX_GAP_S = 90;
const int CHUNK_MS = 5000;
/// hash record later than chunk end + this ⇒ late (advisory)
const int CHUNK_LATE_MS = 10000;
/// tolerated inter-chunk gap (shown as gaps_ms)
const int CHUNK_GAP_MAX_MS = 500;
/// 20 MiB
const int MAX_CHUNK_BODY_BYTES = 20971520;
const int MAX_CHUNKS_PER_COMMIT = 24;
/// bond = max(min_i stakes[i] / 5, DISPUTE_BOND_MIN)
const int DISPUTE_BOND_DIV = 5;
/// 0.10 USDC
const int DISPUTE_BOND_MIN = 100000;
const int FACE_DIM = 128;
const int VOICE_DIM = 192;
const int CIRCUIT_DIM = 192;
const int EMB_SCALE = 512;
const int TAU_FACE_BPS = 5500;
const int DELTA_FACE_BPS = 1000;
const int TAU_VOICE_BPS = 5000;
const int DELTA_VOICE_BPS = 1000;
/// perception cross-check
const int IOU_AGREE_BPS = 5000;
const int TRACK_AGREE_BPS = 9000;
const int EVENT_TOL_FRAMES = 3;
const int PANEL_CONF_FLOOR_BPS = 6000;
/// World Mode
const int PROB_CLAMP_MIN_BPS = 100;
/// World Mode
const int PROB_CLAMP_MAX_BPS = 9900;
const int MAX_PARLAY_LEGS = 4;
/// "Camera moved" warning
const int CAMERA_POSE_DRIFT_CDEG = 300;
/// pay closed set window
const int RECENT_HUDDLE_S = 86400;
/// §12.6
const int KEEPER_INTERVAL_S = 5;
/// demo drip
const int FAUCET_UNITS = 50000000;
