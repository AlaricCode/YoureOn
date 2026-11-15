// Wallet key custody and authorization (TASKS D0-M3, FINDINGS §3.4, ARCHITECTURE §2.4 "Wallet seed").
//
// - The seed is 32 CSPRNG bytes from getRandomValues (never getRandomBytes, never noble keygen()).
// - It lives in the Keychain via SecureStore with WHEN_UNLOCKED_THIS_DEVICE_ONLY and WITHOUT
//   requireAuthentication (that flag is .biometryCurrentSet: Face ID re-enrol = wallet loss, no passcode
//   fallback, a prompt on every read, and a double prompt next to authenticateAsync; FINDINGS §7).
// - The public key is a separate item, so app start never reads the seed and never prompts.
// - authorize(messageBytes, prompt): LocalAuthentication -> read seed -> sign with noble -> wipe seed.
//
// The seed's hex string from SecureStore cannot be wiped (JS strings are immutable); the decoded
// Uint8Array is zeroed in a finally block, and the string reference is dropped immediately.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  runAuthorizationGate,
  type AuthorizationMethod,
  type AuthPrompt,
  type AuthStage,
} from './authMethod';
import { base58Encode, wipe } from './bytes';
import { ed, sha256 } from './noble';
import type {
  LocalAuthenticationError,
  SecureStoreLike,
  SecureStoreOptions,
  WalletPlatform,
} from './platform';

/** Keychain item names (SecureStore keys allow only [A-Za-z0-9._-]). */
export const SEED_KEY = 'youreon.wallet.seed.v1';
export const PUBKEY_KEY = 'youreon.wallet.pubkey.v1';

export const SEED_BYTES = 32;
/** A Solana transaction is at most 1,232 bytes, so its message is smaller still. */
export const MAX_MESSAGE_BYTES = 1232;

export type WalletErrorCode =
  | 'NO_WALLET' // no seed / pubkey in the Keychain
  | 'WALLET_EXISTS' // importSeed without replaceExisting over an existing seed
  | 'BAD_RANDOM' // the CSPRNG returned an all-zero or wrong-length buffer
  | 'CORRUPT_SEED' // the stored item is not 64 hex chars
  | 'KEY_MISMATCH' // the stored seed does not derive the stored public key (interrupted replace)
  | 'BAD_MESSAGE' // empty or longer than MAX_MESSAGE_BYTES
  | 'POLICY_REJECTED' // the caller's device signing policy rejected the message (ESCROW §5.0.2)
  | 'AUTH_CANCELLED' // the user cancelled the prompt (user_cancel / system_cancel / app_cancel)
  | 'AUTH_FAILED' // any other LocalAuthentication failure
  | 'BUSY'; // an authorization is already in progress

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly authError?: LocalAuthenticationError | 'exception';
  readonly authStage?: AuthStage;

  constructor(
    code: WalletErrorCode,
    message: string,
    extra: {
      authError?: LocalAuthenticationError | 'exception';
      authStage?: AuthStage;
      cause?: unknown;
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'WalletError';
    this.code = code;
    if (extra.authError !== undefined) this.authError = extra.authError;
    if (extra.authStage !== undefined) this.authStage = extra.authStage;
  }
}

/**
 * The device signing policy hook (packages/shared, ESCROW §5.0.2). It runs on the exact bytes that
 * will be signed, BEFORE any prompt, so a bad message never shows Face ID. Return false or throw to reject.
 */
export type SigningPolicy = (messageBytes: Uint8Array) => boolean | void;

export type AuthorizeOptions = {
  policy?: SigningPolicy;
};

export type AuthorizeResult = {
  /** 64-byte Ed25519 signature over messageBytes. */
  signature: Uint8Array;
  /** base58, the encoding of `PartyAuthorization.party_signature` (SCHEMAS §9). */
  signatureBase58: string;
  /** base58 wallet address that signed. */
  publicKey: string;
  method: AuthorizationMethod;
  /** Device clock at LocalAuthentication success, ISO-8601 UTC (`PartyAuthorization.authorized_at`). */
  authorizedAt: string;
  /** Same instant in ms; `ms_since_auth_success` = send time - this. */
  authSucceededAtMs: number;
  /** Lowercase hex sha256 of the signed bytes (`PartyAuthorization.message_sha256`). */
  messageSha256: string;
  /** 1 = Face ID only, 2 = the passcode fallback prompt also ran. */
  prompts: 1 | 2;
};

