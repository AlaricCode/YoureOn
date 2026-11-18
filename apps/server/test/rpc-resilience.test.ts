// RPC resilience (src/chain/tx.ts): every attempt is time-boxed, socket failures and timeouts are
// retried within a total budget, the stats ring feeds GET /v1/demo/health, and the confirm loop
// treats a failed status poll as "unknown" (never as a failed tx). No network, no DB.
import {
  generateKeyPairSigner,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type Base64EncodedWireTransaction,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  buildBlockhashTx,
  confirmSent,
  instrumentChainClient,
  isNetworkError,
  isRetriableRpcError,
  percentile,
  PreflightError,
  rpcErrorText,
  RpcStats,
  rpcChainClient,
  RpcTimeoutError,
  TxFailedError,
  wireOf,
  withRpcRetry,
  type ChainClient,
  type SigStatus,
} from '../src/chain/tx';

type Req = Parameters<RpcTransport>[0];
const req = (method = 'getBalance', signal?: AbortSignal): Req =>
  ({ payload: { jsonrpc: '2.0', id: 1, method, params: [] }, signal }) as Req;
const noSleep = async () => {};
const fetchFailed = (code: string) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
const http = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    statusCode,
    message: `HTTP ${statusCode}`,
    headers: new Headers(),
  });

/** A transport that never answers until its signal aborts (a hung socket). */
const hung = vi.fn(
  (config: Req) =>
    new Promise((_resolve, reject) => {
      config.signal?.addEventListener('abort', () => reject(config.signal!.reason));
    }),
);

