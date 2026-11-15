/**
 * §9.3 account layouts: Bet (8 + 1580), Profile (8 + 179), TrackBuffer header (48).
 * Encoders emit the 8-byte Anchor discriminator followed by the Borsh body.
 * Decoders require the discriminator, the exact size, valid bools/enums and
 * zero reserved bytes (§0.1).
 */
import {
  BET_ACCOUNT_BYTES,
  BET_RESERVED_BYTES,
  DISC_ACCOUNT_PREFIX,
  MAX_CHECKPOINTS,
  MAX_PARTICIPANTS,
  MAX_WITNESSES,
  PROFILE_ACCOUNT_BYTES,
  PROFILE_NAME_BYTES,
  PROFILE_RESERVED_BYTES,
  TRACK_BUFFER_HEADER_BYTES,
} from '../constants.js';
import type {
  BetAccount,
  BetStateCode,
  DisputeReasonCode,
  ModalityCode,
  PrerulingCode,
  ProfileAccount,
  RefundReasonCode,
  SettlePathCode,
  TrackBufferHeader,
  TracksFinalizedCode,
} from '../types.js';
import { BorshReader, BorshWriter, bytesEqual, discriminator, fromHex, isZero, utf8, ZERO_HASH, ZERO_KEY } from './bytes.js';

export const BET_DISCRIMINATOR = discriminator(DISC_ACCOUNT_PREFIX, 'Bet');
export const PROFILE_DISCRIMINATOR = discriminator(DISC_ACCOUNT_PREFIX, 'Profile');
export const TRACK_BUFFER_DISCRIMINATOR = discriminator(DISC_ACCOUNT_PREFIX, 'TrackBuffer');

const zeros = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

/** A zero-initialised Bet (account allocated, before `create_bet` writes it). */
export function zeroBet(bump = 0, vaultBump = 0): BetAccount {
  return {
    version: 0,
    bump,
    vault_bump: vaultBump,
    state: 0,
    flags: 0,
    creator: ZERO_KEY,
    nonce: 0n,
    mint: ZERO_KEY,
    oracle: ZERO_KEY,
    judges: zeros(3, ZERO_KEY),
    n_participants: 0,
    participants: zeros(MAX_PARTICIPANTS, ZERO_KEY),
    stakes: zeros(MAX_PARTICIPANTS, 0n),
    side_b_mask: 0,
    funded_mask: 0,
    stake_each: 0n,
    time_limit_s: 0,
    program_hash: ZERO_HASH,
    calibration_hash: ZERO_HASH,
    acceptance_audio_hash: ZERO_HASH,
    created_at: 0n,
    fund_deadline: 0n,
    funded_at: 0n,
    started_at: 0n,
    beacon_slot: 0n,
    beacon_hash: ZERO_HASH,
    n_witnesses: 0,
    witnesses: zeros(MAX_WITNESSES, ZERO_KEY),
    witness_kinds: zeros(MAX_WITNESSES, 0),
    witness_heads: zeros(MAX_WITNESSES, 0),
    witness_head_hashes: zeros(MAX_WITNESSES, ZERO_HASH),
    gap_mask: 0,
    evidence_seq: 0,
    evidence_root: ZERO_HASH,
    last_commit_at: 0n,
    ended_at: 0n,
    perception_root: ZERO_HASH,
    tracks_hash: ZERO_HASH,
    tracks_finalized: 0,
    preruling: 0,
    prerule_reason: 0,
    winner_mask: 0,
    leg_results: zeros(8, 0),
    preruled_at: 0n,
    consent_deadline: 0n,
    consent_mask: 0,
    disputer: ZERO_KEY,
    dispute_bond: 0n,
    dispute_reason: 0,
    disputed_at: 0n,
    n_bio: 0,
    bio: zeros(MAX_CHECKPOINTS, null).map(() => ({ participant: 0, modality: 0 as ModalityCode, frame: 0 })),
    settled_at: 0n,
    settle_path: 0,
    final_winner_mask: 0,
    refund_reason: 0,
    reserved: '0'.repeat(2 * BET_RESERVED_BYTES),
  };
}