export type Wallet = {
  /** The stored public key (base58), or null if no wallet exists. Never reads the seed, never prompts. */
  getPublicKey(): Promise<string | null>;
  /** Returns the existing wallet, or creates one. Never overwrites an existing seed. */
  ensureWallet(): Promise<{ publicKey: string; created: boolean }>;
  /** Stores a provisioned seed (custodial demo accounts, FINDINGS §3.4). The input buffer is wiped. */
  importSeed(
    seed: Uint8Array,
    options: { replaceExisting: boolean },
  ): Promise<{ publicKey: string }>;
  /** LocalAuthentication -> read seed -> sign -> wipe seed. */
  authorize(
    messageBytes: Uint8Array,
    prompt: string | AuthPrompt,
    options?: AuthorizeOptions,
  ): Promise<AuthorizeResult>;
  /** Deletes both items. For a debug screen / tests only; there is no backup. */
  destroy(): Promise<void>;
};

const CANCEL_ERRORS: readonly string[] = ['user_cancel', 'system_cancel', 'app_cancel'];

/**
 * Per-Keychain state shared by every Wallet created over the same SecureStore. Writes (create,
 * import, destroy) run one at a time, so two concurrent ensureWallet() calls (React StrictMode
 * double effects, app start + diagnostics) can never both mint a seed and have the second overwrite
 * the first: that would hand the first caller a public key whose seed no longer exists.
 */
type StoreState = { chain: Promise<unknown>; busy: boolean };
const storeStates = new WeakMap<SecureStoreLike, StoreState>();

function stateFor(store: SecureStoreLike): StoreState {
  let state = storeStates.get(store);
  if (!state) {
    state = { chain: Promise.resolve(), busy: false };
    storeStates.set(store, state);
  }
  return state;
}

function serialize<T>(state: StoreState, task: () => Promise<T>): Promise<T> {
  const run = state.chain.then(task, task);
  state.chain = run.catch(() => undefined);
  return run;
}

