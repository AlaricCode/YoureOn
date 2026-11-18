// src/chain/tx.ts with a fake ChainClient (no RPC, no DB): send with preflight, the status poll,
// re-broadcast of the same bytes, onchain failure, timeout; key parsing; env -> runtime.
import { describe, expect, it } from 'vitest';
import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getSignatureFromTransaction,
  type Base64EncodedWireTransaction,
} from '@solana/kit';
import {
  buildBlockhashTx,
  chainRuntimeFromEnv,
  customErrorCode,
  cuWithMargin,
  parseSecretKey,
  PreflightError,
  redactUrl,
  sendAndConfirm,
  SimulationError,
  TxFailedError,
  type ChainClient,
  type SigStatus,
} from '../src/chain/tx';
import { testEnv } from './helpers';

const MEMO = address('ComputeBudget111111111111111111111111111111');

function fakeClient(over: Partial<ChainClient> = {}): ChainClient & {
  sends: Array<{ wire: string; skip: boolean }>;
  statuses: Array<SigStatus | null>;
} {
  const sends: Array<{ wire: string; skip: boolean }> = [];
  const statuses: Array<SigStatus | null> = [];
  return {
    sends,
    statuses,
    label: 'fake',
    assertSafeCluster: async () => 'localnet',
    latestBlockhash: async () => ({
      blockhash: 'SysvarC1ock11111111111111111111111111111111',
      lastValidBlockHeight: 100n,
    }),
    simulate: async () => ({ err: null, unitsConsumed: 1_000n, logs: [] }),
    send: async (wire: Base64EncodedWireTransaction, skip: boolean) => {
      sends.push({ wire, skip });
    },
    signatureStatus: async () => (statuses.length ? statuses.shift()! : null),
    blockHeight: async () => 50n,
    getAccount: async () => null,
    tokenBalanceByOwner: async () => 0n,
    lamports: async () => 0n,
    ...over,
  };
}

