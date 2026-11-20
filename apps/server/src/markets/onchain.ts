// What a bet's `resolve` actually put on chain, read from the chain itself and never from
// Postgres (bets.evidence_hash / ruling_hash are written by the server from the ruling it sent,
// so comparing against them would only compare the server with itself). Used for the
// onchain_evidence / onchain_ruling links of GET /v1/bets/:id/settlement (markets/evidence.ts):
//   1. the Bet account while it is open after resolve (Resolved / Appealed / Settled): the
//      evidence_hash / ruling_hash fields the program stored;
//   2. once finalize + close_bet closed it: the confirmed resolve transaction itself, its escrow
//      `resolve` instruction for this bet's PDA, decoded (evidence_hash / ruling_hash args).
// null when neither can be read (no chain configured, RPC down, a timeout): the caller then says
// nothing about the chain rather than something unchecked. Values are cached per runtime: once a
// resolve landed they never change.
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import {
  BetStatus,
  findBetPda,
  getResolveInstructionDataDecoder,
  RESOLVE_DISCRIMINATOR,
} from '@youre-on/shared/escrow-client';
import { betIdToBytes } from '@youre-on/shared/primitives';
import type { ChainRuntime } from '../chain/tx';
import { hexOf, readBetAccount, type LifecycleDeps } from '../lock/common';
import { lifecycleOf } from '../lock/runtime';

export interface OnchainResolve {
  evidence_hash: string;
  ruling_hash: string;
  /** Where it was read: the open Bet account, or the resolve tx's instruction data. */
  source: 'bet_account' | 'resolve_tx';
}

/** The chain read gives up after this (the route answers without the on-chain links). */
export const ONCHAIN_READ_TIMEOUT_MS = 4_000;

const AFTER_RESOLVE: ReadonlySet<BetStatus> = new Set([
  BetStatus.Resolved,
  BetStatus.Appealed,
  BetStatus.Settled,
]);
const ZERO32 = '00'.repeat(32);
const cache = new WeakMap<ChainRuntime, Map<string, OnchainResolve>>();

/**
 * The escrow `resolve` instruction for `betPda` inside a serialized transaction (wire bytes):
 * its evidence_hash / ruling_hash arguments, or null when the tx has none.
 */
export function resolveArgsOf(
  wire: Uint8Array,
  programId: string,
  betPda: string,
): { evidence_hash: string; ruling_hash: string } | null {
  const tx = getTransactionDecoder().decode(wire);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!('instructions' in msg)) return null; // a v1 message: the server never builds one
  const keys = msg.staticAccounts;
  for (const ix of msg.instructions) {
    if (keys[ix.programAddressIndex] !== programId) continue;
    const data = ix.data;
    if (!data || data.length < RESOLVE_DISCRIMINATOR.length) continue;
    if (!RESOLVE_DISCRIMINATOR.every((b, i) => data[i] === b)) continue;
    // accounts: payer, judge_authority, bet, event_authority, program
    const betIndex = ix.accountIndices?.[2];
    if (betIndex === undefined || keys[betIndex] !== betPda) continue;
    const d = getResolveInstructionDataDecoder().decode(data);
    return { evidence_hash: hexOf(d.evidenceHash), ruling_hash: hexOf(d.rulingHash) };
  }
  return null;
}

async function read(
  rt: ChainRuntime,
  betId: string,
  signature: string | null,
): Promise<OnchainResolve | null> {
  const acc = await readBetAccount(rt, betId);
  if (acc && AFTER_RESOLVE.has(acc.status)) {
    const r = { evidence_hash: hexOf(acc.evidenceHash), ruling_hash: hexOf(acc.rulingHash) };
    if (r.ruling_hash !== ZERO32) return { ...r, source: 'bet_account' };
  }
  if (acc || !signature || !rt.client.transactionBytes) return null; // open but not resolved
  const wire = await rt.client.transactionBytes(signature);
  if (!wire) return null;
  const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
  const args = resolveArgsOf(wire, rt.programId, pda);
  return args ? { ...args, source: 'resolve_tx' } : null;
}

/** What the resolve of `betId` (tx `signature`, if known) put on chain, or null (see header). */
export async function readOnchainResolve(
  deps: LifecycleDeps,
  betId: string,
  signature: string | null,
): Promise<OnchainResolve | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rt = await lifecycleOf(deps).runtime();
    if (!rt) return null;
    let byBet = cache.get(rt);
    const hit = byBet?.get(betId);
    if (hit) return hit;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ONCHAIN_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    const found = await Promise.race([read(rt, betId, signature), timeout]);
    if (found) {
      if (!byBet) cache.set(rt, (byBet = new Map()));
      byBet.set(betId, found);
    }
    return found;
  } catch (err) {
    deps.log.warn('settlement.onchain_read_failed', { bet_id: betId, err: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
