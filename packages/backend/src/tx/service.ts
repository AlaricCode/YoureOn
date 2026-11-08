/**
 * §12.1 signing model: any action needing a user signature returns
 *   { sign: { tx_id, message_b64, expires_at_ms, summary } }
 * The app signs the message bytes with its wallet key and calls
 *   POST /tx/{tx_id}/submit { signature_b64 }
 *   → { status: "confirmed" | "failed", signature | null, error | null }
 * The backend verifies the user's ed25519 signature over the exact message,
 * adds fee-payer / oracle signatures, and sends. Request-level problems are
 * HTTP errors (NOT_FOUND, TX_EXPIRED ⇒ the app re-requests once, TX_FAILED
 * for a bad signature); on-chain failures are `status: "failed"`.
 *
 * Service agents register confirm hooks per `kind` to update their mirrors.
 */
import { verifyEd25519 } from '../crypto/keys.js';
import { ApiError, ERROR_MESSAGES, type ErrorCode } from '../errors.js';
import type { ChainClient, ChainIx, SendResult } from '../chain/types.js';
import { COLLECTIONS, type TxRecord, type UserRecord } from '../persistence/records.js';
import type { Collection, JsonStore } from '../persistence/store.js';
import { fromBase64, toBase64 } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';
import { uuid } from '../util/ids.js';

export interface SignPayload {
  tx_id: string;
  message_b64: string;
  expires_at_ms: number;
  summary: string;
}

export interface SubmitResponse {
  status: 'confirmed' | 'failed';
  signature: string | null;
  error: { code: ErrorCode; message: string } | null;
}

export type ConfirmHook = (tx: TxRecord, result: Extract<SendResult, { status: 'confirmed' }>) => void | Promise<void>;

export interface TxServiceOptions {
  store: JsonStore;
  chain: ChainClient;
  clock: Clock;
  log?: { error: (o: unknown, msg?: string) => void };
}

export class TxService {
  readonly txs: Collection<TxRecord>;
  private readonly hooks = new Map<string, ConfirmHook[]>();
  private readonly inflight = new Map<string, Promise<SubmitResponse>>();

  constructor(private readonly opts: TxServiceOptions) {
    this.txs = opts.store.collection<TxRecord>(COLLECTIONS.txs);
  }

  /** Registers a hook run after a tx of `kind` confirms (e.g. "fund" → refresh the bet mirror). */
  onConfirmed(kind: string, hook: ConfirmHook): () => void {
    const list = this.hooks.get(kind) ?? [];
    list.push(hook);
    this.hooks.set(kind, list);
    return () => {
      const i = list.indexOf(hook);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /**
   * Prepares a transaction the user must sign. The user's wallet must be a
   * required signer; every other required signer must be backend-held.
   */
  async request(args: {
    user: Pick<UserRecord, 'id' | 'wallet'>;
    kind: string;
    ixs: ChainIx[];
    summary: string;
    meta?: Record<string, unknown>;
  }): Promise<{ sign: SignPayload }> {
    const prepared = await this.opts.chain.prepare(args.ixs);
    if (!prepared.signers.includes(args.user.wallet)) {
      throw new Error(`tx ${args.kind}: the user's wallet is not a required signer`);
    }
    const now = this.opts.clock.nowMs();
    const rec: TxRecord = {
      tx_id: uuid(),
      user_id: args.user.id,
      signer: args.user.wallet,
      kind: args.kind,
      message_b64: toBase64(prepared.message),
      expires_at_ms: prepared.expiresAtMs,
      summary: args.summary,
      status: 'pending',
      signature: null,
      error: null,
      meta: args.meta ?? {},
      created_at_ms: now,
      updated_at_ms: now,
    };
    this.txs.set(rec.tx_id, rec);
    return {
      sign: { tx_id: rec.tx_id, message_b64: rec.message_b64, expires_at_ms: rec.expires_at_ms, summary: rec.summary },
    };
  }

  /**
   * Concurrent submits of the same tx (app retry, double tap) share one send:
   * the request checks run per caller (a bad signature cannot join or poison
   * another caller's send), then one chain.submit + one hook run per tx.
   */
  async submit(txId: string, userId: string, body: unknown): Promise<SubmitResponse> {
    const rec = this.txs.get(txId);
    if (!rec || rec.user_id !== userId) throw new ApiError('NOT_FOUND', `tx ${txId}`);
    if (rec.status !== 'pending') return responseOf(rec);
    if (this.opts.clock.nowMs() > rec.expires_at_ms) throw new ApiError('TX_EXPIRED');

    const sigB64 = (body as { signature_b64?: unknown } | null)?.signature_b64;
    let sig: Uint8Array;
    try {
      sig = fromBase64(typeof sigB64 === 'string' ? sigB64 : '');
    } catch {
      throw new ApiError('TX_FAILED', 'signature_b64 is not base64');
    }
    const message = fromBase64(rec.message_b64);
    if (!verifyEd25519(sig, message, rec.signer)) throw new ApiError('TX_FAILED', 'bad user signature');

    const running = this.inflight.get(txId);
    if (running) return running;
    const p = this.send(rec, message, sig).finally(() => this.inflight.delete(txId));
    this.inflight.set(txId, p);
    return p;
  }

  private async send(rec: TxRecord, message: Uint8Array, sig: Uint8Array): Promise<SubmitResponse> {
    const txId = rec.tx_id;
    const result = await this.opts.chain.submit(message, [{ pubkey: rec.signer, signature: sig }]);
    // Never overwrite a settled record (e.g. another backend instance confirmed it meanwhile).
    const now = this.txs.get(txId);
    if (now && now.status === 'confirmed') return responseOf(now);
    if (result.status === 'failed' && result.code === 'TX_EXPIRED') throw new ApiError('TX_EXPIRED', result.error);

    const updated: TxRecord = {
      ...rec,
      status: result.status,
      signature: result.signature,
      error:
        result.status === 'failed'
          ? { code: result.code, message: ERROR_MESSAGES[result.code], detail: result.error }
          : null,
      updated_at_ms: this.opts.clock.nowMs(),
    };
    this.txs.set(txId, updated);
    if (result.status === 'confirmed') {
      // Hooks run once, on the single pending → confirmed transition.
      for (const h of this.hooks.get(rec.kind) ?? []) {
        try {
          await h(updated, result);
        } catch (e) {
          this.opts.log?.error({ err: e, tx_id: txId, kind: rec.kind }, 'tx confirm hook failed');
        }
      }
    }
    return responseOf(updated);
  }
}

function responseOf(rec: TxRecord): SubmitResponse {
  return {
    status: rec.status === 'confirmed' ? 'confirmed' : 'failed',
    signature: rec.signature,
    error: rec.error ? { code: rec.error.code as ErrorCode, message: rec.error.message } : null,
  };
}
