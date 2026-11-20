// The native surface the wallet needs, as a small injected interface. The real implementation is
// ./expoPlatform.ts (expo-secure-store, expo-local-authentication, expo-crypto); tests pass fakes, so
// all wallet logic runs in Node. Only `import type` from Expo here: nothing native loads in tests.
import type {
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
} from 'expo-local-authentication';
import type { SecureStoreOptions } from 'expo-secure-store';
import type { DevicePolicyPins } from '@youre-on/shared/device-policy';

export type {
  LocalAuthenticationError,
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
} from 'expo-local-authentication';
export type { SecureStoreOptions } from 'expo-secure-store';

/** The subset of expo-secure-store the wallet uses. */
export type SecureStoreLike = {
  /** The Keychain accessibility constant (expo-secure-store's `WHEN_UNLOCKED_THIS_DEVICE_ONLY`). */
  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
  getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
};

/** The subset of expo-local-authentication the wallet uses. */
export type LocalAuthLike = {
  authenticateAsync(options?: LocalAuthenticationOptions): Promise<LocalAuthenticationResult>;
};

export type WalletPlatform = {
  readonly secureStore: SecureStoreLike;
  readonly localAuth: LocalAuthLike;
  /**
   * Fills `array` in place with CSPRNG bytes: expo-crypto `getRandomValues` (native SecRandomCopyBytes).
   * Never `getRandomBytes`, which falls back to Math.random in __DEV__.
   */
  getRandomValues(array: Uint8Array): Uint8Array;
  /** Wall clock in ms (defaults to Date.now). Injected so tests control timestamps. */
  now?: () => number;
  /**
   * TESTS ONLY: replaces the device policy's compiled-in DEVICE_POLICY_PINS (the G1 root of trust)
   * so fixture worlds can use their own fee payer / mint. expoPlatform never sets it, and the
   * policy ignores it in a release build. Screens cannot reach it: requests carry no pins.
   */
  policyPinsForTests?: DevicePolicyPins;
};
