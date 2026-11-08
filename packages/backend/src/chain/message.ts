/**
 * Transaction message construction and parsing (§12.1): the same legacy
 * Solana message bytes are used in mock and devnet mode. Verdict instructions
 * get their account metas from the committed IDL (§9.1, IDL order is
 * normative) and their data from `engine.encodeInstruction`.
 */
import bs58 from 'bs58';
import { Message, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import {
  decodeInstruction,
  encodeInstruction,
  type DecodedInstruction,
  type InstructionName,
  type Pubkey,
} from '@verdict/engine';
import { idlInstruction, type VerdictIdl } from './idl.js';
import type { ChainIx, RawAccountMeta, VerdictIx } from './types.js';

/** Legacy transaction size limit (§9.1). */
export const MAX_TX_BYTES = 1232;

export interface BuildContext {
  idl: VerdictIdl;
  programId: Pubkey;
  /** default for an omitted `payer` account */
  feePayer: Pubkey;
}

/** Resolves a Verdict instruction's account metas in IDL order (+ remaining accounts). */
export function verdictAccountMetas(ix: VerdictIx, ctx: BuildContext): RawAccountMeta[] {
  const def = idlInstruction(ctx.idl, ix.name);
  const named = ix.accounts as Record<string, Pubkey | undefined>;
  const metas: RawAccountMeta[] = def.accounts.map((a) => {
    let key = named[a.name] ?? a.address;
    if (!key && a.name === 'payer') key = ctx.feePayer;
    if (!key && a.optional) key = ctx.programId; // Anchor's "None" for optional accounts
    if (!key) throw new Error(`${ix.name}: missing account "${a.name}"`);
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  for (const k of ix.remaining ?? []) metas.push({ pubkey: k, isSigner: false, isWritable: true });
  return metas;
}

export function toWeb3Instruction(ix: ChainIx, ctx: BuildContext): TransactionInstruction {
  if (ix.program === 'raw') {
    return new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: Buffer.from(ix.data),
    });
  }
  const metas = verdictAccountMetas(ix, ctx);
  return new TransactionInstruction({
    programId: new PublicKey(ctx.programId),
    keys: metas.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(encodeInstruction(ix.name, ix.args as never)),
  });
}

/** Compiles a legacy message (fee payer first). */
export function compileMessage(ixs: ChainIx[], ctx: BuildContext, recentBlockhash: string): Message {
  return new TransactionMessage({
    payerKey: new PublicKey(ctx.feePayer),
    recentBlockhash,
    instructions: ixs.map((i) => toWeb3Instruction(i, ctx)),
  }).compileToLegacyMessage();
}

/** Required signer pubkeys of a message, in order. */
export function messageSigners(m: Message): Pubkey[] {
  return m.accountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58());
}

/** Wire size of a transaction carrying this message: compact-u16 count + 64·sigs + message. */
export function transactionSize(messageBytes: Uint8Array, numSignatures: number): number {
  const countLen = numSignatures < 0x80 ? 1 : numSignatures < 0x4000 ? 2 : 3;
  return countLen + 64 * numSignatures + messageBytes.length;
}

export interface ParsedInstruction {
  programId: Pubkey;
  keys: RawAccountMeta[];
  data: Uint8Array;
  /** set for Verdict program instructions that decode */
  verdict?: {
    decoded: DecodedInstruction;
    accounts: Record<string, Pubkey>;
    remaining: Pubkey[];
  };
  /** set when a Verdict program instruction failed to decode */
  decodeError?: string;
}

export interface ParsedMessage {
  message: Message;
  feePayer: Pubkey;
  recentBlockhash: string;
  signers: Pubkey[];
  instructions: ParsedInstruction[];
}

/** Parses message bytes back into instructions; Verdict ones are decoded and their accounts named via the IDL. */
export function parseMessage(bytes: Uint8Array, idl: VerdictIdl, programId: Pubkey): ParsedMessage {
  const message = Message.from(Buffer.from(bytes));
  const keys = message.accountKeys.map((k) => k.toBase58());
  const instructions: ParsedInstruction[] = message.instructions.map((ci) => {
    const pid = keys[ci.programIdIndex]!;
    const metas: RawAccountMeta[] = ci.accounts.map((i) => ({
      pubkey: keys[i]!,
      isSigner: message.isAccountSigner(i),
      isWritable: message.isAccountWritable(i),
    }));
    const data = new Uint8Array(Buffer.from(bs58decode(ci.data)));
    const out: ParsedInstruction = { programId: pid, keys: metas, data };
    if (pid === programId) {
      try {
        const decoded = decodeInstruction(data);
        const def = idlInstruction(idl, decoded.name);
        const accounts: Record<string, Pubkey> = {};
        def.accounts.forEach((a, i) => {
          if (i < metas.length) accounts[a.name] = metas[i]!.pubkey;
        });
        if (metas.length < def.accounts.length) throw new Error(`${decoded.name}: not enough accounts`);
        out.verdict = { decoded, accounts, remaining: metas.slice(def.accounts.length).map((m) => m.pubkey) };
      } catch (e) {
        out.decodeError = (e as Error).message;
      }
    }
    return out;
  });
  return {
    message,
    feePayer: keys[0]!,
    recentBlockhash: message.recentBlockhash,
    signers: messageSigners(message),
    instructions,
  };
}

// web3.js stores compiled instruction data as base58.
function bs58decode(s: string): Uint8Array {
  return bs58.decode(s);
}

/** Convenience: a typed Verdict instruction. */
export function verdictIx<N extends InstructionName>(
  name: N,
  args: VerdictIx<N>['args'],
  accounts: VerdictIx<N>['accounts'],
  remaining?: Pubkey[],
): VerdictIx<N> {
  return remaining ? { program: 'verdict', name, args, accounts, remaining } : { program: 'verdict', name, args, accounts };
}
