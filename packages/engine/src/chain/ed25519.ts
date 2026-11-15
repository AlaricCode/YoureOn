/**
 * §9.7 Ed25519 precompile instruction data for `settle_panel` (367 bytes) and
 * the program-side checks on it.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  ED25519_OFFSET_UNUSED_INDEX,
  ED25519_PANEL_IX_BYTES,
  ED25519_PANEL_OFFSETS,
  PANEL_MESSAGE_BYTES,
} from '../constants.js';
import type { ErrorCode, Pubkey } from '../types.js';
import { BorshReader, BorshWriter, bytesEqual, pubkeyBytes, pubkeyString } from './bytes.js';

/** Builds the fixed 367-byte Ed25519 instruction data (two signatures over one message). */
export function ed25519PanelIxData(
  pk0: Pubkey | Uint8Array,
  sig0: Uint8Array,
  pk1: Pubkey | Uint8Array,
  sig1: Uint8Array,
  M: Uint8Array,
): Uint8Array {
  if (sig0.length !== 64 || sig1.length !== 64) throw new Error('ed25519 signatures must be 64 bytes');
  if (M.length !== PANEL_MESSAGE_BYTES) throw new Error(`panel message must be ${PANEL_MESSAGE_BYTES} bytes`);
  const w = new BorshWriter(ED25519_PANEL_IX_BYTES);
  w.u8(2).u8(0);
  for (const o of ED25519_PANEL_OFFSETS) {
    w.u16(o.signature_offset).u16(ED25519_OFFSET_UNUSED_INDEX);
    w.u16(o.public_key_offset).u16(ED25519_OFFSET_UNUSED_INDEX);
    w.u16(o.message_data_offset).u16(o.message_data_size).u16(ED25519_OFFSET_UNUSED_INDEX);
  }
  w.raw(pubkeyBytes(pk0)).raw(sig0).raw(pubkeyBytes(pk1)).raw(sig1).raw(M);
  const out = w.toBytes();
  if (out.length !== ED25519_PANEL_IX_BYTES) throw new Error('ed25519 ix length');
  return out;
}

export interface ParsedPanelIx {
  pk0: Pubkey;
  sig0: Uint8Array;
  pk1: Pubkey;
  sig1: Uint8Array;
  message: Uint8Array;
}

/**
 * Parses the panel Ed25519 data, enforcing length 367 and the exact fixed
 * offsets (every index field 0xFFFF). Returns null if the layout differs.
 */
export function parseEd25519PanelIxData(data: Uint8Array): ParsedPanelIx | null {
  if (data.length !== ED25519_PANEL_IX_BYTES) return null;
  const r = new BorshReader(data);
  if (r.u8() !== 2 || r.u8() !== 0) return null;
  for (const o of ED25519_PANEL_OFFSETS) {
    const expect = [
      o.signature_offset,
      ED25519_OFFSET_UNUSED_INDEX,
      o.public_key_offset,
      ED25519_OFFSET_UNUSED_INDEX,
      o.message_data_offset,
      o.message_data_size,
      ED25519_OFFSET_UNUSED_INDEX,
    ];
    for (const e of expect) if (r.u16() !== e) return null;
  }
  const pk0 = pubkeyString(r.raw(32));
  const sig0 = r.raw(64);
  const pk1 = pubkeyString(r.raw(32));
  const sig1 = r.raw(64);
  const message = r.raw(PANEL_MESSAGE_BYTES);
  return { pk0, sig0, pk1, sig1, message };
}

/** What the Ed25519 precompile itself checks: both signatures verify (strict RFC 8032). */
export function verifyPanelSignatures(p: ParsedPanelIx): boolean {
  try {
    return (
      ed25519.verify(p.sig0, p.message, pubkeyBytes(p.pk0), { zip215: false }) &&
      ed25519.verify(p.sig1, p.message, pubkeyBytes(p.pk1), { zip215: false })
    );
  } catch {
    return false;
  }
}

/**
 * Program-side §9.7 checks given the preceding instruction. `expectedM` is the
 * message recomputed from the Bet and outcome.
 */
export function checkPanelInstruction(
  prev: { program_id: Pubkey; data: Uint8Array } | null | undefined,
  ed25519ProgramId: Pubkey,
  expectedM: Uint8Array,
  judges: readonly Pubkey[],
  verifySignatures: boolean,
): ErrorCode | null {
  if (!prev || prev.program_id !== ed25519ProgramId) return 'BadEd25519Instruction';
  const p = parseEd25519PanelIxData(prev.data);
  if (!p) return 'BadEd25519Instruction';
  if (!bytesEqual(p.message, expectedM)) return 'BadEd25519Instruction';
  if (verifySignatures && !verifyPanelSignatures(p)) return 'BadEd25519Instruction';
  if (p.pk0 === p.pk1) return 'InsufficientQuorum';
  if (!judges.includes(p.pk0) || !judges.includes(p.pk1)) return 'InsufficientQuorum';
  return null;
}
