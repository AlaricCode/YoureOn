// The real native platform for the wallet. App code only: tests never import this file.
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import type { WalletPlatform } from './platform';

export const expoWalletPlatform: WalletPlatform = {
  secureStore: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    getItemAsync: SecureStore.getItemAsync,
    setItemAsync: SecureStore.setItemAsync,
    deleteItemAsync: SecureStore.deleteItemAsync,
  },
  localAuth: {
    authenticateAsync: LocalAuthentication.authenticateAsync,
  },
  // getRandomValues is native SecRandomCopyBytes. Never Crypto.getRandomBytes (Math.random in __DEV__).
  getRandomValues: (array) => Crypto.getRandomValues(array),
  now: Date.now,
};
