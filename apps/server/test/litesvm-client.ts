// A ChainClient (src/chain/tx.ts) over npm LiteSVM running the real escrow.so: the server's
// lock / resolve / payout transactions execute against the actual program in tests.
// Differences from an RPC, on purpose: a send executes immediately and is `confirmed` at once; a
// failed send is reported as a preflight rejection (LiteSVM has no preflight, and a failed tx in
// LiteSVM does not advance a durable nonce, ESCROW §9.1 note); every landed tx expires the
// blockhash (a new slot). getProgramAccounts is emulated over every address a sent tx touched
// (LiteSVM cannot enumerate accounts), plus any address passed to `track`.
import {
  getBase58Encoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getI64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getU64Encoder,
  type Address,
  type Base64EncodedWireTransaction,
  type Transaction,
} from '@solana/kit';
import { getTokenDecoder } from '@solana-program/token';
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from 'litesvm';
import type { RpcTransaction } from '../src/chain/streams';
import { PreflightError, type ChainClient, type SigStatus } from '../src/chain/tx';
import { ataOf } from '../src/chain/tx';

const b58 = getBase58Decoder();

const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';

/** litesvm's TransactionError -> the RPC JSON shape (`{InstructionError: [ix, {Custom: n}]}`). */
export function rpcErr(f: FailedTransactionMetadata): unknown {
  const err = f.err() as unknown as { index?: number; err?: () => unknown };
  if (typeof err.index === 'number' && typeof err.err === 'function') {
    const inner = err.err() as { code?: unknown };
    return {
      InstructionError: [
        err.index,
        typeof inner.code === 'number' ? { Custom: inner.code } : String(inner),
      ],
    };
  }
  return { Other: String(err) };
}

/** A landed LiteSVM tx as getTransaction (json) would return it (chain/streams.ts RpcTransaction). */
export function rpcTransactionOf(
  tx: Transaction,
  meta: TransactionMetadata,
  at: { slot: bigint; unixTimestamp: bigint },
): RpcTransaction {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    staticAccounts: Address[];
  };
  return {
    signature: getSignatureFromTransaction(tx),
    slot: Number(at.slot),
    blockTime: Number(at.unixTimestamp),
    err: null,
    accountKeys: compiled.staticAccounts,
    innerInstructions: meta
      .innerInstructions()
      .map((ixs, index) => ({
        index,
        instructions: ixs.map((ii) => {
          const ci = ii.instruction();
          return {
            programIdIndex: ci.programIdIndex(),
            accounts: [...ci.accounts()],
            data: b58.decode(ci.data()),
          };
        }),
      }))
      .filter((g) => g.instructions.length > 0),
  };
}

export function liteSvmClient(
  svm: LiteSVM,
): ChainClient & { sent: string[]; track(addr: Address): void } {
  const statuses = new Map<string, SigStatus>();
  const sent: string[] = [];
  const seen = new Set<Address>();
  const landed = new Map<string, RpcTransaction>();
  /** Landed wire bytes by signature (an RPC's getTransaction base64; LiteSVM keeps only metadata). */
  const landedWire = new Map<string, Uint8Array>();
  const decode = (wire: Base64EncodedWireTransaction) =>
    getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  return {
    sent,
    track: (addr) => void seen.add(addr),
    label: 'litesvm',
    assertSafeCluster: async () => 'localnet',
    latestBlockhash: async () => ({
      blockhash: svm.latestBlockhash(),
      lastValidBlockHeight: 1_000_000n,
    }),
    async simulate(wire) {
      const tx = decode(wire);
      svm.withSigverify(false);
      try {
        const r = svm.simulateTransaction(tx);
        if (r instanceof FailedTransactionMetadata)
          return {
            err: rpcErr(r),
            unitsConsumed: r.meta().computeUnitsConsumed(),
            logs: r.meta().logs(),
          };
        return { err: null, unitsConsumed: r.meta().computeUnitsConsumed(), logs: r.meta().logs() };
      } finally {
        svm.withSigverify(true);
      }
    },
    async send(wire, skipPreflight) {
      const tx = decode(wire);
      const sig = getSignatureFromTransaction(tx);
      if (statuses.has(sig)) return;
      const r = svm.sendTransaction(tx);
      if (r instanceof FailedTransactionMetadata) {
        if (!skipPreflight)
          throw new PreflightError(
            `preflight rejected: ${r.toString()}`,
            rpcErr(r),
            r.meta().logs(),
          );
        statuses.set(sig, {
          err: rpcErr(r),
          confirmationStatus: 'confirmed',
          slot: svm.getClock().slot,
        });
        return;
      }
      sent.push(sig);
      for (const a of getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts)
        seen.add(a);
      landedWire.set(sig, new Uint8Array(getBase64Encoder().encode(wire)));
      statuses.set(sig, { err: null, confirmationStatus: 'confirmed', slot: svm.getClock().slot });
      landed.set(sig, rpcTransactionOf(tx, r, svm.getClock()));
      // A new "slot": a durable nonce advanced in this tx may be advanced again (Agave refuses a
      // second advance under the same blockhash, NonceBlockhashNotExpired).
      svm.expireBlockhash();
    },
    signatureStatus: async (sig) => statuses.get(sig) ?? null,
    blockHeight: async () => 0n,
    async getAccount(addr: Address) {
      if (addr === SYSVAR_CLOCK) {
        const c = svm.getClock();
        const data = new Uint8Array(40);
        data.set(getU64Encoder().encode(c.slot), 0);
        data.set(getI64Encoder().encode(c.epochStartTimestamp), 8);
        data.set(getU64Encoder().encode(c.epoch), 16);
        data.set(getU64Encoder().encode(c.leaderScheduleEpoch), 24);
        data.set(getI64Encoder().encode(c.unixTimestamp), 32);
        return {
          owner: 'Sysvar1111111111111111111111111111111111111' as Address,
          lamports: 1n,
          data,
        };
      }
      const a = svm.getAccount(addr);
      if (!a.exists) return null;
      return { owner: a.programAddress, lamports: a.lamports, data: new Uint8Array(a.data) };
    },
    async tokenBalanceByOwner(owner, mint) {
      const a = svm.getAccount(await ataOf(owner, mint));
      return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
    },
    lamports: async (a) => svm.getBalance(a) ?? 0n,
    async programAccounts(program, filters) {
      const out: Array<{
        address: Address;
        account: { owner: Address; lamports: bigint; data: Uint8Array };
      }> = [];
      for (const addr of seen) {
        const a = svm.getAccount(addr);
        if (!a.exists || a.programAddress !== program) continue;
        const data = new Uint8Array(a.data);
        const match = filters.every((f) => {
          const want = getBase58Encoder().encode(f.bytes);
          return want.every((b, i) => data[f.offset + i] === b);
        });
        if (match)
          out.push({
            address: addr,
            account: { owner: a.programAddress, lamports: a.lamports, data },
          });
      }
      return out;
    },
    transaction: async (sig) => landed.get(sig) ?? null,
    transactionBytes: async (sig) => landedWire.get(sig) ?? null,
  };
}
