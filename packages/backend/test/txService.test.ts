import { describe, expect, it } from 'vitest';
import type { ChainClient, SendResult } from '../src/chain/types.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { JsonStore } from '../src/persistence/store.js';
import { TxService } from '../src/tx/service.js';
import { toBase64 } from '../src/util/bytes.js';
import { ManualClock } from '../src/util/clock.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('TxService.submit concurrency', () => {
  it('two concurrent submits of one tx send once, run hooks once and return the same response', async () => {
    const user = generateKeypair();
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const gate = deferred<SendResult>();
    let submits = 0;
    const chain = {
      prepare: async () => ({ message, signers: [user.publicKey], expiresAtMs: Number.MAX_SAFE_INTEGER }),
      submit: async () => {
        submits++;
        return gate.promise;
      },
    } as unknown as ChainClient;
    const txs = new TxService({ store: new JsonStore({ dataDir: null }), chain, clock: new ManualClock(1_000) });
    let hooks = 0;
    txs.onConfirmed('fund', () => {
      hooks++;
    });
    const { sign } = await txs.request({ user: { id: 'u1', wallet: user.publicKey }, kind: 'fund', ixs: [], summary: 'x' });
    const body = { signature_b64: toBase64(user.sign(message)) };

    // A bad signature neither joins nor poisons the in-flight send.
    const p1 = txs.submit(sign.tx_id, 'u1', body);
    const p2 = txs.submit(sign.tx_id, 'u1', body);
    await expect(txs.submit(sign.tx_id, 'u1', { signature_b64: toBase64(new Uint8Array(64)) })).rejects.toMatchObject({ code: 'TX_FAILED' });
    await new Promise((r) => setTimeout(r, 0));
    gate.resolve({ status: 'confirmed', signature: 'sig1', slot: 1n } as unknown as SendResult);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(submits).toBe(1);
    expect(hooks).toBe(1);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ status: 'confirmed', signature: 'sig1' });
    // A later submit returns the stored result without sending.
    expect(await txs.submit(sign.tx_id, 'u1', body)).toEqual(r1);
    expect(submits).toBe(1);
  });
});
