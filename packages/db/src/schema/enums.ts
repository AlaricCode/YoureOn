// Postgres enum types, DATA-MODEL §4. Values and declaration order must equal the Zod
// enums in packages/shared (SCHEMAS §0.3): the code compares bet_state and onchain_status
// with < / >=, so never reorder. All of §4 is declared here (and created by migration
// 0000) so later streams only add tables.
import { pgEnum } from 'drizzle-orm/pg-core';

export const platform = pgEnum('platform', ['ios']);
export const deviceRole = pgEnum('device_role', ['phone', 'judge_cam']);
export const walletKind = pgEnum('wallet_kind', ['device_keypair', 'embedded_provider']);
export const enrollmentStatus = pgEnum('enrollment_status', ['active', 'disabled']);
export const livenessMethod = pgEnum('liveness_method', ['blink', 'head_turn']);
export const roomKind = pgEnum('room_kind', ['demo', 'nearby', 'session']);
export const joinMethod = pgEnum('join_method', ['code', 'qr', 'nearby', 'link', 'demo_seed']);
export const challengeMethod = pgEnum('challenge_method', ['face', 'list', 'link']);
export const evidenceSource = pgEnum('evidence_source', ['camera', 'gemini']);
export const betState = pgEnum('bet_state', [
  'DRAFTING',
  'TERMS_PROPOSED',
  'AWAITING_AUTHORIZATIONS',
  'AWAITING_LOCK',
  'LOCKED',
  'ATTEMPT',
  'JUDGING',
  'HEARING',
  'AWAITING_MARKET',
  'RULED',
  'CONCEDED',
  'FINALIZED',
  'APPEALED',
  'APPEAL_RESOLVED',
  'PAID',
  'VOIDED',
  'CANCELLED',
  'EXPIRED',
]);
export const betEndReason = pgEnum('bet_end_reason', [
  'refused',
  'declined',
  'terms_changed',
  'cancelled',
  'draft_idle',
  'quote_expired',
  'accept_timeout',
  'resolve_timeout',
  'appeal_timeout',
  'lock_failed',
]);
export const lockMode = pgEnum('lock_mode', ['atomic', 'sequential']);
export const authorizationMethod = pgEnum('authorization_method', ['faceid_hold', 'passcode_hold']);
export const onchainStatus = pgEnum('onchain_status', [
  'none',
  'open',
  'locked',
  'resolved',
  'appealed',
  'settled',
  'refunded',
  'cancelled',
]);
export const onchainOutcome = pgEnum('onchain_outcome', ['party_a', 'party_b', 'split', 'refund']);
export const payoutVia = pgEnum('payout_via', [
  'concede',
  'finalize',
  'resolve_appeal',
  'timeout_refund',
  'cancel_open_bet',
]);
export const chainIx = pgEnum('chain_ix', [
  'create_bet',
  'accept_bet',
  'cancel_open_bet',
  'resolve',
  'concede',
  'appeal',
  'resolve_appeal',
  'finalize',
  'timeout_refund',
  'close_bet',
]);
export const txKind = pgEnum('tx_kind', [
  'atomic_lock',
  'create_bet',
  'accept_bet',
  'cancel_open_bet',
  'resolve',
  'concede',
  'appeal',
  'resolve_appeal',
  'finalize',
  'timeout_refund',
  'close_bet',
  'nonce_advance',
]);
export const txStatus = pgEnum('tx_status', [
  'built',
  'signed',
  'sent',
  'confirmed',
  'failed',
  'expired',
  'revoked',
]);
export const nonceStatus = pgEnum('nonce_status', ['free', 'leased', 'advancing', 'retired']);
export const chainEventSource = pgEnum('chain_event_source', ['stream', 'rpc_poll']);
export const rulingOutcome = pgEnum('ruling_outcome', ['A_WINS', 'B_WINS', 'REDO', 'VOID']);
export const rulingStage = pgEnum('ruling_stage', ['attempt', 'settlement', 'hearing', 'appeal']);
export const redoReason = pgEnum('redo_reason', ['unclear', 'low_confidence', 'contested']);
export const rulingVoidReason = pgEnum('ruling_void_reason', [
  'undecidable',
  'max_redos',
  'market_invalid',
  'safety_stop',
]);
export const claimResult = pgEnum('claim_result', ['MET', 'NOT_MET', 'UNCLEAR']);
export const party = pgEnum('party', ['A', 'B']);
export const attemptStatus = pgEnum('attempt_status', [
  'recording',
  'uploaded',
  'judging',
  'ruled',
  'redo',
  'failed',
]);
export const voicePurpose = pgEnum('voice_purpose', ['terms', 'hearing', 'announce']);
export const sessionStatus = pgEnum('session_status', ['active', 'ended', 'failed']);
export const hearingTrigger = pgEnum('hearing_trigger', ['contested', 'max_redos', 'demo']);
export const hearingStatus = pgEnum('hearing_status', ['open', 'closed', 'aborted']);
export const appealStatus = pgEnum('appeal_status', [
  'filing',
  'panel_voting',
  'decided',
  'failed',
]);
export const panelProvider = pgEnum('panel_provider', ['anthropic', 'openai', 'google']);
export const voteStatus = pgEnum('vote_status', ['ok', 'error', 'timeout']);
export const voteCountedAs = pgEnum('vote_counted_as', ['A_WINS', 'B_WINS', 'ABSTAIN']);
export const appealDecidedBy = pgEnum('appeal_decided_by', ['majority', 'upheld_no_majority']);
export const marketSide = pgEnum('market_side', ['yes', 'no']);
export const marketStatus = pgEnum('market_status', [
  'approved',
  'active',
  'closed',
  'under_review',
  'settled',
  'invalid',
]);
export const outboxStatus = pgEnum('outbox_status', ['pending', 'sent', 'failed', 'dead']);
export const actorKind = pgEnum('actor_kind', ['user', 'server', 'judge', 'panel', 'system']);
