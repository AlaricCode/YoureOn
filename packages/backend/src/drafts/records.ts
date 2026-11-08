/**
 * Draft records (persisted in the `drafts` collection) and the §12.2
 * DraftView shape.
 */
import type { CompileError, Program } from '@verdict/engine';
import type { Question } from '../providers/types.js';

export type DraftStatus = 'needs_clarification' | 'ready' | 'invalid';
export type DraftKind = 'rules' | 'ai_judged' | 'market';

export interface AcceptanceRecord {
  user_id: string;
  participant_index: number;
  /** program_hash the acceptance signed */
  program_hash: string;
  /** sha256(wav_i) hex (§4.2) */
  wav_sha256: string;
  accept_sig_b64: string;
  cos_bps: number;
  at_ms: number;
}

/** Explicit Who/What/Stake/Limit chip choices (PATCH /drafts/:id). */
export interface DraftOverrides {
  stake_each_units?: number;
  time_limit_s?: number;
  /** user ids; the draft creator is always participant 0 */
  participants?: string[];
  /** user id → side */
  sides?: Record<string, 0 | 1>;
}

export interface DraftBetRef {
  address: string;
  /** u64 nonce, decimal string */
  nonce: string;
  tx_id: string;
  status: 'pending' | 'confirmed';
  program_hash: string;
}

export interface DraftRecord {
  id: string;
  huddle_id: string;
  creator_user_id: string;
  status: DraftStatus;
  kind: DraftKind;
  title: string | null;
  questions: Question[];
  /** compiler output (surface YAML), for recompiles */
  source_yaml: string | null;
  /** canonical YAML (engine.toYaml) */
  yaml: string | null;
  program: Program | null;
  program_hash: string | null;
  readback: string[] | null;
  labels: Record<string, string>;
  errors: CompileError[];
  warnings: CompileError[];
  /** accumulated dictation transcript */
  transcript: string;
  answers: { question_id: string; answer: string }[];
  /** sha256 hex of the creator's latest dictation WAV (h_0); null when typed */
  dictation_sha256: string | null;
  /** user_id → acceptance */
  acceptances: Record<string, AcceptanceRecord>;
  /** chip choices made before a program existed, applied after the next compile */
  pending_overrides: DraftOverrides | null;
  compile_source: string | null;
  compile_attempts: number;
  bet: DraftBetRef | null;
  created_at_ms: number;
  updated_at_ms: number;
}

/** §12.2 DraftView */
export interface DraftView {
  draft_id: string;
  huddle_id: string;
  status: DraftStatus;
  kind: DraftKind;
  title: string | null;
  questions: Question[];
  program?: Program;
  yaml?: string;
  readback?: string[];
  program_hash?: string;
  labels: Record<string, string>;
  participants: { user_id: string; display_name: string; side: 0 | 1; accepted: boolean; is_creator: boolean }[];
  errors?: CompileError[];
  warnings?: CompileError[];
  frozen: boolean;
  readback_audio_url: string | null;
  updated_at_ms: number;
}

/** Acceptances that are valid for the draft's current program. */
export function liveAcceptances(d: DraftRecord): AcceptanceRecord[] {
  if (!d.program_hash) return [];
  return Object.values(d.acceptances).filter((a) => a.program_hash === d.program_hash);
}

export function isFrozen(d: DraftRecord): boolean {
  return liveAcceptances(d).length > 0 || d.bet?.status === 'confirmed';
}
