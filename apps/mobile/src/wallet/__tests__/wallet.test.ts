import { createHash, createPublicKey, randomBytes, verify as nodeVerify } from 'node:crypto';

import { address, getPublicKeyFromAddress, signatureBytes, verifySignature } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { base58Decode, base58Encode } from '../bytes';
import { ed } from '../noble';
import {
  createWallet,
  MAX_MESSAGE_BYTES,
  PUBKEY_KEY,
  SEED_KEY,
  WalletError,
  type WalletErrorCode,
} from '../wallet';
import {
  createFakePlatform,
  FAKE_WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  type FakePlatform,
} from './fakes';

const PROMPT = {
  promptMessage: 'Lock in $5.00 vs Jake',
  fallbackLabel: 'Use Passcode',
  cancelLabel: 'Not now',
};

async function setup(): Promise<{
  platform: FakePlatform;
  wallet: ReturnType<typeof createWallet>;
  publicKey: string;
}> {
  const platform = createFakePlatform();
  const wallet = createWallet(platform);
  const { publicKey } = await wallet.ensureWallet();
  platform.events.length = 0;
  return { platform, wallet, publicKey };
}

async function expectWalletError(promise: Promise<unknown>, code: WalletErrorCode) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WalletError);
  expect((err as WalletError).code).toBe(code);
  return err as WalletError;
}

function nodeVerifies(message: Uint8Array, signature: Uint8Array, publicKeyB58: string): boolean {
  const key = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(base58Decode(publicKeyB58)).toString('base64url'),
    },
    format: 'jwk',
  });
  return nodeVerify(null, message, key, signature);
}

