/**
 * §9.4 instruction data: `sha256("global:<name>")[0..8] ‖ Borsh(args)`.
 */
import { DISC_GLOBAL_PREFIX, INSTRUCTION_NAMES } from '../constants.js';
import type { InstructionArgsMap, InstructionName, ModalityCode, PanelOutcome, WitnessKindCode } from '../types.js';
import { BorshReader, BorshWriter, bytesEqual, discriminator } from './bytes.js';

export const INSTRUCTION_DISCRIMINATORS: Record<InstructionName, Uint8Array> = Object.fromEntries(
  INSTRUCTION_NAMES.map((n) => [n, discriminator(DISC_GLOBAL_PREFIX, n)]),
) as Record<InstructionName, Uint8Array>;

type Writer = (w: BorshWriter, args: never) => void;
type Reader = (r: BorshReader) => unknown;

const WRITERS: { [N in InstructionName]: (w: BorshWriter, a: InstructionArgsMap[N]) => void } = {
  init_profile: (w, a) => {
    w.hash(a.face_commit).hash(a.voice_commit).string(a.display_name);
  },
  create_bet: (w, a) => {
    w.u64(a.nonce);
    w.vec(a.participants, (x, k) => x.pubkey(k));
    w.vec(a.stakes, (x, v) => x.u64(v));
    w.u8(a.side_b_mask).u64(a.stake_each).u32(a.time_limit_s).u8(a.flags);
    w.hash(a.program_hash).hash(a.acceptance_audio_hash);
    w.array(a.judges, 3, (x, k) => x.pubkey(k));
  },
  fund: (w, a) => {
    w.hash(a.calibration_hash).hash(a.program_hash).hash(a.terms_hash);
  },
  cancel: () => {},
  start: (w, a) => {
    w.u64(a.beacon_slot);
    w.vec(a.witnesses, (x, wa) => x.pubkey(wa.key).u8(wa.kind));
  },
  commit_evidence: (w, a) => {
    w.u32(a.seq);
    w.vec(a.heads, (x, h) => x.u32(h.index).hash(h.hash));
  },
  end: (w, a) => {
    w.u32(a.seq);
    w.vec(a.heads, (x, h) => x.u32(h.index).hash(h.hash));
  },
  post_tracks: (w, a) => {
    w.u32(a.payload_len).u16(a.program_len).u16(a.calibration_len).u32(a.offset);
    w.bytes(a.data).bool(a.finalize).hash(a.perception_root);
  },
  run_rules: () => {},
  consent: (w, a) => {
    w.u8(a.winner_mask).hash(a.evidence_root);
  },
  dispute: (w, a) => {
    w.u8(a.reason).hash(a.evidence_root);
  },
  settle_panel: (w, a) => {
    w.u8(a.outcome);
  },
  verify_biometric_proof: (w, a) => {
    w.u8(a.participant).u8(a.modality).u32(a.frame).u16(a.tau_bps);
    w.fixed(a.proof_a, 64).fixed(a.proof_b, 128).fixed(a.proof_c, 64);
  },
  verify_sp1_run: (w, a) => {
    w.bytes(a.public_values).bytes(a.proof);
  },
  refund: () => {},
};

const READERS: { [N in InstructionName]: (r: BorshReader) => InstructionArgsMap[N] } = {
  init_profile: (r) => ({ face_commit: r.hash(), voice_commit: r.hash(), display_name: r.string() }),
  create_bet: (r) => {
    const nonce = r.u64();
    const participants = r.vec((x) => x.pubkey(), 255);
    const stakes = r.vec((x) => x.u64(), 255);
    const side_b_mask = r.u8();
    const stake_each = r.u64();
    const time_limit_s = r.u32();
    const flags = r.u8();
    const program_hash = r.hash();
    const acceptance_audio_hash = r.hash();
    const judges = r.array(3, (x) => x.pubkey()) as [string, string, string];
    return {
      nonce,
      participants,
      stakes,
      side_b_mask,
      stake_each,
      time_limit_s,
      flags,
      program_hash,
      acceptance_audio_hash,
      judges,
    };
  },
  fund: (r) => ({ calibration_hash: r.hash(), program_hash: r.hash(), terms_hash: r.hash() }),
  cancel: () => ({}),
  start: (r) => ({
    beacon_slot: r.u64(),
    witnesses: r.vec((x) => ({ key: x.pubkey(), kind: x.u8() as WitnessKindCode }), 255),
  }),
  commit_evidence: (r) => ({ seq: r.u32(), heads: r.vec((x) => ({ index: x.u32(), hash: x.hash() }), 255) }),
  end: (r) => ({ seq: r.u32(), heads: r.vec((x) => ({ index: x.u32(), hash: x.hash() }), 255) }),
  post_tracks: (r) => ({
    payload_len: r.u32(),
    program_len: r.u16(),
    calibration_len: r.u16(),
    offset: r.u32(),
    data: r.bytes(),
    finalize: r.bool(),
    perception_root: r.hash(),
  }),
  run_rules: () => ({}),
  consent: (r) => ({ winner_mask: r.u8(), evidence_root: r.hash() }),
  dispute: (r) => ({ reason: r.u8(), evidence_root: r.hash() }),
  settle_panel: (r) => ({ outcome: r.u8() as PanelOutcome }),
  verify_biometric_proof: (r) => ({
    participant: r.u8(),
    modality: r.u8() as ModalityCode,
    frame: r.u32(),
    tau_bps: r.u16(),
    proof_a: r.raw(64),
    proof_b: r.raw(128),
    proof_c: r.raw(64),
  }),
  verify_sp1_run: (r) => ({ public_values: r.bytes(), proof: r.bytes() }),
  refund: () => ({}),
};

/** Encodes instruction data (discriminator ‖ Borsh args). */
export function encodeInstruction<N extends InstructionName>(name: N, args: InstructionArgsMap[N]): Uint8Array {
  const disc = INSTRUCTION_DISCRIMINATORS[name];
  if (!disc) throw new Error(`unknown instruction ${String(name)}`);
  const w = new BorshWriter(64);
  w.raw(disc);
  (WRITERS[name] as unknown as Writer)(w, args as never);
  return w.toBytes();
}

export type DecodedInstruction = {
  [N in InstructionName]: { name: N; args: InstructionArgsMap[N] };
}[InstructionName];

/** Decodes instruction data; throws on an unknown discriminator or malformed / trailing bytes. */
export function decodeInstruction(data: Uint8Array): DecodedInstruction {
  if (data.length < 8) throw new Error('instruction: too short');
  const disc = data.subarray(0, 8);
  for (const name of INSTRUCTION_NAMES) {
    if (bytesEqual(disc, INSTRUCTION_DISCRIMINATORS[name])) {
      const r = new BorshReader(data.subarray(8));
      const args = (READERS[name] as Reader)(r);
      r.end();
      return { name, args } as DecodedInstruction;
    }
  }
  throw new Error('instruction: unknown discriminator');
}
