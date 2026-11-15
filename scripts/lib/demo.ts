// Demo Config values (ESCROW §3.1) and the mint flag shared by init-config / check-config / fund /
// smoke. The allowed mint defaults to Circle devnet USDC from packages/shared.
import { address, type Address } from '@solana/kit';
import { fetchMaybeMint } from '@solana-program/token';

import { USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';

import { TOKEN_PROGRAM, type ChainRpc } from './chain';

export const DEMO_CONFIG = {
  /** $20 per side. */
  maxStake: 20_000_000n,
  appealWindowSecs: 10,
  /** Cap; the server passes skill `now + 300`, gemini `quotedAt + 60`. */
  acceptDeadlineSecs: 600,
  resolveDeadlineSecs: 3600,
  appealResolveSecs: 300,
} as const;

export const REQUIRED_DECIMALS = 6;

export const MINT_OPTION = {
  mint: { type: 'string' },
} as const;

export function mintFrom(flag: string | undefined): Address {
  return address(flag ?? USDC_MINT_DEVNET);
}

/** Throws unless `mint` is a classic SPL Token mint with 6 decimals (create_bet's WrongDecimals). */
export async function assertUsdcLikeMint(rpc: ChainRpc, mint: Address): Promise<void> {
  const acc = await fetchMaybeMint(rpc, mint, { commitment: 'confirmed' });
  if (!acc.exists) throw new Error(`mint ${mint} does not exist on this cluster`);
  if (acc.programAddress !== TOKEN_PROGRAM) {
    throw new Error(`mint ${mint} is owned by ${acc.programAddress}, not classic SPL Token`);
  }
  if (acc.data.decimals !== REQUIRED_DECIMALS) {
    throw new Error(`mint ${mint} has ${acc.data.decimals} decimals; the escrow requires 6`);
  }
}
