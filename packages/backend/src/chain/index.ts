/**
 * Chain client factory: SOLANA_MODE=mock → MockChain (engine chainModel),
 * devnet → DevnetChain (free network; only constructed when configured).
 */
import { join } from 'node:path';
import type { Config } from '../config/load.js';
import type { Clock } from '../util/clock.js';
import { DevnetChain } from './devnet.js';
import { requireIdl } from './idl.js';
import { MockChain, MOCK_USDC_MINT } from './mock/index.js';
import type { ChainClient } from './types.js';
import type { EncodedGroth16Proof } from '@verdict/engine';

export interface ChainFactoryOptions {
  clock: Clock;
  /** persist mock chain state under DATA_DIR (default true when dataDir is set) */
  persist?: boolean;
  verifyGroth16?: (publicInputs: Uint8Array[], proof: EncodedGroth16Proof) => boolean;
  onListenerError?: (e: unknown) => void;
}

export function createChainClient(cfg: Config, opts: ChainFactoryOptions): ChainClient {
  const idl = requireIdl();
  const persist = opts.persist ?? true;
  if (cfg.solanaMode === 'mock') {
    return new MockChain({
      idl,
      programId: cfg.programId,
      clock: opts.clock,
      feePayer: cfg.keys.feePayer,
      oracle: cfg.keys.oracle,
      extraSigners: cfg.keys.judges,
      mint: cfg.usdcMint ?? MOCK_USDC_MINT,
      persistPath: persist ? join(cfg.dataDir, 'mockchain.json') : null,
      ...(opts.verifyGroth16 ? { verifyGroth16: opts.verifyGroth16 } : {}),
      ...(opts.onListenerError ? { onListenerError: opts.onListenerError } : {}),
    });
  }
  return new DevnetChain({
    idl,
    programId: cfg.programId,
    rpcUrl: cfg.solanaRpcUrl,
    ...(cfg.solanaWsUrl ? { wsUrl: cfg.solanaWsUrl } : {}),
    clock: opts.clock,
    feePayer: cfg.keys.feePayer,
    oracle: cfg.keys.oracle,
    extraSigners: cfg.keys.judges,
    mint: cfg.usdcMint,
    mintStatePath: join(cfg.dataDir, 'devnet-mint.json'),
  });
}

export * from './types.js';
export * from './ixs.js';
export * from './programs.js';
export { MockChain, MOCK_USDC_MINT, mockSlotHash } from './mock/index.js';
export { DevnetChain, parseProgramLogs } from './devnet.js';
export { ChainEventHandler, TRIGGER_TABLE, eventKey, type ChainEventJson, type ChainTrigger } from './events.js';
export { verifyQuickNodeSignature, quickNodeSignature, parseQuickNodePayload } from './quicknode.js';
export { loadIdl, requireIdl, defaultProgramId } from './idl.js';
export { compileMessage, parseMessage, verdictIx, MAX_TX_BYTES } from './message.js';
