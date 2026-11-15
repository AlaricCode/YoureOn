// The native surface the wallet needs, as a small injected interface. The real implementation is
// ./expoPlatform.ts (expo-secure-store, expo-local-authentication, expo-crypto); tests pass fakes, so
// all wallet logic runs in Node. Only `import type` from Expo here: nothing native loads in tests.
import type {
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
} from 'expo-local-authentication';
import type { SecureStoreOptions } from 'expo-secure-store';

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
   * Never `getRandomBytes`, which falls back to Math.random in __DEV__ (FINDINGS §3.4, §7).
   */
  getRandomValues(array: Uint8Array): Uint8Array;
  /** Wall clock in ms (defaults to Date.now). Injected so tests control timestamps. */
  now?: () => number;
};
