/**
 * Per-witness hash chains (§7.2).
 *
 *   G_w   = sha256("VERDICT/CHAIN/v1" ‖ bet[32] ‖ witness_key[32] ‖ u8 kind ‖ u64 beacon_slot ‖ beacon_hash[32])
 *   c_i   = sha256("VERDICT/CHUNK/v1" ‖ prev[32] ‖ u32 i ‖ u8 kind ‖ i64 start_ms ‖ u32 duration_ms ‖ sha256(body)[32])
 *   sig_i = ed25519_sign(witness_key, "VERDICT/CHUNK-SIG/v1" ‖ c_i)
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { CHUNK_GAP_MAX_MS, TAG_CHAIN, TAG_CHUNK, TAG_CHUNK_SIG } from '../constants.js';
import type { ChainGenesisArgs, ChunkHashArgs, Pubkey, WitnessKindCode } from '../types.js';
import {
  ascii,
  bytesEqual,
  concatBytes,
  expectLen,
  i64le,
  pubkeyBytes,
  sha256Bytes,
  u32le,
  u64le,
  u8,
} from './bytes.js';

function checkKind(kind: number): void {
  if (kind !== 0 && kind !== 1 && kind !== 2) throw new RangeError(`witness kind must be 0..2, got ${kind}`);
}

/** Chain genesis `G_w` (§7.2). `bet` and `witness_key` are base58 (or 32 raw bytes). */
export function chainGenesis(args: ChainGenesisArgs): Uint8Array {
  checkKind(args.kind);
  return sha256Bytes(
    concatBytes(
      ascii(TAG_CHAIN),
      pubkeyBytes(args.bet, 'bet'),
      pubkeyBytes(args.witness_key, 'witness_key'),
      u8(args.kind),
      u64le(args.beacon_slot),
      expectLen(args.beacon_hash, 32, 'beacon_hash'),
    ),
  );
}

/** Chunk link `c_i` (§7.2). */
export function chunkHash(args: ChunkHashArgs): Uint8Array {
  checkKind(args.kind);
  return sha256Bytes(
    concatBytes(
      ascii(TAG_CHUNK),
      expectLen(args.prev, 32, 'prev'),
      u32le(args.index),
      u8(args.kind),
      i64le(args.start_ms),
      u32le(args.duration_ms),
      expectLen(args.body_sha256, 32, 'body_sha256'),
    ),
  );
}

/** The message a witness signs for chunk hash `c` (§7.2): `"VERDICT/CHUNK-SIG/v1" ‖ c`. */
export function chunkSigMessage(c: Uint8Array): Uint8Array {
  return concatBytes(ascii(TAG_CHUNK_SIG), expectLen(c, 32, 'chunk hash'));
}

/** Verifies `sig_i` against the witness key. Never throws on bad signatures. */
export function verifyChunkSig(witnessKey: Pubkey | Uint8Array, c: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, chunkSigMessage(c), pubkeyBytes(witnessKey, 'witness_key'));
  } catch {
    return false;
  }
}

/** One chunk hash record as uploaded (§12.3 `POST /bets/:id/chunks`), decoded to bytes. */
export interface ChunkRecord {
  index: number;
  kind: WitnessKindCode;
  start_ms: number;
  duration_ms: number;
  /** sha256(body), 32 bytes */
  body_sha256: Uint8Array;
  /** c_i claimed by the witness */
  chunk_hash: Uint8Array;
  /** prev claimed by the witness (G_w or c_{i-1}) */
  prev_hash: Uint8Array;
  /** ed25519 signature over chunkSigMessage(c_i), optional */
  sig?: Uint8Array;
}

export type ChainIssue =
  | { index: number; kind: 'index' }
  | { index: number; kind: 'witness_kind' }
  | { index: number; kind: 'prev' }
  | { index: number; kind: 'hash' }
  | { index: number; kind: 'sig' }
  | { index: number; kind: 'start' }
  | { index: number; kind: 'overlap' };

export interface ChainVerification {
  /** true iff no issues (large gaps are reported separately in `gap`) */
  ok: boolean;
  /** number of leading chunks that form a valid chain from G_w */
  valid_prefix: number;
  /** head (index, hash) of the valid prefix; index 0xFFFFFFFF and hash G_w when empty */
  head: { index: number; hash: Uint8Array };
  /** inter-chunk gaps 0 < gap ≤ CHUNK_GAP_MAX_MS (tolerated, reported) */
  gaps_ms: number[];
  /** true if any gap exceeds CHUNK_GAP_MAX_MS */
  gap: boolean;
  issues: ChainIssue[];
}

/**
 * Verifies a witness's chunk records (sorted by index) against `G_w`: indices
 * gap-free from 0, constant kind, `prev` linkage, recomputed `c_i`, optional
 * signatures (checked when `witnessKey` is given), chunk 0 at `start_ms = 0`,
 * and the timing gaps of §7.2.
 */
export function verifyChain(
  genesis: Uint8Array,
  kind: WitnessKindCode,
  records: ChunkRecord[],
  witnessKey?: Pubkey | Uint8Array,
): ChainVerification {
  expectLen(genesis, 32, 'genesis');
  const issues: ChainIssue[] = [];
  const gaps: number[] = [];
  let gap = false;
  let prev = genesis;
  let validPrefix = 0;
  let broken = false;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    let bad = false;
    if (r.index !== i) {
      issues.push({ index: r.index, kind: 'index' });
      bad = true;
    }
    if (r.kind !== kind) {
      issues.push({ index: r.index, kind: 'witness_kind' });
      bad = true;
    }
    if (!bytesEqual(r.prev_hash, prev)) {
      issues.push({ index: r.index, kind: 'prev' });
      bad = true;
    }
    let c: Uint8Array | null = null;
    try {
      c = chunkHash({
        prev,
        index: i,
        kind,
        start_ms: r.start_ms,
        duration_ms: r.duration_ms,
        body_sha256: r.body_sha256,
      });
    } catch {
      c = null;
    }
    if (c === null || !bytesEqual(c, r.chunk_hash)) {
      issues.push({ index: r.index, kind: 'hash' });
      bad = true;
    }
    if (witnessKey !== undefined && (r.sig === undefined || !verifyChunkSig(witnessKey, r.chunk_hash, r.sig))) {
      issues.push({ index: r.index, kind: 'sig' });
      bad = true;
    }
    if (i === 0 && r.start_ms !== 0) issues.push({ index: r.index, kind: 'start' });
    if (i > 0) {
      const p = records[i - 1]!;
      const g = r.start_ms - (p.start_ms + p.duration_ms);
      if (g < 0) issues.push({ index: r.index, kind: 'overlap' });
      else if (g > CHUNK_GAP_MAX_MS) gap = true;
      else if (g > 0) gaps.push(g);
    }
    if (bad) broken = true;
    if (!broken) {
      validPrefix = i + 1;
      prev = r.chunk_hash;
    } else {
      // keep following the claimed linkage so later issues are still reported
      prev = r.chunk_hash;
    }
  }
  const head =
    validPrefix === 0
      ? { index: 0xffffffff, hash: genesis }
      : { index: validPrefix - 1, hash: records[validPrefix - 1]!.chunk_hash };
  return { ok: issues.length === 0, valid_prefix: validPrefix, head, gaps_ms: gaps, gap, issues };
}
