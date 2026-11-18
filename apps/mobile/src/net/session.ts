// Sign-up, login and the demo claim (API-CONTRACT §1.3, §2.1), and the stored session.
//
//   challenge -> device_sig over authChallengeMessage(purpose, nonce, device, wallet|-)
//   signup:     + wallet_sig over walletBindMessage (no Face ID: wallet.signWalletBinding)
//   login:      any registered device key; a reinstall logs in (Keychain survives)
//   demo-claim: the response carries the custodial seed ONCE; it is imported into the wallet
//               (replaceExisting), so phones A / B become the demo parties (decision D-A), and
//               its key must derive the session user's pubkey.
//
// The session token lives in SecureStore (7 d). On SESSION_EXPIRED the API client calls
// refresh() = a silent login. Pure TS over injected deps: tested in node.
import {
  AuthChallengeResponse,
  Session,
  authChallengeMessage,
  walletBindMessage,
  type AuthPurpose,
} from '@youre-on/shared/api';
import { z } from 'zod/v4';

import type { SignupFields } from '../signup/form';
import { base58Encode, bytesEqual, utf8 } from '../wallet/bytes';
import { ed } from '../wallet/noble';
import type { SecureStoreLike } from '../wallet/platform';
import type { Wallet } from '../wallet/wallet';
import type { DeviceKey } from './deviceKey';
import { base64ToBytes, bytesToBase64 } from './encoding';
import { ApiClientError, type ApiClient, type Clock } from './signedFetch';

export const SESSION_KEY = 'youreon.session.v1';

/** §1.3 "Session + demo wallet seed". Mobile-side shape until the server handler lands. */
export const DemoClaimResponse = Session.extend({ wallet_seed_b64: z.string().min(1) });
export type DemoClaimResponse = z.infer<typeof DemoClaimResponse>;

export interface SessionStoreLike {
  load(): Promise<Session | null>;
  save(s: Session): Promise<void>;
  clear(): Promise<void>;
}

export function secureSessionStore(store: SecureStoreLike): SessionStoreLike {
  const opts = {
    keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  };
  return {
    async load() {
      const raw = await store.getItemAsync(SESSION_KEY, opts);
      if (!raw) return null;
      try {
        const r = Session.safeParse(JSON.parse(raw));
        return r.success ? r.data : null;
      } catch {
        return null;
      }
    },
    save: (s) => store.setItemAsync(SESSION_KEY, JSON.stringify(s), opts),
    clear: () => store.deleteItemAsync(SESSION_KEY, opts),
  };
}

export type SessionWallet = Pick<
  Wallet,
  'ensureWallet' | 'getPublicKey' | 'signWalletBinding' | 'importSeed'
>;

export interface SessionManagerDeps {
  api: ApiClient;
  deviceKey: DeviceKey;
  wallet: SessionWallet;
  store: SessionStoreLike;
  clock: Clock;
  appVersion: string;
}

export interface SessionManager {
  current(): Session | null;
  /** Stored session if still valid, else a silent login; null = this phone must sign up. */
  restore(): Promise<Session | null>;
  signup(fields: SignupFields): Promise<Session>;
  /** null when the device key isn't registered (sign up first). */
  login(): Promise<Session | null>;
  demoClaim(claimToken: string): Promise<Session>;
  signOut(): Promise<void>;
  onChange(listener: (s: Session | null) => void): () => void;
}

/** Demo seeds may arrive as a 32-byte seed or a 64-byte solana-keygen secret (seed ‖ pubkey). */
export function demoSeedFrom(b64: string): Uint8Array {
  const raw = base64ToBytes(b64);
  if (raw.length === 32) return raw;
  if (raw.length === 64) {
    const seed = raw.slice(0, 32);
    if (!bytesEqual(ed.getPublicKey(seed), raw.slice(32)))
      throw new Error('demo seed: keypair halves disagree');
    raw.fill(0);
    return seed;
  }
  raw.fill(0);
  throw new Error(`demo seed: expected 32 or 64 bytes, got ${raw.length}`);
}