/** Deep copy (all fields are primitives or arrays of primitives / BioCheck). */
export function cloneBet(b: BetAccount): BetAccount {
  return {
    ...b,
    judges: [...b.judges],
    participants: [...b.participants],
    stakes: [...b.stakes],
    witnesses: [...b.witnesses],
    witness_kinds: [...b.witness_kinds],
    witness_heads: [...b.witness_heads],
    witness_head_hashes: [...b.witness_head_hashes],
    leg_results: [...b.leg_results],
    bio: b.bio.map((x) => ({ ...x })),
  };
}

/** Borsh body of a Bet (1580 bytes, no discriminator). */
export function encodeBetBody(b: BetAccount): Uint8Array {
  const w = new BorshWriter(BET_ACCOUNT_BYTES);
  w.u8(b.version).u8(b.bump).u8(b.vault_bump).u8(b.state).u8(b.flags);
  w.pubkey(b.creator).u64(b.nonce).pubkey(b.mint).pubkey(b.oracle);
  w.array(b.judges, 3, (x, k) => x.pubkey(k));
  w.u8(b.n_participants);
  w.array(b.participants, MAX_PARTICIPANTS, (x, k) => x.pubkey(k));
  w.array(b.stakes, MAX_PARTICIPANTS, (x, v) => x.u64(v));
  w.u8(b.side_b_mask).u8(b.funded_mask).u64(b.stake_each).u32(b.time_limit_s);
  w.hash(b.program_hash).hash(b.calibration_hash).hash(b.acceptance_audio_hash);
  w.i64(b.created_at).i64(b.fund_deadline).i64(b.funded_at).i64(b.started_at);
  w.u64(b.beacon_slot).hash(b.beacon_hash).u8(b.n_witnesses);
  w.array(b.witnesses, MAX_WITNESSES, (x, k) => x.pubkey(k));
  w.array(b.witness_kinds, MAX_WITNESSES, (x, v) => x.u8(v));
  w.array(b.witness_heads, MAX_WITNESSES, (x, v) => x.u32(v));
  w.array(b.witness_head_hashes, MAX_WITNESSES, (x, h) => x.hash(h));
  w.u8(b.gap_mask).u32(b.evidence_seq).hash(b.evidence_root).i64(b.last_commit_at).i64(b.ended_at);
  w.hash(b.perception_root).hash(b.tracks_hash).u8(b.tracks_finalized).u8(b.preruling);
  w.u8(b.prerule_reason).u8(b.winner_mask);
  w.array(b.leg_results, 8, (x, v) => x.u8(v));
  w.i64(b.preruled_at).i64(b.consent_deadline).u8(b.consent_mask).pubkey(b.disputer).u64(b.dispute_bond);
  w.u8(b.dispute_reason).i64(b.disputed_at).u8(b.n_bio);
  w.array(b.bio, MAX_CHECKPOINTS, (x, c) => x.u8(c.participant).u8(c.modality).u32(c.frame));
  w.i64(b.settled_at).u8(b.settle_path).u8(b.final_winner_mask).u8(b.refund_reason);
  w.fixed(fromHex(b.reserved), BET_RESERVED_BYTES);
  const out = w.toBytes();
  if (out.length !== BET_ACCOUNT_BYTES) throw new Error(`Bet body is ${out.length} bytes, expected ${BET_ACCOUNT_BYTES}`);
  return out;
}

/** Full Bet account data: discriminator ‖ Borsh body (8 + 1580 bytes). */
export function encodeBetAccount(b: BetAccount): Uint8Array {
  const out = new Uint8Array(8 + BET_ACCOUNT_BYTES);
  out.set(BET_DISCRIMINATOR, 0);
  out.set(encodeBetBody(b), 8);
  return out;
}

function enumU8<T extends number>(r: BorshReader, allowed: readonly number[], label: string): T {
  const v = r.u8();
  if (!allowed.includes(v)) throw new Error(`Bet: invalid ${label} ${v}`);
  return v as T;
}

