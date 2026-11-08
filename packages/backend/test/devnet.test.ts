/**
 * DevnetChain pieces that need no network: §9.6 error names from RPC
 * failures, and the startup mint init (no route sees a mint-less chain).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { customErrorName, DevnetChain, programErrorName, txErrorName } from '../src/chain/devnet.js';
import { requireIdl } from '../src/chain/idl.js';
import { loadConfig } from '../src/config/load.js';
import { createContext } from '../src/context.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { ApiError } from '../src/errors.js';
import { ManualClock } from '../src/util/clock.js';
import { testEnv } from './helpers.js';

const idl = requireIdl();
const errs = idl.errors ?? [];

describe('devnet error names (§9.6)', () => {
  it('maps custom program errors through the IDL, keeps runtime names, and never returns the raw dump', () => {
    const n = (code: number) => errs.find((e) => e.code === code)!.name;
    expect(customErrorName(6000, errs)).toBe(n(6000));
    const msg = 'Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x177d. \nLogs: \n[...]';
    expect(programErrorName(msg, null, errs)).toBe(n(0x177d));
    expect(programErrorName('x', ['Program log: AnchorError occurred. Error Code: ConsentMismatch. Error Number: 6013.'], errs)).toBe('ConsentMismatch');
    expect(programErrorName('custom program error: 0x1', ['Program log: Error: insufficient funds'], errs)).toBe('InsufficientFunds');
    expect(programErrorName('custom program error: 0x2a', [], errs)).toBe('Custom(42)');
    expect(programErrorName('Blockhash not found', null, errs)).toBe('BlockhashNotFound');
    expect(programErrorName('something else', null, errs)).toBe('TransactionFailed');
    expect(txErrorName({ InstructionError: [2, { Custom: 6001 }] }, errs)).toBe(n(6001));
    expect(txErrorName({ InstructionError: [0, 'InvalidAccountData'] }, errs)).toBe('InvalidAccountData');
    expect(txErrorName('InsufficientFundsForFee', errs)).toBe('InsufficientFunds');
  });
});

describe('devnet test mint at startup', () => {
  it('the mint getter is a typed 503, and init() creates the mint before the server is ready', async () => {
    const chain = new DevnetChain({
      idl,
      programId: idl.address,
      rpcUrl: 'http://127.0.0.1:9',
      clock: new ManualClock(0),
      feePayer: generateKeypair(),
      oracle: generateKeypair(),
      mint: null,
      mintStatePath: '/nonexistent/verdict-mint.json',
    });
    let err: unknown;
    try {
      void chain.mint;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    const ensure = vi.spyOn(chain, 'ensureTestMint').mockResolvedValue('So11111111111111111111111111111111111111112');
    await chain.init();
    expect(ensure).toHaveBeenCalledTimes(1);

    // The app awaits chain.init() on ready.
    const ctx = createContext(loadConfig(testEnv()), { clock: new ManualClock(1_760_000_000_000), inMemory: true });
    const init = vi.fn(async () => {});
    (ctx.chain as { init?: () => Promise<void> }).init = init;
    const app = await buildApp(ctx, { startKeeper: false });
    await app.ready();
    expect(init).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