describe('wallet creation and storage', () => {
  it('creates a seed from getRandomValues and stores seed + pubkey with the right Keychain options', async () => {
    const platform = createFakePlatform();
    const wallet = createWallet(platform);
    const { publicKey, created } = await wallet.ensureWallet();
    expect(created).toBe(true);
    expect(platform.events.filter((e) => e.kind === 'random')).toEqual([
      { kind: 'random', length: 32 },
    ]);

    const sets = platform.events.filter((e) => e.kind === 'set');
    expect(sets.map((e) => e.key)).toEqual([SEED_KEY, PUBKEY_KEY]); // seed first, then the separate pubkey item
    for (const e of platform.events) {
      if (e.kind === 'set' || e.kind === 'get' || e.kind === 'delete') {
        expect(e.options).toEqual({
          keychainAccessible: FAKE_WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          requireAuthentication: false,
        });
      }
    }
    const seedHex = platform.items.get(SEED_KEY) as string;
    expect(seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(platform.items.get(PUBKEY_KEY)).toBe(publicKey);
    expect(base58Encode(ed.getPublicKey(Buffer.from(seedHex, 'hex')))).toBe(publicKey);
    expect(base58Decode(publicKey)).toHaveLength(32);
  });

  it('app start (getPublicKey / ensureWallet on an existing wallet) never reads the seed or prompts', async () => {
    const { platform, wallet, publicKey } = await setup();
    expect(await wallet.getPublicKey()).toBe(publicKey);
    expect(await wallet.ensureWallet()).toEqual({ publicKey, created: false });
    expect(platform.events.every((e) => e.kind === 'get' && e.key === PUBKEY_KEY)).toBe(true);
  });

  it('never overwrites an existing seed: a missing pubkey item is recovered from the seed', async () => {
    const { platform, wallet, publicKey } = await setup();
    const seedBefore = platform.items.get(SEED_KEY);
    platform.items.delete(PUBKEY_KEY);
    expect(await wallet.ensureWallet()).toEqual({ publicKey, created: false });
    expect(platform.items.get(SEED_KEY)).toBe(seedBefore);
    expect(platform.items.get(PUBKEY_KEY)).toBe(publicKey);
    expect(platform.events.some((e) => e.kind === 'random')).toBe(false);
  });

  it('rejects a random source that returns no entropy', async () => {
    const platform = createFakePlatform({ getRandomValues: (a) => a });
    await expectWalletError(createWallet(platform).ensureWallet(), 'BAD_RANDOM');
    expect(platform.items.size).toBe(0);
  });

  it('importSeed stores a provisioned seed, wipes the input, and refuses to clobber unless asked', async () => {
    const platform = createFakePlatform();
    const wallet = createWallet(platform);
    const seed = new Uint8Array(randomBytes(32));
    const expected = base58Encode(ed.getPublicKey(seed));
    expect(await wallet.importSeed(seed, { replaceExisting: false })).toEqual({
      publicKey: expected,
    });
    expect(seed.every((b) => b === 0)).toBe(true);
    await expectWalletError(
      wallet.importSeed(new Uint8Array(randomBytes(32)), { replaceExisting: false }),
      'WALLET_EXISTS',
    );
    expect(await wallet.getPublicKey()).toBe(expected);
    const other = new Uint8Array(randomBytes(32));
    const otherPub = base58Encode(ed.getPublicKey(other));
    expect(await wallet.importSeed(other, { replaceExisting: true })).toEqual({
      publicKey: otherPub,
    });
  });

  it('concurrent ensureWallet calls mint one seed and agree on one public key', async () => {
    const platform = createFakePlatform();
    const one = createWallet(platform);
    const two = createWallet(platform); // a second instance over the same Keychain
    const results = await Promise.all([
      one.ensureWallet(),
      one.ensureWallet(),
      two.ensureWallet(),
      two.ensureWallet(),
    ]);
    const keys = new Set(results.map((r) => r.publicKey));
    expect(keys.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(platform.events.filter((e) => e.kind === 'random')).toHaveLength(1);
    const [publicKey] = [...keys];
    const seedHex = platform.items.get(SEED_KEY) as string;
    expect(base58Encode(ed.getPublicKey(Buffer.from(seedHex, 'hex')))).toBe(publicKey);
    // And the key every caller was given can actually sign.
    const signed = await one.authorize(new Uint8Array([7]), PROMPT);
    expect(signed.publicKey).toBe(publicKey);
  });

  it('an interrupted replace never leaves the old pubkey next to the new seed', async () => {
    const { platform, wallet, publicKey: oldKey } = await setup();
    const fresh = new Uint8Array(randomBytes(32));
    const freshKey = base58Encode(ed.getPublicKey(fresh));
    platform.failSet = (key) => key === PUBKEY_KEY; // the app dies after the seed write
    await expect(wallet.importSeed(fresh, { replaceExisting: true })).rejects.toThrow(
      /simulated crash/,
    );
    platform.failSet = undefined;
    expect(await wallet.getPublicKey()).toBeNull(); // the stale pubkey is gone
    expect(await wallet.ensureWallet()).toEqual({ publicKey: freshKey, created: false });
    expect(freshKey).not.toBe(oldKey);
    const signed = await wallet.authorize(new Uint8Array([1]), PROMPT);
    expect(ed.verify(signed.signature, new Uint8Array([1]), base58Decode(freshKey))).toBe(true);
  });

  it('refuses to sign when the stored seed does not derive the stored public key', async () => {
    const { platform, wallet } = await setup();
    platform.items.set(PUBKEY_KEY, base58Encode(ed.getPublicKey(new Uint8Array(randomBytes(32)))));
    await expectWalletError(wallet.authorize(new Uint8Array([1]), PROMPT), 'KEY_MISMATCH');
  });

  it('flags a corrupt stored seed', async () => {
    const { platform, wallet } = await setup();
    platform.items.set(SEED_KEY, 'zz');
    await expectWalletError(wallet.authorize(new Uint8Array([1]), PROMPT), 'CORRUPT_SEED');
  });
});

describe('authorize(messageBytes, prompt)', () => {
  it('signs after Face ID; the signature verifies with noble, node:crypto and @solana/kit', async () => {
    const { platform, wallet, publicKey } = await setup();
    for (let i = 0; i < 10; i++) {
      const message = new Uint8Array(randomBytes(200 + i * 50));
      const result = await wallet.authorize(message, PROMPT);
      expect(result.signature).toHaveLength(64);
      expect(result.publicKey).toBe(publicKey);
      expect(base58Decode(result.signatureBase58)).toEqual(result.signature);
      expect(ed.verify(result.signature, message, base58Decode(publicKey))).toBe(true);
      expect(nodeVerifies(message, result.signature, publicKey)).toBe(true);
      const kitKey = await getPublicKeyFromAddress(address(publicKey));
      expect(await verifySignature(kitKey, signatureBytes(result.signature), message)).toBe(true);
      // Tampered message must fail.
      const tampered = Uint8Array.from(message);
      tampered[0] = (tampered[0] as number) ^ 1;
      expect(ed.verify(result.signature, tampered, base58Decode(publicKey))).toBe(false);
      expect(result.messageSha256).toBe(createHash('sha256').update(message).digest('hex'));
    }
    expect(platform.events.filter((e) => e.kind === 'auth')).toHaveLength(10);
  });

  it('runs LocalAuthentication before reading the seed (order: auth -> read seed)', async () => {
    const { platform, wallet } = await setup();
    await wallet.authorize(new Uint8Array([1, 2, 3]), PROMPT);
    const order = platform.events.map((e) => (e.kind === 'get' ? `get:${e.key}` : e.kind));
    expect(order).toEqual([`get:${PUBKEY_KEY}`, 'auth', `get:${SEED_KEY}`]);
  });

  it('records faceid_hold, or passcode_hold after user_fallback, with the device-clock timestamp', async () => {
    const { platform, wallet } = await setup();
    const first = await wallet.authorize(new Uint8Array([1]), PROMPT);
    expect(first).toMatchObject({ method: 'faceid_hold', prompts: 1 });
    expect(first.authSucceededAtMs).toBe(platform.clock.ms);
    expect(first.authorizedAt).toBe(new Date(platform.clock.ms).toISOString());

    platform.authResults.push({ success: false, error: 'user_fallback' }, { success: true });
    const second = await wallet.authorize(new Uint8Array([1]), PROMPT);
    expect(second).toMatchObject({ method: 'passcode_hold', prompts: 2 });
    const auths = platform.events.filter((e) => e.kind === 'auth');
    expect(auths.map((e) => (e.kind === 'auth' ? e.options?.disableDeviceFallback : null))).toEqual(
      [true, true, false],
    );
  });

  it('a cancelled prompt never reads the seed', async () => {
    const { platform, wallet } = await setup();
    platform.authResults.push({ success: false, error: 'user_cancel' });
    const err = await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT),
      'AUTH_CANCELLED',
    );
    expect(err.authError).toBe('user_cancel');
    expect(err.authStage).toBe('faceid');
    expect(platform.events.some((e) => e.kind === 'get' && e.key === SEED_KEY)).toBe(false);
  });

  it('other auth failures map to AUTH_FAILED', async () => {
    const { platform, wallet } = await setup();
    platform.authResults.push({ success: false, error: 'authentication_failed' });
    const err = await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT),
      'AUTH_FAILED',
    );
    expect(err.authError).toBe('authentication_failed');
  });

  it('no Face ID enrolled: the passcode prompt signs, recorded as passcode_hold', async () => {
    const { platform, wallet } = await setup();
    platform.authResults.push({ success: false, error: 'not_enrolled' }, { success: true });
    const r = await wallet.authorize(new Uint8Array([1]), PROMPT);
    expect(r.method).toBe('passcode_hold');
    expect(r.prompts).toBe(2);
  });

  it('no Face ID and no passcode (a bare simulator) is AUTH_FAILED at the passcode stage', async () => {
    const { platform, wallet } = await setup();
    platform.authResults.push(
      { success: false, error: 'not_enrolled' },
      { success: false, error: 'passcode_not_set' },
    );
    const err = await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT),
      'AUTH_FAILED',
    );
    expect(err.authError).toBe('passcode_not_set');
    expect(err.authStage).toBe('passcode');
  });

  it('runs the device policy before any prompt; a rejection shows no Face ID', async () => {
    const { platform, wallet } = await setup();
    await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT, { policy: () => false }),
      'POLICY_REJECTED',
    );
    const err = await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT, {
        policy: () => {
          throw new Error('mint is not the pinned USDC');
        },
      }),
      'POLICY_REJECTED',
    );
    expect(err.message).toContain('pinned USDC');
    expect(platform.events.some((e) => e.kind === 'auth')).toBe(false);

    // An async policy (a Promise) or any non-boolean result must never count as a pass.
    const asyncPolicy = (() => Promise.resolve(true)) as unknown as () => boolean;
    await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT, { policy: asyncPolicy }),
      'POLICY_REJECTED',
    );
    const strayValue = (() => 1) as unknown as () => boolean;
    await expectWalletError(
      wallet.authorize(new Uint8Array([1]), PROMPT, { policy: strayValue }),
      'POLICY_REJECTED',
    );
    expect(platform.events.some((e) => e.kind === 'auth')).toBe(false);

    let seen: Uint8Array | undefined;
    const ok = await wallet.authorize(new Uint8Array([9, 9]), PROMPT, {
      policy: (m) => void (seen = m),
    });
    expect(Array.from(seen ?? [])).toEqual([9, 9]);
    expect(ok.signature).toHaveLength(64);
  });

  it('signs exactly the bytes the policy saw, even if the caller mutates its buffer mid-prompt', async () => {
    const { platform, wallet, publicKey } = await setup();
    const message = new Uint8Array([1, 2, 3, 4]);
    platform.onAuth = () => message.fill(0xee);
    const result = await wallet.authorize(message, PROMPT);
    expect(ed.verify(result.signature, new Uint8Array([1, 2, 3, 4]), base58Decode(publicKey))).toBe(
      true,
    );
  });

  it('rejects empty and oversized messages without prompting', async () => {
    const { platform, wallet } = await setup();
    await expectWalletError(wallet.authorize(new Uint8Array(0), PROMPT), 'BAD_MESSAGE');
    await expectWalletError(
      wallet.authorize(new Uint8Array(MAX_MESSAGE_BYTES + 1), PROMPT),
      'BAD_MESSAGE',
    );
    expect(platform.events.some((e) => e.kind === 'auth')).toBe(false);
  });

  it('refuses a concurrent authorization', async () => {
    const { wallet } = await setup();
    const first = wallet.authorize(new Uint8Array([1]), PROMPT);
    await expectWalletError(wallet.authorize(new Uint8Array([2]), PROMPT), 'BUSY');
    await expect(first).resolves.toMatchObject({ method: 'faceid_hold' });
    await expect(wallet.authorize(new Uint8Array([3]), PROMPT)).resolves.toMatchObject({
      method: 'faceid_hold',
    });
  });

  it('fails with NO_WALLET when there is no wallet, without prompting', async () => {
    const platform = createFakePlatform();
    await expectWalletError(
      createWallet(platform).authorize(new Uint8Array([1]), PROMPT),
      'NO_WALLET',
    );
    expect(platform.events.some((e) => e.kind === 'auth')).toBe(false);
  });

  it('destroy removes both items, pubkey first', async () => {
    const { platform, wallet } = await setup();
    await wallet.destroy();
    expect(platform.items.size).toBe(0);
    expect(
      platform.events.filter((e) => e.kind === 'delete').map((e) => e.kind === 'delete' && e.key),
    ).toEqual([PUBKEY_KEY, SEED_KEY]);
    expect(await wallet.getPublicKey()).toBeNull();
  });
});