/** Decodes Bet account data (discriminator ‖ body). Throws on any malformation. */
export function decodeBetAccount(bytes: Uint8Array): BetAccount {
  if (bytes.length !== 8 + BET_ACCOUNT_BYTES) {
    throw new Error(`Bet: expected ${8 + BET_ACCOUNT_BYTES} bytes, got ${bytes.length}`);
  }
  if (!bytesEqual(bytes.subarray(0, 8), BET_DISCRIMINATOR)) throw new Error('Bet: bad discriminator');
  const r = new BorshReader(bytes.subarray(8));
  const version = r.u8();
  const bump = r.u8();
  const vault_bump = r.u8();
  const state = enumU8<BetStateCode>(r, [0, 1, 2, 3, 4, 5, 6, 7], 'state');
  const flags = r.u8();
  const creator = r.pubkey();
  const nonce = r.u64();
  const mint = r.pubkey();
  const oracle = r.pubkey();
  const judges = r.array(3, (x) => x.pubkey());
  const n_participants = r.u8();
  const participants = r.array(MAX_PARTICIPANTS, (x) => x.pubkey());
  const stakes = r.array(MAX_PARTICIPANTS, (x) => x.u64());
  const side_b_mask = r.u8();
  const funded_mask = r.u8();
  const stake_each = r.u64();
  const time_limit_s = r.u32();
  const program_hash = r.hash();
  const calibration_hash = r.hash();
  const acceptance_audio_hash = r.hash();
  const created_at = r.i64();
  const fund_deadline = r.i64();
  const funded_at = r.i64();
  const started_at = r.i64();
  const beacon_slot = r.u64();
  const beacon_hash = r.hash();
  const n_witnesses = r.u8();
  const witnesses = r.array(MAX_WITNESSES, (x) => x.pubkey());
  const witness_kinds = r.array(MAX_WITNESSES, (x) => x.u8());
  const witness_heads = r.array(MAX_WITNESSES, (x) => x.u32());
  const witness_head_hashes = r.array(MAX_WITNESSES, (x) => x.hash());
  const gap_mask = r.u8();
  const evidence_seq = r.u32();
  const evidence_root = r.hash();
  const last_commit_at = r.i64();
  const ended_at = r.i64();
  const perception_root = r.hash();
  const tracks_hash = r.hash();
  const tracks_finalized = enumU8<TracksFinalizedCode>(r, [0, 1, 2], 'tracks_finalized');
  const preruling = enumU8<PrerulingCode>(r, [0, 1, 2, 3], 'preruling');
  const prerule_reason = r.u8();
  const winner_mask = r.u8();
  const leg_results = r.array(8, (x) => x.u8());
  const preruled_at = r.i64();
  const consent_deadline = r.i64();
  const consent_mask = r.u8();
  const disputer = r.pubkey();
  const dispute_bond = r.u64();
  const dispute_reason = enumU8<DisputeReasonCode>(r, [0, 1, 2, 3, 4, 10, 11, 12, 13], 'dispute_reason');
  const disputed_at = r.i64();
  const n_bio = r.u8();
  const bio = r.array(MAX_CHECKPOINTS, (x) => ({
    participant: x.u8(),
    modality: x.u8() as ModalityCode,
    frame: x.u32(),
  }));
  const settled_at = r.i64();
  const settle_path = enumU8<SettlePathCode>(r, [0, 1, 2, 3, 4], 'settle_path');
  const final_winner_mask = r.u8();
  const refund_reason = enumU8<RefundReasonCode>(r, [0, 1, 2, 3, 4, 5, 6, 7, 8], 'refund_reason');
  const reservedBytes = r.raw(BET_RESERVED_BYTES);
  r.end();
  if (!isZero(reservedBytes)) throw new Error('Bet: reserved bytes must be zero');
  if (n_participants > MAX_PARTICIPANTS) throw new Error('Bet: n_participants > 8');
  if (n_witnesses > MAX_WITNESSES) throw new Error('Bet: n_witnesses > 8');
  if (n_bio > MAX_CHECKPOINTS) throw new Error('Bet: n_bio > 8');
  for (const c of bio) if (c.modality > 1) throw new Error('Bet: invalid BioCheck modality');
  return {
    version,
    bump,
    vault_bump,
    state,
    flags,
    creator,
    nonce,
    mint,
    oracle,
    judges,
    n_participants,
    participants,
    stakes,
    side_b_mask,
    funded_mask,
    stake_each,
    time_limit_s,
    program_hash,
    calibration_hash,
    acceptance_audio_hash,
    created_at,
    fund_deadline,
    funded_at,
    started_at,
    beacon_slot,
    beacon_hash,
    n_witnesses,
    witnesses,
    witness_kinds,
    witness_heads,
    witness_head_hashes,
    gap_mask,
    evidence_seq,
    evidence_root,
    last_commit_at,
    ended_at,
    perception_root,
    tracks_hash,
    tracks_finalized,
    preruling,
    prerule_reason,
    winner_mask,
    leg_results,
    preruled_at,
    consent_deadline,
    consent_mask,
    disputer,
    dispute_bond,
    dispute_reason,
    disputed_at,
    n_bio,
    bio,
    settled_at,
    settle_path,
    final_winner_mask,
    refund_reason,
    reserved: '0'.repeat(2 * BET_RESERVED_BYTES),
  };
}

