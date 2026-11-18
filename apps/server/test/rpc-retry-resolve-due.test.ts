// The live-devnet failure on 2026-11-18: a public-RPC 429 on the resolve send left a ruled bet in
// JUDGING for good. Two fixes are pinned here: the chain client's transport retries 429 / 5xx,
// and the resolve-due keeper sweep re-runs onRuling for a decisive ruling that never reached RULED.
import { randomUUID } from 'node:crypto';
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__INVALID_NONCE,
  SolanaError,
  type RpcTransport,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { jcs } from '@youre-on/shared/jcs';
import { isRetriableRpcError, withRpcRetry } from '../src/chain/tx';
import { buildRuling } from '../src/judge/ruling';
import { resolveDue, RESOLVE_GRACE_MS, type ResolveDueDeps } from '../src/payout/resolve-due';
import { sha256Hex } from '../src/crypto';
import { createDb } from '@youre-on/db';
import { DB_URL, describeDb } from './helpers';

const http = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    statusCode,
    message: `HTTP ${statusCode}`,
    headers: new Headers(),
  });

describe('withRpcRetry', () => {
  const noSleep = async () => {};

  it('retries 429 and 5xx, then returns the result', async () => {
    const inner = vi
      .fn()
      .mockRejectedValueOnce(http(429))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce({ jsonrpc: '2.0', result: 42 });
    const t = withRpcRetry(inner as unknown as RpcTransport, { sleep: noSleep });
    await expect(t({ payload: {} } as Parameters<RpcTransport>[0])).resolves.toMatchObject({
      result: 42,
    });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transport error or a 4xx other than 429', async () => {
    for (const err of [
      http(400),
      new SolanaError(SOLANA_ERROR__INVALID_NONCE, {
        actualNonceValue: 'a',
        expectedNonceValue: 'b',
      } as never),
      new Error('boom'),
    ]) {
      const inner = vi.fn().mockRejectedValue(err);
      const t = withRpcRetry(inner as unknown as RpcTransport, { sleep: noSleep });
      await expect(t({ payload: {} } as Parameters<RpcTransport>[0])).rejects.toBe(err);
      expect(inner).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after `attempts` tries with backoff between them', async () => {
    const sleeps: number[] = [];
    const inner = vi.fn().mockRejectedValue(http(429));
    const t = withRpcRetry(inner as unknown as RpcTransport, {
      attempts: 4,
      baseMs: 100,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(t({ payload: {} } as Parameters<RpcTransport>[0])).rejects.toMatchObject({
      context: { statusCode: 429 },
    });
    expect(inner).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
    sleeps.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(100 * 2 ** i);
      expect(ms).toBeLessThan(100 * 2 ** i + 100);
    });
  });

  it('classifies retriable errors', () => {
    expect(isRetriableRpcError(http(429))).toBe(true);
    expect(isRetriableRpcError(http(502))).toBe(true);
    expect(isRetriableRpcError(http(404))).toBe(false);
    expect(isRetriableRpcError(new Error('x'))).toBe(false);
  });
});

describe('resolveDue (keeper sweep)', () => {
  const H = (s: string) => sha256Hex(s);
  const ruling = (betId: string) =>
    buildRuling(
      {
        ruling_id: randomUUID(),
        bet_id: betId,
        attempt_no: 1,
        yes_party: 'B',
        terms_hash: H('terms'),
        evidence_hash: H('clip'),
        frame_hashes: Array.from({ length: 8 }, (_, k) => H(`f${k}`)),
        created_at: '2026-11-18T04:07:32.000Z',
      },
      {
        kind: 'verdict',
        model: 'cache/demo-bottle@1',
        verdict: {
          claim_result: 'MET',
          confidence: 0.93,
          reason: 'Lands upright.',
          cited_frames: [7],
          contested: false,
        },
        disagreement: null,
      },
    );

  const fakeDeps = (rows: { bet_id: string; record_canonical: string }[]) => {
    const onRuling = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue(rows);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
      deps: { db: { execute }, log, onRuling } as unknown as ResolveDueDeps,
      onRuling,
      execute,
      log,
    };
  };

  it('re-runs onRuling with the stored ruling for each stuck bet', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const f = fakeDeps([
      { bet_id: a, record_canonical: jcs(ruling(a)) },
      { bet_id: b, record_canonical: jcs(ruling(b)) },
    ]);
    expect(await resolveDue(f.deps, Date.now())).toBe(2);
    expect(f.onRuling).toHaveBeenCalledTimes(2);
    expect(f.onRuling.mock.calls[0]![0]).toBe(a);
    expect(f.onRuling.mock.calls[0]![1]).toMatchObject({ bet_id: a, outcome: 'B_WINS' });
  });

  it('keeps going when one retry fails, and logs it', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const f = fakeDeps([
      { bet_id: a, record_canonical: jcs(ruling(a)) },
      { bet_id: b, record_canonical: jcs(ruling(b)) },
    ]);
    f.onRuling.mockRejectedValueOnce(http(429));
    expect(await resolveDue(f.deps, Date.now())).toBe(1);
    expect(f.log.warn).toHaveBeenCalledWith(
      'payout.resolve_retry_failed',
      expect.objectContaining({ bet_id: a }),
    );
  });

  it('is a no-op without an onRuling hook', async () => {
    const f = fakeDeps([]);
    const deps = { ...f.deps, onRuling: undefined } as ResolveDueDeps;
    expect(await resolveDue(deps, Date.now())).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('exposes a grace period longer than the in-process call', () => {
    expect(RESOLVE_GRACE_MS).toBeGreaterThanOrEqual(10_000);
  });
});

// The unit tests above fake db.execute; this one runs the real query on Postgres, the gap that let
// a Date parameter crash the sweep on the live server.
describeDb('resolveDue (real Postgres)', () => {
  it('runs its query and hands every row a ruling for the same bet', async () => {
    const handle = createDb({ url: DB_URL! });
    try {
      const onRuling = vi.fn().mockResolvedValue(undefined);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const deps = { db: handle.db, log, onRuling } as unknown as ResolveDueDeps;
      const n = await resolveDue(deps, Date.now());
      expect(n).toBe(onRuling.mock.calls.length);
      for (const [betId, r] of onRuling.mock.calls) expect(r.bet_id).toBe(betId);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });
});
