// Observes the seed buffers the wallet hands to noble, then checks they were zeroed afterwards.
import { describe, expect, it, vi } from 'vitest';

import { createWallet } from '../wallet';
import { createFakePlatform } from './fakes';

const seen = vi.hoisted(() => ({
  sign: [] as Uint8Array[],
  getPublicKey: [] as Uint8Array[],
  throwOnSign: false,
}));

vi.mock('../noble', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../noble')>();
  return {
    ...orig,
    ed: {
      ...orig.ed,
      sign: (message: Uint8Array, secretKey: Uint8Array) => {
        seen.sign.push(secretKey);
        if (seen.throwOnSign) throw new Error('sign failed');
        return orig.ed.sign(message, secretKey);
      },
      getPublicKey: (secretKey: Uint8Array) => {
        seen.getPublicKey.push(secretKey);
        return orig.ed.getPublicKey(secretKey);
      },
    },
  };
});

const zero = (b: Uint8Array) => b.every((x) => x === 0);

describe('seed wiping', () => {
  it('wipes the generated seed after creation and the read seed after every signature', async () => {
    const platform = createFakePlatform();
    const wallet = createWallet(platform);
    await wallet.ensureWallet();
    expect(seen.getPublicKey).toHaveLength(1);
    expect(seen.getPublicKey.every(zero)).toBe(true);

    await wallet.authorize(new Uint8Array([1, 2, 3]), 'Lock in $5.00 vs Jake');
    await wallet.authorize(new Uint8Array([4, 5, 6]), 'Lock in $5.00 vs Jake');
    expect(seen.sign).toHaveLength(2);
    expect(seen.sign.every((s) => s.length === 32 && zero(s))).toBe(true);
    expect(seen.sign[0]).not.toBe(seen.sign[1]); // a fresh buffer per read
  });

  it('wipes the seed even when signing throws', async () => {
    const platform = createFakePlatform();
    const wallet = createWallet(platform);
    await wallet.ensureWallet();
    seen.sign.length = 0;
    seen.throwOnSign = true;
    await expect(wallet.authorize(new Uint8Array([1]), 'x')).rejects.toThrow('sign failed');
    seen.throwOnSign = false;
    expect(seen.sign).toHaveLength(1);
    expect(seen.sign.every((s) => s.length === 32 && zero(s))).toBe(true);
  });
});
