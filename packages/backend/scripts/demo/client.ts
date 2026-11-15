/**
 * A simulated Verdict app for the e2e demo: an embedded ed25519 wallet, the
 * §12.1 login and signing model, JSON calls against `{API}/v1` over real
 * HTTP (fetch) and a WebSocket subscription (§12.4). Nothing here reaches
 * into the backend's internals.
 */
import WebSocket from 'ws';
import { loginMessage } from '../../src/auth/service.js';
import { keypairFromSeed, type KeyPair } from '../../src/crypto/keys.js';
import { fromBase64, toBase64 } from '../../src/util/bytes.js';

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: string,
    what: string,
  ) {
    super(`${what} → ${status} ${code} ${body.slice(0, 300)}`);
  }
}

export interface SignPayload {
  tx_id: string;
  message_b64: string;
  expires_at_ms: number;
  summary: string;
}

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

type Json = Record<string, unknown>;

/** Deterministic wallet per demo user (seed = sha-free label bytes, padded). */
export function demoWallet(label: string): KeyPair {
  const seed = new Uint8Array(32);
  const b = new TextEncoder().encode(`verdict-demo:${label}`);
  for (let i = 0; i < b.length; i++) seed[i % 32] = (seed[i % 32]! * 31 + b[i]!) & 0xff;
  return keypairFromSeed(seed);
}

export class AppClient {
  token: string | null = null;
  userId = '';
  readonly wallet: KeyPair;
  private ws: WebSocket | null = null;
  readonly inbox: WsMessage[] = [];
  private waiters: { pred: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void }[] = [];

  constructor(
    readonly baseUrl: string,
    readonly name: string,
    readonly email: string,
  ) {
    this.wallet = demoWallet(email);
  }

  // ---- HTTP -------------------------------------------------------------------------

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { ...headers };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    let payload: string | Buffer | undefined;
    if (body instanceof Uint8Array) {
      payload = Buffer.from(body);
      h['content-type'] ??= 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    return fetch(`${this.baseUrl}/v1${path}`, { method, headers: h, ...(payload !== undefined ? { body: payload } : {}) });
  }

  async call<T = Json>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const r = await this.raw(method, path, body, headers);
    const text = await r.text();
    if (!r.ok) {
      let code = 'HTTP';
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? code;
      } catch {
        /* not JSON */
      }
      throw new ApiCallError(r.status, code, text, `${this.name}: ${method} ${path}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  get<T = Json>(path: string, headers?: Record<string, string>) {
    return this.call<T>('GET', path, undefined, headers);
  }

  post<T = Json>(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.call<T>('POST', path, body, headers);
  }

  put<T = Json>(path: string, body: unknown, headers?: Record<string, string>) {
    return this.call<T>('PUT', path, body, headers);
  }

  async bytes(path: string): Promise<{ type: string; bytes: Uint8Array }> {
    const r = await this.raw('GET', path);
    if (!r.ok) throw new ApiCallError(r.status, 'HTTP', await r.text(), `${this.name}: GET ${path}`);
    return { type: r.headers.get('content-type') ?? '', bytes: new Uint8Array(await r.arrayBuffer()) };
  }

  /** Expects an error code (returns it), failing if the call succeeds. */
  async expectError(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<string> {
    try {
      await this.call(method, path, body, headers);
    } catch (e) {
      if (e instanceof ApiCallError) return e.code;
      throw e;
    }
    throw new Error(`${this.name}: ${method} ${path} unexpectedly succeeded`);
  }

  // ---- §12.1 login + signing ----------------------------------------------------------

  async login(): Promise<Json> {
    const { nonce } = await this.get<{ nonce: string }>('/auth/nonce');
    const r = await this.post<{ token: string; user: Json }>('/auth/session', {
      provider: 'google',
      credential: `mock:${this.email}`,
      wallet: this.wallet.publicKey,
      nonce,
      wallet_sig_b64: toBase64(this.wallet.sign(loginMessage(nonce))),
    });
    this.token = r.token;
    this.userId = r.user['id'] as string;
    return r.user;
  }

  /** Signs the message bytes with the wallet (passkey-unlocked in the app) and submits; re-requests once on TX_EXPIRED. */
  async signAndSubmit(sign: SignPayload, rerequest?: () => Promise<SignPayload>): Promise<{ status: string; signature: string | null; error: unknown }> {
    const submit = (s: SignPayload) =>
      this.post<{ status: string; signature: string | null; error: unknown }>(`/tx/${s.tx_id}/submit`, {
        signature_b64: toBase64(this.wallet.sign(fromBase64(s.message_b64))),
      });
    try {
      return await submit(sign);
    } catch (e) {
      if (e instanceof ApiCallError && e.code === 'TX_EXPIRED' && rerequest) return submit(await rerequest());
      throw e;
    }
  }

  async signConfirmed(sign: SignPayload, what: string): Promise<string> {
    const r = await this.signAndSubmit(sign);
    if (r.status !== 'confirmed') throw new Error(`${this.name}: ${what} failed: ${JSON.stringify(r.error)}`);
    return r.signature ?? '';
  }

  // ---- WebSocket ------------------------------------------------------------------------

  /** Opens the socket once (idempotent) and subscribes to `topics`. */
  async connectWs(topics: string[]): Promise<void> {
    if (this.ws) {
      this.subscribe(topics);
      return;
    }
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(this.token ?? '')}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (data) => {
      let m: WsMessage;
      try {
        m = JSON.parse(String(data)) as WsMessage;
      } catch {
        return;
      }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    this.subscribe(topics);
  }

  wsSend(msg: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(msg));
  }

  subscribe(topics: string[]): void {
    this.ws?.send(JSON.stringify({ type: 'subscribe', topics }));
  }

  /** Next WS message matching `pred` (already received or future). */
  nextWs(pred: (m: WsMessage) => boolean, timeoutMs = 10_000): Promise<WsMessage> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${this.name}: timed out waiting for a WS message`));
      }, timeoutMs);
      t.unref?.();
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/** Sends a client → server WS message (scene.frame, recording, ping). */
export function sendWs(c: AppClient, msg: Record<string, unknown>): void {
  c.wsSend(msg);
}