const memoIx = { programAddress: MEMO, data: new TextEncoder().encode('yo') };
const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe('chain/tx', () => {
  it('cuWithMargin: x1.3, at least +10k, capped at 1.4M', () => {
    expect(cuWithMargin(1_000n)).toBe(11_000);
    expect(cuWithMargin(100_000n)).toBe(130_000);
    expect(cuWithMargin(1_300_000n)).toBe(1_400_000);
  });

  it('buildBlockhashTx simulates at the max limit, rebuilds with the margin on the same blockhash, signs', async () => {
    const fp = await generateKeyPairSigner();
    const sims: string[] = [];
    const client = fakeClient({
      simulate: async (wire) => {
        sims.push(wire);
        return { err: null, unitsConsumed: 5_000n, logs: [] };
      },
    });
    const built = await buildBlockhashTx(client, fp.address, [memoIx], {
      signers: [fp],
      label: 'memo',
    });
    expect(sims).toHaveLength(1);
    expect(built.cuLimit).toBe(15_000);
    expect(built.lastValidBlockHeight).toBe(100n);
    expect(built.tx.signatures[fp.address]).toBeTruthy();
    const failing = fakeClient({
      simulate: async () => ({
        err: { InstructionError: [1, { Custom: 6025 }] },
        unitsConsumed: 0n,
        logs: ['x'],
      }),
    });
    const e = await buildBlockhashTx(failing, fp.address, [memoIx], { label: 'memo' }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SimulationError);
    expect(customErrorCode((e as SimulationError).err)).toBe(6025);
  });

  it('sendAndConfirm: preflight once, polls, re-broadcasts the same bytes with preflight off, returns at confirmed', async () => {
    const fp = await generateKeyPairSigner();
    const client = fakeClient();
    const { tx } = await buildBlockhashTx(client, fp.address, [memoIx], {
      signers: [fp],
      label: 'memo',
    });
    client.statuses.push(null, null, null, {
      err: null,
      confirmationStatus: 'processed',
      slot: 1n,
    });
    client.statuses.push({ err: null, confirmationStatus: 'confirmed', slot: 2n });
    const processed: number[] = [];
    const clock = fastClock();
    const landed = await sendAndConfirm(client, tx, {
      pollMs: 400,
      resendMs: 800,
      ...clock,
      onProcessed: (at) => processed.push(at),
    });
    expect(landed.signature).toBe(getSignatureFromTransaction(tx));
    expect(landed.slot).toBe(2n);
    expect(processed).toHaveLength(1);
    expect(client.sends[0]!.skip).toBe(false); // the first send has preflight ON
    expect(client.sends.slice(1).every((s) => s.skip && s.wire === client.sends[0]!.wire)).toBe(
      true,
    );
    expect(client.sends.length).toBeGreaterThan(1);
  });

  it('sendAndConfirm: onchain error -> TxFailedError(onchain); expiry; timeout; preflight rejection propagates', async () => {
    const fp = await generateKeyPairSigner();
    const client = fakeClient();
    const { tx, lastValidBlockHeight } = await buildBlockhashTx(client, fp.address, [memoIx], {
      signers: [fp],
      label: 'memo',
    });
    client.statuses.push({
      err: { InstructionError: [0, { Custom: 1 }] },
      confirmationStatus: 'processed',
      slot: 1n,
    });
    await expect(sendAndConfirm(client, tx, fastClock())).rejects.toMatchObject({
      kind: 'onchain',
    });

    const expired = fakeClient({ blockHeight: async () => 101n });
    await expect(
      sendAndConfirm(expired, tx, { ...fastClock(), lastValidBlockHeight, resendMs: 400 }),
    ).rejects.toMatchObject({ kind: 'expired' });

    const never = fakeClient();
    const e = await sendAndConfirm(never, tx, { ...fastClock(), timeoutMs: 5_000 }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(TxFailedError);
    expect((e as TxFailedError).kind).toBe('timeout');

    const rejecting = fakeClient({
      send: async () => {
        throw new PreflightError('nope', { InstructionError: [2, { Custom: 1 }] }, []);
      },
    });
    await expect(sendAndConfirm(rejecting, tx, fastClock())).rejects.toBeInstanceOf(PreflightError);
  });

  it('parseSecretKey: base58 64-byte, base58 32-byte seed, and solana-keygen JSON give the same key', async () => {
    const seed = new Uint8Array(32).map((_, i) => i + 1);
    const { createKeyPairSignerFromPrivateKeyBytes } = await import('@solana/kit');
    const kp = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const pub = new Uint8Array(
      (await import('@solana/kit')).getAddressEncoder().encode(kp.address),
    );
    const full = new Uint8Array([...seed, ...pub]);
    const b58 = getBase58Decoder();
    expect((await parseSecretKey(b58.decode(full))).address).toBe(kp.address);
    expect((await parseSecretKey(b58.decode(seed))).address).toBe(kp.address);
    expect((await parseSecretKey(JSON.stringify([...full]))).address).toBe(kp.address);
    await expect(parseSecretKey('abc')).rejects.toThrow(/32 or 64 bytes/);
  });

  it('chainRuntimeFromEnv: null without RPC or fee payer; never prints the RPC token', async () => {
    expect(await chainRuntimeFromEnv(testEnv())).toBeNull();
    expect(
      await chainRuntimeFromEnv(testEnv({ SOLANA_DEVNET_RPC: 'https://x.quiknode.pro/abc/' })),
    ).toBeNull();
    const seed = getBase58Decoder().decode(new Uint8Array(32).fill(7));
    const rt = await chainRuntimeFromEnv(
      testEnv({
        SOLANA_DEVNET_RPC: 'https://x.quiknode.pro/secret-token/',
        FEE_PAYER_SECRET_KEY: seed,
        DEMO_A_SECRET_KEY: seed,
      }),
    );
    expect(rt!.client.label).toBe('https://x.quiknode.pro/…');
    expect(rt!.keys.demoA!.address).toBe(rt!.keys.feePayer.address);
    expect(rt!.keys.judge).toBeNull();
    expect(rt!.mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(redactUrl('http://127.0.0.1:8899')).toBe('http://127.0.0.1:8899');
  });
});
