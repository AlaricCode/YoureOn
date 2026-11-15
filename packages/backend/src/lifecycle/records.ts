/**
 * Persisted records of the bet-lifecycle service (§12.7): scene check,
 * witnesses, chunk hash records, the live/evidence state and the perception
 * orchestrator state. All plain JSON (u64 as decimal strings, bytes as
 * hex/base64).
 */
import type { Calibration, CrossCheckResult, WitnessKind } from '@verdict/engine';
import { COLLECTIONS } from '../persistence/records.js';

export const LC_COLLECTIONS = {
  scenes: 'scenes',
  witnesses: COLLECTIONS.witnesses,
  chunks: COLLECTIONS.chunks,
  live: 'bet_live',
  perception: 'perception',
  chunkArchive: 'chunks_archive',
} as const;

/** Chunk records of a terminal bet, moved out of the hot `chunks` collection at close-out. */
export interface ChunkArchiveRecord {
  bet: string;
  chunks: ChunkMetaRecord[];
  archived_at_ms: number;
}

/** Scene check state (§5.2, §12.3 calibration / crops). */
export interface SceneRecord {
  bet: string;
  calibration: Calibration | null;
  /** hex sha256(calibration_bin); null until a calibration is stored */
  calibration_hash: string | null;
  /** entity → sha256 hex of the uploaded crop JPEG */
  crops: Record<string, string>;
  updated_at_ms: number;
  /**
   * Every validated calibration by hash. Once the first `fund` commits a
   * calibration_hash onchain, that entry (not the latest PUT) is the scene.
   */
  history?: Record<string, Calibration>;
}

export interface WitnessRecord {
  /** base58 ed25519 witness key (fresh per bet, §7.1) */
  witness_key: string;
  kind: WitnessKind;
  /** 0 camera / 1 audio / 2 detections */
  kind_code: 0 | 1 | 2;
  user_id: string;
  /** "cam1".."cam8", "mic1".."mic8", "det1".."det8" (numbered per kind in witness order) */
  label: string;
  registered_at_ms: number;
  /** WS `recording` arrival (wall ms), null until reported */
  recording_at_ms: number | null;
  /** a chunk with `final: true` was recorded */
  final: boolean;
  /** device-local ms of t0 (§7.5); null while unsynced */
  offset_ms: number | null;
  /** null = not attempted yet, false = beacon not decodable */
  synced: boolean | null;
  /** where the offset came from: "beacon" or the witness key of the same-device audio witness */
  offset_source: string | null;
}

export interface WitnessListRecord {
  bet: string;
  witnesses: WitnessRecord[];
  /** true once `start` fixed the list onchain */
  frozen: boolean;
}

/** One chunk hash record (§7.2, §12.3 POST /bets/:id/chunks). Key `${bet}:${witness}:${index}`. */
export interface ChunkMetaRecord {
  id: string;
  bet: string;
  witness_key: string;
  index: number;
  kind: 0 | 1 | 2;
  body_format: 'mp4' | 'mjpeg' | 'wav' | 'json';
  width_px: number | null;
  height_px: number | null;
  orientation: 'landscape' | 'portrait' | null;
  start_ms: number;
  duration_ms: number;
  body_sha256: string;
  chunk_hash: string;
  prev_hash: string;
  sig_b64: string;
  final: boolean;
  received_at_ms: number;
  /** advisory (§7.2): hash record later than the beacon-aligned chunk end + CHUNK_LATE_MS */
  late: boolean;
  /** wall ms the body arrived (null until uploaded) */
  body_at_ms: number | null;
}

/** Live / evidence state of a bet (start, beacon, rolling commits, end). */
export interface LiveRecord {
  bet: string;
  started_at_ms: number;
  start_signature: string;
  beacon: { slot: string; hash_hex: string; symbols: number[] } | null;
  play_on_user_id: string | null;
  /** server-side estimate of t0 (wall ms): WS start + PLAY_DELAY_MS + start sound + tones */
  t0_ms: number | null;
  /** POST /end or the keeper's time-limit trigger (wall ms) */
  end_requested_at_ms: number | null;
  end_requested_by: string | null;
  ended_at_ms: number | null;
  end_signature: string | null;
  /** last commit_evidence we sent (wall ms) */
  last_commit_ms: number | null;
  commits: number;
}

export type ProofStatus = 'pending' | 'verified' | 'failed' | 'skipped';

export interface ProofPlan {
  participant: number;
  frame: number;
  modality: 'face' | 'voice';
  tau_bps: number;
  /** quantized observed embedding (i8 values) used as the circuit's private input */
  observed: number[];
  status: ProofStatus;
  signature: string | null;
  error: string | null;
}

export type PerceptionStep = 'pending' | 'sealed' | 'posted' | 'proved' | 'ruled' | 'failed';

export interface PerceptionHostInfo {
  provider: string;
  job_id: string;
  url: string | null;
  network: 'mainnet' | 'mock';
  model_hash: string;
}

/** Perception orchestrator state (§6, §8.6, §9.4 #8/#9/#13); resumable per step. */
export interface PerceptionRecord {
  bet: string;
  step: PerceptionStep;
  attempts: number;
  error: string | null;
  hosts: PerceptionHostInfo[];
  cross: CrossCheckResult | null;
  /** final track_bin flags (incl. advisory bits) */
  flags: number;
  model_hash: string | null;
  perception_root: string;
  window_unavailable: boolean;
  audio_disagree: boolean;
  phone_disagree: boolean;
  /** TrackBuffer payload (program_bin ‖ calibration_bin ‖ track_bin | market_bin), base64 */
  payload_b64: string | null;
  program_len: number;
  calibration_len: number;
  /** n_frames of the sealed session (0 for ai_judged/market) */
  n_frames: number;
  /** the local evaluation of the posted buffer with all planned proofs verified */
  expected: { preruling: number; reason: number; winner_mask: number; leg_results: number[] } | null;
  proofs: ProofPlan[];
  posted_signatures: string[];
  run_rules_signature: string | null;
  started_at_ms: number;
  updated_at_ms: number;
}