export function createWallet(platform: WalletPlatform): Wallet {
  const now = platform.now ?? Date.now;
  const store = platform.secureStore;
  // Exactly these options on every read and write: no requireAuthentication, this device only.
  const itemOptions: SecureStoreOptions = {
    keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
  const state = stateFor(store);

  const readSeed = async (): Promise<Uint8Array | null> => {
    let hex = await store.getItemAsync(SEED_KEY, itemOptions);
    if (hex === null) return null;
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      hex = null;
      throw new WalletError('CORRUPT_SEED', 'stored seed is not 32 bytes of hex');
    }
    const seed = hexToBytes(hex);
    hex = null;
    return seed;
  };

  const writeSeedAndPubkey = async (seed: Uint8Array): Promise<string> => {
    const publicKey = base58Encode(ed.getPublicKey(seed));
    // Drop any old pubkey item first, then write the seed, then the pubkey. If the app dies between
    // the writes there is a seed with no pubkey item, and ensureWallet recovers the pubkey from the
    // seed. A stale pubkey next to a replaced seed can never be left behind.
    await store.deleteItemAsync(PUBKEY_KEY, itemOptions);
    await store.setItemAsync(SEED_KEY, bytesToHex(seed), itemOptions);
    await store.setItemAsync(PUBKEY_KEY, publicKey, itemOptions);
    return publicKey;
  };

  const generateSeed = (): Uint8Array => {
    const seed = new Uint8Array(SEED_BYTES);
    platform.getRandomValues(seed);
    if (seed.length !== SEED_BYTES || seed.every((b) => b === 0)) {
      throw new WalletError('BAD_RANDOM', 'random source returned no entropy');
    }
    return seed;
  };

  const getPublicKey = () => store.getItemAsync(PUBKEY_KEY, itemOptions);

  return {
    getPublicKey,

    ensureWallet: () =>
      serialize(state, async () => {
        const existing = await getPublicKey();
        if (existing !== null) return { publicKey: existing, created: false };
        // No pubkey item. A seed without a pubkey means an interrupted create: recover, never overwrite.
        const stored = await readSeed();
        if (stored !== null) {
          try {
            const publicKey = base58Encode(ed.getPublicKey(stored));
            await store.setItemAsync(PUBKEY_KEY, publicKey, itemOptions);
            return { publicKey, created: false };
          } finally {
            wipe(stored);
          }
        }
        const seed = generateSeed();
        try {
          return { publicKey: await writeSeedAndPubkey(seed), created: true };
        } finally {
          wipe(seed);
        }
      }),

    importSeed: (seed, { replaceExisting }) =>
      serialize(state, async () => {
        try {
          if (seed.length !== SEED_BYTES)
            throw new WalletError('CORRUPT_SEED', 'seed must be 32 bytes');
          if (!replaceExisting) {
            const existing = await store.getItemAsync(SEED_KEY, itemOptions);
            if (existing !== null)
              throw new WalletError('WALLET_EXISTS', 'a wallet seed already exists on this device');
          }
          return { publicKey: await writeSeedAndPubkey(seed) };
        } finally {
          wipe(seed);
        }
      }),

    async authorize(messageBytes, prompt, options = {}) {
      if (state.busy) throw new WalletError('BUSY', 'an authorization is already in progress');
      state.busy = true;
      try {
        // Own copy: what the policy checks is exactly what gets signed, even if the caller's buffer changes.
        const message = Uint8Array.from(messageBytes);
        if (message.length === 0 || message.length > MAX_MESSAGE_BYTES) {
          throw new WalletError('BAD_MESSAGE', `message must be 1..${MAX_MESSAGE_BYTES} bytes`);
        }
        if (options.policy) {
          let verdict: unknown;
          try {
            verdict = options.policy(message);
          } catch (cause) {
            throw new WalletError(
              'POLICY_REJECTED',
              cause instanceof Error ? cause.message : 'device policy rejected the message',
              { cause },
            );
          }
          // Only an explicit `true` or a plain return passes. Anything else (false, a Promise from an
          // async policy, a stray value) rejects: an un-awaited async check must never pass.
          if (verdict !== true && verdict !== undefined)
            throw new WalletError('POLICY_REJECTED', 'device policy rejected the message');
        }
        const publicKey = await getPublicKey();
        if (publicKey === null) throw new WalletError('NO_WALLET', 'no wallet on this device');

        // 1. LocalAuthentication (one prompt, or two on the passcode fallback).
        const gate = await runAuthorizationGate(platform.localAuth, prompt);
        if (!gate.ok) {
          const code = CANCEL_ERRORS.includes(gate.error) ? 'AUTH_CANCELLED' : 'AUTH_FAILED';
          throw new WalletError(code, `authentication failed: ${gate.error}`, {
            authError: gate.error,
            authStage: gate.stage,
          });
        }
        const authSucceededAtMs = now();

        // 2. Read the seed. 3. Sign with noble. 4. Wipe the seed.
        const seed = await readSeed();
        if (seed === null) throw new WalletError('NO_WALLET', 'wallet seed missing');
        let signature: Uint8Array;
        try {
          // The key that signs must be the key the app showed and registered. A mismatch means the
          // Keychain items disagree; signing anyway would produce a signature the server rejects.
          if (base58Encode(ed.getPublicKey(seed)) !== publicKey) {
            throw new WalletError(
              'KEY_MISMATCH',
              'stored seed does not match the stored public key',
            );
          }
          signature = ed.sign(message, seed);
        } finally {
          wipe(seed);
        }

        return {
          signature,
          signatureBase58: base58Encode(signature),
          publicKey,
          method: gate.method,
          authorizedAt: new Date(authSucceededAtMs).toISOString(),
          authSucceededAtMs,
          messageSha256: bytesToHex(sha256(message)),
          prompts: gate.prompts,
        };
      } finally {
        state.busy = false;
      }
    },

    destroy: () =>
      serialize(state, async () => {
        // Pubkey first: a crash in between leaves a seed with no pubkey (recoverable), never a
        // pubkey with no seed (an address that can never sign).
        await store.deleteItemAsync(PUBKEY_KEY, itemOptions);
        await store.deleteItemAsync(SEED_KEY, itemOptions);
      }),
  };
}
