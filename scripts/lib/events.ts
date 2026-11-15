// Escrow `emit_cpi!` events read back from a landed transaction (ESCROW §7.1): inner instructions
// that invoke the escrow program with data starting with Anchor's EVENT_IX_TAG. The position is the
// chain_events dedup key `(signature, outer_ix, inner_ix)` (DATA-MODEL §5.9).
import type { Signature } from '@solana/kit';

import {
  ESCROW_PROGRAM_ADDRESS,
  EscrowEvent,
  identifyEscrowEvent,
} from '@youre-on/shared/escrow-client';

import { base58Bytes, sleep, type ChainRpc } from './chain';

/** Anchor's EVENT_IX_TAG (u64 0x1d9acb512ea545e4, little-endian). */
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type ChainEvent = { name: string; outerIx: number; innerIx: number };

export async function escrowEventsOf(
  rpc: ChainRpc,
  signature: Signature,
): Promise<{
  events: ChainEvent[];
  computeUnits: bigint | null;
  fee: bigint;
  slot: bigint;
}> {
  // getTransaction can briefly return null right after `confirmed` on some RPCs: retry a little.
  for (let attempt = 0; ; attempt++) {
    const tx = await rpc
      .getTransaction(signature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx) {
      if (attempt >= 20) throw new Error(`getTransaction(${signature}) returned null`);
      await sleep(250);
      continue;
    }
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ];
    const events: ChainEvent[] = [];
    for (const group of tx.meta?.innerInstructions ?? []) {
      group.instructions.forEach((ix, innerIx) => {
        if (keys[ix.programIdIndex] !== ESCROW_PROGRAM_ADDRESS) return;
        const data = base58Bytes(ix.data);
        if (!EVENT_IX_TAG.every((b, i) => data[i] === b)) return;
        const kind = identifyEscrowEvent(data.slice(EVENT_IX_TAG.length));
        events.push({ name: EscrowEvent[kind], outerIx: group.index, innerIx });
      });
    }
    return {
      events,
      computeUnits: tx.meta?.computeUnitsConsumed ?? null,
      fee: tx.meta?.fee ?? 0n,
      slot: tx.slot,
    };
  }
}
