import { randomFillSync } from 'node:crypto';

import type {
  LocalAuthenticationOptions,
  LocalAuthenticationResult,
  SecureStoreOptions,
  WalletPlatform,
} from '../platform';

export type Event =
  | { kind: 'auth'; options: LocalAuthenticationOptions | undefined }
  | { kind: 'get' | 'delete'; key: string; options: SecureStoreOptions | undefined }
  | { kind: 'set'; key: string; value: string; options: SecureStoreOptions | undefined }
  | { kind: 'random'; length: number };

/** A distinctive stand-in for the native constant, so tests can see it was passed through. */
export const FAKE_WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

export type FakePlatform = WalletPlatform & {
  events: Event[];
  items: Map<string, string>;
  /** Queue of results for successive authenticateAsync calls. Empty queue = success. */
  authResults: (LocalAuthenticationResult | Error)[];
  /** Runs inside authenticateAsync before it resolves (e.g. to mutate a caller's buffer mid-prompt). */
  onAuth?: () => void;
  /** Makes setItemAsync throw for a key (simulates the app dying mid-write). */
  failSet?: (key: string) => boolean;
  clock: { ms: number };
};

export function createFakePlatform(
  overrides: Partial<Pick<WalletPlatform, 'getRandomValues'>> = {},
): FakePlatform {
  const events: Event[] = [];
  const items = new Map<string, string>();
  const clock = { ms: Date.UTC(2026, 10, 14, 15, 0, 0) };
  const platform: FakePlatform = {
    events,
    items,
    clock,
    authResults: [],
    secureStore: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: FAKE_WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      async getItemAsync(key, options) {
        events.push({ kind: 'get', key, options });
        return items.get(key) ?? null;
      },
      async setItemAsync(key, value, options) {
        events.push({ kind: 'set', key, value, options });
        if (platform.failSet?.(key)) throw new Error(`simulated crash writing ${key}`);
        items.set(key, value);
      },
      async deleteItemAsync(key, options) {
        events.push({ kind: 'delete', key, options });
        items.delete(key);
      },
    },
    localAuth: {
      async authenticateAsync(options) {
        events.push({ kind: 'auth', options });
        platform.onAuth?.();
        clock.ms += 1200; // Face ID takes a while
        const next = platform.authResults.shift();
        if (next instanceof Error) throw next;
        return next ?? { success: true };
      },
    },
    getRandomValues:
      overrides.getRandomValues ??
      ((array) => {
        events.push({ kind: 'random', length: array.length });
        return randomFillSync(array);
      }),
    now: () => clock.ms,
  };
  return platform;
}