export function createSessionManager(d: SessionManagerDeps): SessionManager {
  let session: Session | null = null;
  const listeners = new Set<(s: Session | null) => void>();
  const set = async (s: Session | null) => {
    session = s;
    if (s) {
      d.clock.sync(s.server_time);
      await d.store.save(s);
    } else await d.store.clear();
    for (const l of listeners) l(s);
  };

  const challenge = async () => {
    const ch = await d.api.request('POST', '/v1/auth/challenge', {
      auth: 'none',
      json: { device_pubkey: d.deviceKey.publicKey },
      schema: AuthChallengeResponse,
    });
    d.clock.sync(ch.server_time);
    return ch;
  };
  const deviceSig = (purpose: AuthPurpose, nonce: string, wallet: string | null) =>
    bytesToBase64(
      d.deviceKey.sign(
        utf8(
          authChallengeMessage({
            purpose,
            nonce,
            device_pubkey: d.deviceKey.publicKey,
            wallet_pubkey: wallet,
          }),
        ),
      ),
    );

  const login = async (): Promise<Session | null> => {
    const ch = await challenge();
    try {
      const s = await d.api.request('POST', '/v1/auth/session', {
        auth: 'none',
        json: {
          challenge_id: ch.challenge_id,
          device_pubkey: d.deviceKey.publicKey,
          device_sig: deviceSig('login', ch.nonce, null),
        },
        schema: Session,
      });
      await set(s);
      return s;
    } catch (e) {
      if (
        e instanceof ApiClientError &&
        e.code === 'SIGNATURE_INVALID' &&
        e.details?.reason === 'unknown_device'
      )
        return null;
      throw e;
    }
  };

  return {
    current: () => session,
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async restore() {
      const stored = await d.store.load();
      // 60 s of slack: a session that dies mid-request is refreshed by the API client anyway.
      if (stored && Date.parse(stored.expires_at) > d.clock.now() + 60_000) {
        session = stored;
        for (const l of listeners) l(stored);
        return stored;
      }
      return login();
    },
    login,
    async signup(fields) {
      const { publicKey: wallet } = await d.wallet.ensureWallet();
      const ch = await challenge();
      const walletSig = await d.wallet.signWalletBinding(
        walletBindMessage({
          wallet_pubkey: wallet,
          device_pubkey: d.deviceKey.publicKey,
          nonce: ch.nonce,
        }),
      );
      const s = await d.api.request('POST', '/v1/auth/signup', {
        auth: 'none',
        json: {
          challenge_id: ch.challenge_id,
          display_name: fields.display_name,
          age_attestation: fields.age_attestation,
          wallet_pubkey: wallet,
          device_pubkey: d.deviceKey.publicKey,
          device_sig: deviceSig('signup', ch.nonce, wallet),
          wallet_sig: bytesToBase64(walletSig),
          app_version: d.appVersion,
        },
        schema: Session,
      });
      await set(s);
      return s;
    },
    async demoClaim(claimToken) {
      const ch = await challenge();
      const r = await d.api.request('POST', '/v1/auth/demo-claim', {
        auth: 'none',
        // DemoClaimRequest has no challenge_id (the server may look the challenge up by device
        // key); sending it too is harmless (tolerant parse strips unknown keys) and unambiguous.
        json: {
          challenge_id: ch.challenge_id,
          claim_token: claimToken,
          device_pubkey: d.deviceKey.publicKey,
          device_sig: deviceSig('demo-claim', ch.nonce, null),
        },
        schema: DemoClaimResponse,
      });
      const seed = demoSeedFrom(r.wallet_seed_b64);
      const derived = base58Encode(ed.getPublicKey(seed));
      if (derived !== r.user.pubkey) {
        seed.fill(0);
        throw new ApiClientError(
          'DEMO_SEED_MISMATCH',
          0,
          'demo seed does not match the account',
          false,
        );
      }
      // importSeed wipes `seed`.
      await d.wallet.importSeed(seed, { replaceExisting: true });
      const { wallet_seed_b64: _drop, ...s } = r;
      void _drop;
      await set(s);
      return s;
    },
    async signOut() {
      const s = session;
      if (s) {
        await d.api
          .request('DELETE', '/v1/auth/session', { auth: 'bearer' })
          .catch(() => undefined);
      }
      await set(null);
    },
  };
}
