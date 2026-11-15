// Nonce-pool addressing and reads (ESCROW §5.0.1, DATA-MODEL §5.20):
// account k = createAccountWithSeed(fee payer, "yo-nonce-<k>", System), authority = fee payer.
import { address, createAddressWithSeed, type Address } from '@solana/kit';
import { fetchMaybeNonce, NonceState } from '@solana-program/system';

import { nonceSeed, SYSTEM_PROGRAM_ID } from '@youre-on/shared/chain/constants';

import type { ChainRpc } from './chain';

export const SYSTEM = address(SYSTEM_PROGRAM_ID);

export type PoolEntry = { k: number; account: Address; value: string; authority: Address };

export function poolAddress(feePayer: Address, k: number): Promise<Address> {
  return createAddressWithSeed({
    baseAddress: feePayer,
    seed: nonceSeed(k),
    programAddress: SYSTEM,
  });
}

/** Reads nonce k at `confirmed`; null when the account does not exist. Throws on a bad account. */
export async function readPoolNonce(
  rpc: ChainRpc,
  feePayer: Address,
  k: number,
): Promise<PoolEntry | null> {
  const account = await poolAddress(feePayer, k);
  const acc = await fetchMaybeNonce(rpc, account, { commitment: 'confirmed' });
  if (!acc.exists) return null;
  if (acc.programAddress !== SYSTEM) throw new Error(`${account} (k=${k}) is not owned by System`);
  if (acc.data.state !== NonceState.Initialized) {
    throw new Error(`${account} (k=${k}) is not an initialized nonce account`);
  }
  if (acc.data.authority !== feePayer) {
    throw new Error(`${account} (k=${k}) authority ${acc.data.authority} != fee payer ${feePayer}`);
  }
  return { k, account, value: acc.data.blockhash, authority: acc.data.authority };
}
