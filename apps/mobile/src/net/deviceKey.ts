// The device auth key (API-CONTRACT §1.3): ed25519, SEPARATE from the wallet key, signs login
// challenges and every API write. No Face ID gate (that would prompt on every request), so its
// seed stays in memory once loaded. Keychain: WHEN_UNLOCKED_THIS_DEVICE_ONLY, no
// requireAuthentication, like the wallet. Item names never collide with the wallet's.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { base58Encode } from '../wallet/bytes';
import { ed } from '../wallet/noble';
import type { SecureStoreLike, SecureStoreOptions } from '../wallet/platform';

export const DEVICE_SEED_KEY = 'youreon.device.seed.v1';

export interface DeviceKey {
  /** base58 = devices.device_pubkey */
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array;
}

export interface DeviceKeyPlatform {
  secureStore: SecureStoreLike;
  getRandomValues(a: Uint8Array): Uint8Array;
}

export function deviceKeyFromSeed(seed: Uint8Array): DeviceKey {
  if (seed.length !== 32) throw new Error('device seed must be 32 bytes');
  const own = Uint8Array.from(seed);
  return {
    publicKey: base58Encode(ed.getPublicKey(own)),
    sign: (m) => ed.sign(m, own),
  };
}

const cache = new WeakMap<SecureStoreLike, Promise<DeviceKey>>();

/** Loads the device key, creating it on first run. Concurrent callers share one creation. */
export function loadDeviceKey(p: DeviceKeyPlatform): Promise<DeviceKey> {
  const hit = cache.get(p.secureStore);
  if (hit) return hit;
  const run = (async () => {
    const opts: SecureStoreOptions = {
      keychainAccessible: p.secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    };
    const hex = await p.secureStore.getItemAsync(DEVICE_SEED_KEY, opts);
    if (hex !== null && /^[0-9a-f]{64}$/.test(hex)) return deviceKeyFromSeed(hexToBytes(hex));
    const seed = p.getRandomValues(new Uint8Array(32));
    if (seed.every((b) => b === 0)) throw new Error('random source returned no entropy');
    await p.secureStore.setItemAsync(DEVICE_SEED_KEY, bytesToHex(seed), opts);
    return deviceKeyFromSeed(seed);
  })();
  cache.set(p.secureStore, run);
  run.catch(() => cache.delete(p.secureStore));
  return run;
}
