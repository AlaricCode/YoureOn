/**
 * Well-known program IDs and builders for the non-Verdict instructions the
 * backend sends (SPL Token, Associated Token Account, ComputeBudget, Ed25519
 * precompile). Hand-encoded to avoid an extra dependency; layouts follow the
 * SPL/Solana sources.
 */
import {
  ED25519_PROGRAM_ID,
  findProgramAddress,
  INSTRUCTIONS_SYSVAR_ID,
  SLOT_HASHES_SYSVAR_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@verdict/engine';
import { fromBase58 } from '../util/bytes.js';
import type { RawIx } from './types.js';

export { ED25519_PROGRAM_ID, INSTRUCTIONS_SYSVAR_ID, SLOT_HASHES_SYSVAR_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID };
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';
export const USDC_DECIMALS = 6;

/** Associated token account address for (owner, mint). */
export function associatedTokenAddress(owner: string, mint: string): string {
  return findProgramAddress([fromBase58(owner), fromBase58(TOKEN_PROGRAM_ID), fromBase58(mint)], ATA_PROGRAM_ID).address;
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

/** ATA program `CreateIdempotent` (instruction 1). */
export function createAtaIdempotentIx(payer: string, owner: string, mint: string): RawIx {
  return {
    program: 'raw',
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  };
}

/** SPL Token `TransferChecked` (instruction 12). */
export function transferCheckedIx(
  source: string,
  mint: string,
  dest: string,
  owner: string,
  amount: bigint,
  decimals = USDC_DECIMALS,
): RawIx {
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(amount), 1);
  data[9] = decimals;
  return {
    program: 'raw',
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/** SPL Token `MintTo` (instruction 7). */
export function mintToIx(mint: string, dest: string, authority: string, amount: bigint): RawIx {
  const data = new Uint8Array(9);
  data[0] = 7;
  data.set(u64le(amount), 1);
  return {
    program: 'raw',
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  };
}

/** ComputeBudget `SetComputeUnitLimit` (instruction 2). */
export function setComputeUnitLimitIx(units: number): RawIx {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { program: 'raw', programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data };
}

/** Ed25519 precompile instruction with prebuilt data (§9.7 panel layout via engine.ed25519PanelIxData). */
export function ed25519Ix(data: Uint8Array): RawIx {
  return { program: 'raw', programId: ED25519_PROGRAM_ID, keys: [], data };
}

export interface DecodedTokenIx {
  kind: 'transfer' | 'transfer_checked' | 'mint_to';
  amount: bigint;
  decimals?: number;
}

/** Decodes the SPL Token instructions the mock chain supports. */
export function decodeTokenIx(data: Uint8Array): DecodedTokenIx | null {
  if (data.length === 0) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (data[0]) {
    case 3:
      return data.length === 9 ? { kind: 'transfer', amount: dv.getBigUint64(1, true) } : null;
    case 7:
      return data.length === 9 ? { kind: 'mint_to', amount: dv.getBigUint64(1, true) } : null;
    case 12:
      return data.length === 10
        ? { kind: 'transfer_checked', amount: dv.getBigUint64(1, true), decimals: data[9]! }
        : null;
    default:
      return null;
  }
}