/** Full Profile account data: discriminator ‖ Borsh body (8 + 179 bytes). */
export function encodeProfile(p: ProfileAccount): Uint8Array {
  const name = utf8(p.display_name);
  if (name.length > PROFILE_NAME_BYTES) throw new Error('Profile: display_name > 32 bytes');
  if (name.length !== p.name_len) throw new Error('Profile: name_len does not match display_name');
  const padded = new Uint8Array(PROFILE_NAME_BYTES);
  padded.set(name);
  const w = new BorshWriter(8 + PROFILE_ACCOUNT_BYTES);
  w.raw(PROFILE_DISCRIMINATOR);
  w.pubkey(p.wallet).hash(p.face_commit).hash(p.voice_commit).raw(padded);
  w.u8(p.name_len).u8(p.flags).u8(p.bump).i64(p.created_at).i64(p.updated_at);
  w.fixed(fromHex(p.reserved), PROFILE_RESERVED_BYTES);
  return w.toBytes();
}

/** Decodes Profile account data (discriminator ‖ body). */
export function decodeProfile(bytes: Uint8Array): ProfileAccount {
  if (bytes.length !== 8 + PROFILE_ACCOUNT_BYTES) {
    throw new Error(`Profile: expected ${8 + PROFILE_ACCOUNT_BYTES} bytes, got ${bytes.length}`);
  }
  if (!bytesEqual(bytes.subarray(0, 8), PROFILE_DISCRIMINATOR)) throw new Error('Profile: bad discriminator');
  const r = new BorshReader(bytes.subarray(8));
  const wallet = r.pubkey();
  const face_commit = r.hash();
  const voice_commit = r.hash();
  const nameBytes = r.raw(PROFILE_NAME_BYTES);
  const name_len = r.u8();
  const flags = r.u8();
  const bump = r.u8();
  const created_at = r.i64();
  const updated_at = r.i64();
  const reserved = r.raw(PROFILE_RESERVED_BYTES);
  r.end();
  if (name_len > PROFILE_NAME_BYTES) throw new Error('Profile: name_len > 32');
  if (!isZero(nameBytes.subarray(name_len))) throw new Error('Profile: display_name padding must be zero');
  if (!isZero(reserved)) throw new Error('Profile: reserved bytes must be zero');
  const display_name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes.subarray(0, name_len));
  return {
    wallet,
    face_commit,
    voice_commit,
    display_name,
    name_len,
    flags,
    bump,
    created_at,
    updated_at,
    reserved: ZERO_HASH,
  };
}

/** TrackBuffer header (48 bytes, repr(C) little-endian). */
export function encodeTrackBufferHeader(h: TrackBufferHeader): Uint8Array {
  const w = new BorshWriter(TRACK_BUFFER_HEADER_BYTES);
  w.pubkey(h.bet).u32(h.payload_len).u16(h.program_len).u16(h.calibration_len);
  w.u32(h.written).u8(h.finalized).u8(h.bump).raw(new Uint8Array(2));
  return w.toBytes();
}

export function decodeTrackBufferHeader(bytes: Uint8Array): TrackBufferHeader {
  if (bytes.length !== TRACK_BUFFER_HEADER_BYTES) throw new Error('TrackBuffer header: expected 48 bytes');
  const r = new BorshReader(bytes);
  const h: TrackBufferHeader = {
    bet: r.pubkey(),
    payload_len: r.u32(),
    program_len: r.u16(),
    calibration_len: r.u16(),
    written: r.u32(),
    finalized: r.u8(),
    bump: r.u8(),
  };
  if (!isZero(r.raw(2))) throw new Error('TrackBuffer header: reserved must be zero');
  r.end();
  return h;
}