describe('withRpcRetry: timeouts, socket errors, budget', () => {
  it('aborts a hung attempt at timeoutMs and retries it; the error says which method', async () => {
    hung.mockClear();
    const t = withRpcRetry(hung as unknown as RpcTransport, {
      timeoutMs: 20,
      attempts: 3,
      sleep: noSleep,
    });
    const err = await t(req('getSignatureStatuses')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcTimeoutError);
    expect((err as RpcTimeoutError).method).toBe('getSignatureStatuses');
    expect(hung).toHaveBeenCalledTimes(3);
  });

  it('a hung first attempt then an answer: resolves with the answer', async () => {
    let n = 0;
    const inner = vi.fn((config: Req) =>
      n++ === 0 ? hung(config) : Promise.resolve({ jsonrpc: '2.0', result: 7 }),
    );
    const t = withRpcRetry(inner as unknown as RpcTransport, { timeoutMs: 20, sleep: noSleep });
    await expect(t(req())).resolves.toMatchObject({ result: 7 });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('retries socket-level failures (fetch failed ECONNRESET / undici timeouts)', async () => {
    const inner = vi
      .fn()
      .mockRejectedValueOnce(fetchFailed('ECONNRESET'))
      .mockRejectedValueOnce(fetchFailed('UND_ERR_HEADERS_TIMEOUT'))
      .mockResolvedValueOnce({ result: 1 });
    const t = withRpcRetry(inner as unknown as RpcTransport, { sleep: noSleep });
    await expect(t(req())).resolves.toMatchObject({ result: 1 });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('a caller abort is never retried and is not reported as a timeout', async () => {
    const ctrl = new AbortController();
    hung.mockClear();
    const t = withRpcRetry(hung as unknown as RpcTransport, { timeoutMs: 1_000, sleep: noSleep });
    const p = t(req('getBalance', ctrl.signal));
    ctrl.abort(new Error('caller gave up'));
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RpcTimeoutError);
    expect(hung).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the total budget would be exceeded', async () => {
    let t0 = 0;
    const inner = vi.fn().mockRejectedValue(http(429));
    const t = withRpcRetry(inner as unknown as RpcTransport, {
      attempts: 10,
      baseMs: 1_000,
      budgetMs: 2_500,
      now: () => t0,
      sleep: async (ms) => void (t0 += ms),
    });
    await expect(t(req())).rejects.toMatchObject({ context: { statusCode: 429 } });
    // backoffs ~1000 then ~2000: the second would pass the 2.5 s budget.
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('classifies: timeouts, 408, 429, 5xx and socket errors retriable; 4xx and plain errors not', () => {
    expect(isRetriableRpcError(new RpcTimeoutError('x', 1))).toBe(true);
    expect(isRetriableRpcError(http(408))).toBe(true);
    expect(isRetriableRpcError(fetchFailed('ECONNREFUSED'))).toBe(true);
    expect(isRetriableRpcError(http(401))).toBe(false);
    expect(isRetriableRpcError(new Error('fetch failed'))).toBe(false);
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkError(new TypeError('x is not a function'))).toBe(false);
  });

  it('rpcErrorText never leaks a URL (QuickNode URLs embed a token)', () => {
    expect(rpcErrorText(http(503))).toBe('HTTP 503');
    expect(rpcErrorText(fetchFailed('ECONNRESET'))).toBe('network ECONNRESET');
    expect(rpcErrorText(new Error('bad https://x.quiknode.pro/SECRET/ thing'))).toBe(
      'bad <url> thing',
    );
  });
});

describe('RpcStats', () => {
  it('records every logical request through the transport, with p50 / p95 and the last error', async () => {
    const stats = new RpcStats(50);
    let clock = 0;
    const inner = vi.fn(async (config: Req) => {
      const m = (config.payload as { method: string }).method;
      clock += m === 'slow' ? 900 : 10;
      if (m === 'bad') throw http(400);
      return { result: 1 };
    });
    const t = withRpcRetry(inner as unknown as RpcTransport, {
      stats,
      now: () => clock,
      sleep: noSleep,
    });
    for (let i = 0; i < 18; i++) await t(req('getBalance'));
    await t(req('slow'));
    await t(req('slow'));
    await t(req('bad')).catch(() => {});
    const s = stats.snapshot();
    expect(s).toMatchObject({ calls: 21, total: 21, errors: 1, p50_ms: 10, max_ms: 900 });
    expect(s.p95_ms).toBe(900);
    expect(s.last_error).toMatchObject({ method: 'bad', error: 'HTTP 400' });
    expect(s.by_method[0]).toMatchObject({ method: 'slow', calls: 2, p95_ms: 900 });
  });

  it('is a ring: only the last `size` samples count', () => {
    const stats = new RpcStats(3);
    for (const ms of [1000, 1000, 1000, 5, 5, 5])
      stats.record({ method: 'm', ms, ok: true, attempts: 1, at: 0 });
    expect(stats.snapshot()).toMatchObject({ calls: 3, total: 6, p95_ms: 5 });
  });

  it('percentile is nearest-rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it('instrumentChainClient times a ChainClient; a preflight rejection is not an RPC error', async () => {
    const stats = new RpcStats();
    const base = fake({
      send: async () => {
        throw new PreflightError('rejected', { InstructionError: [0, { Custom: 1 }] }, []);
      },
      lamports: async () => {
        throw new Error('boom');
      },
    });
    const c = instrumentChainClient(base, stats);
    await c.blockHeight();
    await expect(c.send('x' as Base64EncodedWireTransaction, false)).rejects.toThrow();
    await expect(c.lamports('11111111111111111111111111111111' as never)).rejects.toThrow();
    const s = c.rpcStats!();
    expect(s).toMatchObject({ calls: 3, errors: 1 });
    expect(s.last_error).toMatchObject({ method: 'getBalance', error: 'boom' });
  });
});

function fake(over: Partial<ChainClient> = {}): ChainClient {
  return {
    label: 'fake',
    assertSafeCluster: async () => 'localnet',
    latestBlockhash: async () => ({
      blockhash: 'SysvarC1ock11111111111111111111111111111111',
      lastValidBlockHeight: 100n,
    }),
    simulate: async () => ({ err: null, unitsConsumed: 1_000n, logs: [] }),
    send: async () => {},
    signatureStatus: async () => null,
    blockHeight: async () => 50n,
    getAccount: async () => null,
    tokenBalanceByOwner: async () => 0n,
    lamports: async () => 0n,
    ...over,
  };
}

describe('confirmSent: a failing status poll is "unknown", not a failure', () => {
  const memo = {
    programAddress: 'ComputeBudget111111111111111111111111111111' as never,
    data: new Uint8Array([1]),
  };
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('keeps polling through RPC errors and returns once the status comes back confirmed', async () => {
    const fp = await generateKeyPairSigner();
    const answers: Array<SigStatus | Error> = [
      new Error('HTTP 503'),
      new Error('timeout'),
      { err: null, confirmationStatus: 'confirmed', slot: 9n },
    ];
    const client = fake({
      signatureStatus: async () => {
        const a = answers.shift() ?? null;
        if (a instanceof Error) throw a;
        return a;
      },
    });
    const built = await buildBlockhashTx(client, fp.address, [memo], {
      signers: [fp],
      label: 't',
    });
    const c = clock();
    const landed = await confirmSent(client, built.tx, { ...c, pollMs: 100 });
    expect(landed.slot).toBe(9n);
  });

  it('only errors until the timeout -> TxFailedError(timeout) naming the poll errors', async () => {
    const fp = await generateKeyPairSigner();
    const client = fake({
      signatureStatus: async () => {
        throw new Error('HTTP 429');
      },
    });
    const built = await buildBlockhashTx(client, fp.address, [memo], {
      signers: [fp],
      label: 't',
    });
    const err = await confirmSent(client, built.tx, {
      ...clock(),
      pollMs: 100,
      timeoutMs: 1_000,
      lastValidBlockHeight: 100n,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxFailedError);
    expect((err as TxFailedError).kind).toBe('timeout');
    expect((err as Error).message).toMatch(/status poll error/);
  });

  it('expiry is declared only when a second status read (after the height read) is still null', async () => {
    const fp = await generateKeyPairSigner();
    let reads = 0;
    const client = fake({
      blockHeight: async () => 500n, // past lastValidBlockHeight
      // Unseen on the first read, then visible: it landed in the last valid block.
      signatureStatus: async () =>
        ++reads >= 2 ? { err: null, confirmationStatus: 'confirmed', slot: 3n } : null,
    });
    const built = await buildBlockhashTx(client, fp.address, [memo], {
      signers: [fp],
      label: 't',
    });
    const landed = await confirmSent(client, built.tx, {
      ...clock(),
      pollMs: 100,
      resendMs: 0,
      lastValidBlockHeight: 100n,
    });
    expect(landed.slot).toBe(3n);
  });

  it('an unreadable block height never declares expiry', async () => {
    const fp = await generateKeyPairSigner();
    const client = fake({
      blockHeight: async () => {
        throw new Error('HTTP 503');
      },
    });
    const built = await buildBlockhashTx(client, fp.address, [memo], {
      signers: [fp],
      label: 't',
    });
    const err = await confirmSent(client, built.tx, {
      ...clock(),
      pollMs: 100,
      resendMs: 0,
      timeoutMs: 500,
      lastValidBlockHeight: 100n,
    }).catch((e: unknown) => e);
    expect((err as TxFailedError).kind).toBe('timeout');
  });
});

describe('rpcChainClient.send: a preflight "rejection" of our own landed tx is not a rejection', () => {
  const fakeRpc = (o: { sendErr?: unknown; status?: unknown; statusErr?: boolean }) => {
    const calls: string[] = [];
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          calls.push('send');
          if (o.sendErr) throw o.sendErr;
          return 'sig';
        },
      }),
      getSignatureStatuses: (_s: unknown, cfg: unknown) => ({
        send: async () => {
          calls.push(`status ${JSON.stringify(cfg)}`);
          if (o.statusErr) throw new Error('HTTP 503');
          return { value: [o.status ?? null] };
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    return { rpc, calls };
  };
  const preflight = (err: unknown) =>
    Object.assign(new Error('Transaction simulation failed'), { context: { err, logs: ['l1'] } });
  const wire = async () => {
    const fp = await generateKeyPairSigner();
    const ix = {
      programAddress: 'ComputeBudget111111111111111111111111111111' as never,
      data: new Uint8Array([1]),
    };
    const built = await buildBlockhashTx(fake(), fp.address, [ix], { signers: [fp], label: 't' });
    return wireOf(built.tx);
  };
  const client = (rpc: Rpc<SolanaRpcApi>) => rpcChainClient('http://127.0.0.1:1', rpc);

  it('AlreadyProcessed (the retried send of a tx that landed): resolves; the poll decides', async () => {
    const f = fakeRpc({
      sendErr: preflight('AlreadyProcessed'),
      status: { err: null, confirmationStatus: 'confirmed', slot: 5n },
    });
    await expect(client(f.rpc).send(await wire(), false)).resolves.toBeUndefined();
    expect(f.calls).toEqual(['send', 'status {"searchTransactionHistory":true}']);
  });

  it('an unknown signature: a real rejection -> PreflightError with the logs', async () => {
    const err = { InstructionError: [2, { Custom: 1 }] };
    const f = fakeRpc({ sendErr: preflight(err) });
    const e = await client(f.rpc)
      .send(await wire(), false)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PreflightError);
    expect((e as PreflightError).err).toEqual(err);
    expect((e as PreflightError).logs).toEqual(['l1']);
  });

  it('the status check failing too: still a PreflightError (never a silent success)', async () => {
    const f = fakeRpc({ sendErr: preflight('BlockhashNotFound'), statusErr: true });
    await expect(client(f.rpc).send(await wire(), false)).rejects.toBeInstanceOf(PreflightError);
  });

  it('a transport error is passed through untouched (no status lookup)', async () => {
    const f = fakeRpc({ sendErr: fetchFailed('ECONNRESET') });
    await expect(client(f.rpc).send(await wire(), false)).rejects.toThrow('fetch failed');
    expect(f.calls).toEqual(['send']);
  });
});
