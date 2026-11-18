// The real app's services, wired once: wallet (Keychain), device key, server-corrected clock,
// signed API client, session manager, bet hub and the realtime socket. App code only (expo
// natives); every piece it wires is pure and tested on its own.
import type { Session } from '@youre-on/shared/api';

import { expoWalletPlatform } from '../wallet/expoPlatform';
import { createWallet, type Wallet } from '../wallet/wallet';
import { createYoApi, type YoApi } from '../net/api';
import { API_BASE_URL, APP_VERSION } from '../net/config';
import { loadDeviceKey, type DeviceKey } from '../net/deviceKey';
import { uuidV4 } from '../net/encoding';
import { createSessionManager, secureSessionStore, type SessionManager } from '../net/session';
import {
  createApiClient,
  createClock,
  type ApiClient,
  type Clock,
  type FetchLike,
} from '../net/signedFetch';
import {
  createRealtimeClient,
  wsUrlFor,
  type RealtimeClient,
  type SocketLike,
  type WsStatus,
} from '../net/ws';
import type { WsServerControlFrame } from '@youre-on/shared/api';
import { BetHub } from './betHub';
import { resetOnUserSwitch } from './userSwitch';

export interface Runtime {
  baseUrl: string;
  wallet: Wallet;
  deviceKey: DeviceKey;
  clock: Clock;
  client: ApiClient;
  api: YoApi;
  sessions: SessionManager;
  hub: BetHub;
  ws: RealtimeClient;
  /** Control frames (presence) and socket status, for the React layer. */
  onControl(l: (f: WsServerControlFrame) => void): () => void;
  onStatus(l: (s: WsStatus) => void): () => void;
  /** The server refused a sub (close 4403); the client already dropped it. */
  onForbidden(l: (d: { room: string | null; bets: string[] }) => void): () => void;
  uuid(): string;
}

const rnFetch: FetchLike = async (url, init) => {
  // JSON goes as its string (the signed bytes); multipart goes as an ArrayBuffer of the exact
  // signed bytes (RN's fetch -> XHR sends ArrayBuffer bodies byte-for-byte).
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength);
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(body !== undefined ? { body: body as BodyInit } : {}),
  });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

let shared: Promise<Runtime> | null = null;

export function getRuntime(): Promise<Runtime> {
  shared ??= build().catch((e: unknown) => {
    shared = null;
    throw e;
  });
  return shared;
}

async function build(): Promise<Runtime> {
  const platform = expoWalletPlatform;
  const wallet = createWallet(platform);
  const deviceKey = await loadDeviceKey(platform);
  const clock = createClock();
  const uuid = () => uuidV4((a) => platform.getRandomValues(a));
  let sessions: SessionManager | null = null;
  const client = createApiClient({
    baseUrl: API_BASE_URL,
    fetch: rnFetch,
    deviceKey: () => deviceKey,
    clock,
    uuid,
    appVersion: APP_VERSION,
    session: () => sessions?.current() ?? null,
    refreshSession: async () => (sessions ? await sessions.login().catch(() => null) : null),
  });
  sessions = createSessionManager({
    api: client,
    deviceKey,
    wallet,
    store: secureSessionStore(platform.secureStore),
    clock,
    appVersion: APP_VERSION,
  });
  const mgr = sessions;
  const api = createYoApi(client);
  const hub = new BetHub(
    api,
    () => clock.now(),
    (m, x) => console.warn(`[yo] ${m}`, x ?? ''),
  );
  const controlListeners = new Set<(f: WsServerControlFrame) => void>();
  const statusListeners = new Set<(s: WsStatus) => void>();
  const forbiddenListeners = new Set<(d: { room: string | null; bets: string[] }) => void>();
  const ws = createRealtimeClient({
    url: wsUrlFor(API_BASE_URL),
    createSocket: (u) => new WebSocket(u) as unknown as SocketLike,
    hello: () => {
      const s: Session | null = mgr.current();
      return s ? { token: s.token, device_id: s.device_id, app_version: APP_VERSION } : null;
    },
    lastSeq: (id) => hub.lastSeq(id),
    onEvent: (e) => hub.push(e),
    onControl: (f) => {
      if (f.op === 'welcome') {
        clock.sync(f.server_time);
        // The server replays from after_seq; a REST pass catches anything a replay missed.
        void hub.resyncAll();
      }
      for (const l of controlListeners) l(f);
    },
    onStatus: (s) => {
      for (const l of statusListeners) l(s);
    },
    // login() resolving null (device unknown: DB reseeded) also signs out, back to signup.
    onUnauthorized: async () => (await mgr.login().catch(() => null)) !== null,
    onForbidden: (d) => {
      for (const l of forbiddenListeners) l(d);
    },
    log: (m, x) => console.warn(`[yo] ${m}`, x ?? ''),
  });
  // A user switch (demo claim from Profile) or sign-out: the old user's subs and bets go, so the
  // next hello carries none the new user may not see (else 4403 on every reconnect).
  resetOnUserSwitch(mgr, { ws, hub });
  return {
    baseUrl: API_BASE_URL,
    wallet,
    deviceKey,
    clock,
    client,
    api,
    sessions: mgr,
    hub,
    ws,
    uuid,
    onControl(l) {
      controlListeners.add(l);
      return () => controlListeners.delete(l);
    },
    onStatus(l) {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    onForbidden(l) {
      forbiddenListeners.add(l);
      return () => forbiddenListeners.delete(l);
    },
  };
}
