/**
 * The `bets` mirror (§12.7): one record per Bet PDA created through
 * `POST /bets`, written by the bets module and read by the lifecycle
 * (lifecycle/betInfo.ts), the booth and the receipt (integration/sources.ts).
 * Field names follow CONTRACTS-ERRATA bet-lifecycle-1 / identity-huddle-8.
 * The chain stays the source of truth for everything consensus-relevant.
 */
import type { Calibration, Program } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { COLLECTIONS } from '../persistence/records.js';
import type { Collection } from '../persistence/store.js';

export interface BetAcceptanceMirror {
  user_id: string;
  accepted: boolean;
  voice_cos_bps: number | null;
}

export interface BetMirrorRecord {
  /** Bet PDA (base58) */
  id: string;
  /** same as id (read-seam alias used by integration/sources.ts) */
  bet: string;
  draft_id: string;
  huddle_id: string;
  creator_user_id: string;
  kind: 'rules' | 'ai_judged';
  title: string;
  program: Program;
  program_hash: string;
  yaml: string | null;
  readback: string[];
  labels: Record<string, string>;
  /** creator's dictation (ai_judged judges see it) */
  transcript: string | null;
  /** u64 nonce, decimal string */
  nonce: string;
  acceptance_audio_hash: string;
  create_tx_id: string;
  /** create_bet confirmed (chain account exists) */
  created: boolean;
  /** §8.5 candidates frozen at POST /bets: participants first, then other enrolled confirmed members */
  candidate_user_ids: string[];
  acceptances: BetAcceptanceMirror[];
  /** mirrored by PUT /calibration (lifecycle) */
  calibration?: Calibration | null;
  calibration_hash?: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export function betMirror(ctx: AppContext): Collection<BetMirrorRecord> {
  return ctx.store.collection<BetMirrorRecord>(COLLECTIONS.bets);
}
