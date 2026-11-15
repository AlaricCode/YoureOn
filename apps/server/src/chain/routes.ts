// QuickNode Streams receiver (API-CONTRACT §5, DATA-MODEL §8.2):
//   POST /webhooks/quicknode   X-QN-Signature HMAC, no bearer auth
//
// Ported from Verdict packages/backend/src/routes/webhooks.ts:35-80 (cheap header checks before
// the HMAC, JSON parsed only after the HMAC over the raw bytes verified, idempotent handler).
// Ack rules are OURS (API-CONTRACT §5.3), not Verdict's 204/400:
//   - bad / missing / stale signature → 401 (and an alert: 3 failed retries auto-pause the Stream);
//   - transient DB error (an allowlist: connection loss, serialization/deadlock, resources,
//     admin shutdown, lock timeout) → 503 so QuickNode retries (3 × 1 s);
//   - anything else is deterministic, so a retry replays the same failure and 3 of them pause the
//     Stream (stopping every money event). Malformed envelope, wrong program, bad events → 200
//     with the problem logged. A projector / trigger / integrity failure → 200 with an alert, and
//     the delivery is stored WITHOUT the projector (apply_error 'projector_failed') so the batch
//     is not lost (DATA-MODEL §8.2 step 4);
//   - success → 200 fast (one DB transaction, no RPC calls).
import type { Context } from 'hono';
import type { AppEnv, RouteModule } from '../context';
import { errorBody, HttpError } from '../errors';
import { ingestChainEvents, storeUnprojected } from './ingest';
import { createStubProjector, type ChainProjector, type LockSignatureLookup } from './projector';
import {
  QN_HEADER_BATCH_END,
  QN_HEADER_BATCH_START,
  QN_HEADER_DATASET,
  QN_HEADER_NONCE,
  QN_HEADER_SIGNATURE,
  QN_HEADER_TIMESTAMP,
  verifyQuickNodeSignature,
} from './quicknode';
import { parseStreamDelivery, StreamPayloadError } from './streams';

export const QUICKNODE_WEBHOOK_PATH = '/webhooks/quicknode';
/** A 5-block filtered batch is small, but an unfiltered probe can exceed 1 MiB. */
export const QUICKNODE_BODY_LIMIT = 8 * 1024 * 1024;

export interface ChainRoutesOptions {
  /** Defaults to the stub projector (projector.ts). */
  projector?: ChainProjector;
  /** Passed to the default stub projector. */
  lockSignatures?: LockSignatureLookup;
}

/** Every `code` on an error and its `cause` chain (Drizzle wraps postgres.js errors). */
function errorCodes(e: unknown): string[] {
  const out: string[] = [];
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 4; i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string') out.push(code);
    x = (x as { cause?: unknown }).cause;
  }
  return out;
}

/** postgres.js / Node socket codes for a lost or unreachable database. */
const TRANSIENT_CONNECTION_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * True only for errors a retry can fix: SQLSTATE class 08 (connection), 40 (serialization /
 * deadlock), 53 (insufficient resources), 57P01–57P03 (admin / crash shutdown, cannot connect
 * now), 55P03 (lock not available), and postgres.js connection errors. Everything else (a JS
 * exception, P0001 from a trigger RAISE, class 22/23) is deterministic.
 */
export function isTransientDbError(e: unknown): boolean {
  return errorCodes(e).some(
    (c) =>
      TRANSIENT_CONNECTION_CODES.has(c) ||
      /^(08|40|53)[0-9A-Z]{3}$/.test(c) ||
      /^57P0[1-3]$/.test(c) ||
      c === '55P03',
  );
}

function deliveryIdOf(
  c: Context<AppEnv>,
  batch: { batchStart: number | null; batchEnd: number | null },
) {
  const start = c.req.header(QN_HEADER_BATCH_START) ?? batch.batchStart ?? '';
  const end = c.req.header(QN_HEADER_BATCH_END) ?? batch.batchEnd ?? '';
  const ds = c.req.header(QN_HEADER_DATASET) ?? '';
  const id = `${start}-${end}${ds ? `:${ds}` : ''}`;
  return id === '-' ? null : id.slice(0, 128);
}

export function createChainRoutes(o: ChainRoutesOptions = {}): RouteModule {
  const projector = o.projector ?? createStubProjector({ lockSignatures: o.lockSignatures });
  return {
    name: 'chain',
    bodyLimits: [{ path: /^\/webhooks\/quicknode$/, maxBytes: QUICKNODE_BODY_LIMIT }],
    register(app) {
      app.post(QUICKNODE_WEBHOOK_PATH, async (c) => {
        const d = c.get('deps');
        const secret = d.env.QN_STREAM_SECURITY_TOKEN;
        if (!secret) {
          d.log.error('chain.webhook_unconfigured', { hint: 'set QN_STREAM_SECURITY_TOKEN' });
          throw new HttpError('NOT_FOUND');
        }
        // Cheap rejection before buffering the body: headers present.
        const nonce = c.req.header(QN_HEADER_NONCE);
        const timestamp = c.req.header(QN_HEADER_TIMESTAMP);
        const signature = c.req.header(QN_HEADER_SIGNATURE);
        const raw =
          nonce && timestamp && signature ? new Uint8Array(await c.req.arrayBuffer()) : null;
        const v = raw
          ? await verifyQuickNodeSignature({
              secret,
              nonce,
              timestamp,
              signature,
              rawBody: raw,
              nowMs: d.now(),
            })
          : ({ ok: false, reason: 'missing' } as const);
        if (!v.ok) {
          // ALERT: QuickNode auto-pauses the Stream after 3 failed retries.
          d.log.error('chain.webhook_rejected', { alert: true, reason: v.reason });
          throw new HttpError('SIGNATURE_INVALID', 'QuickNode signature rejected.', {
            reason: v.reason,
          });
        }

        // JSON is parsed only after the HMAC over the exact bytes verified.
        let body: unknown;
        try {
          const text = Buffer.from(v.body).toString('utf8');
          body = text.trim() === '' ? null : (JSON.parse(text) as unknown);
        } catch {
          d.log.error('chain.webhook_bad_json', { alert: true, bytes: v.body.length });
          return c.json({ ok: false, reason: 'invalid_json' }, 200);
        }
        let batch;
        try {
          batch = parseStreamDelivery(body);
        } catch (e) {
          if (!(e instanceof StreamPayloadError)) throw e;
          d.log.error('chain.webhook_bad_payload', { alert: true, msg: e.message });
          return c.json({ ok: false, reason: 'invalid_payload' }, 200);
        }
        if (batch.rejected.length)
          d.log.warn('chain.events_rejected', { rejected: batch.rejected.slice(0, 20) });
        if (batch.hintMismatches)
          d.log.warn('chain.name_hint_mismatch', { count: batch.hintMismatches });

        const deliveryId = deliveryIdOf(c, batch);
        try {
          const r = await ingestChainEvents(d, projector, batch.events, { deliveryId });
          d.log.info('chain.delivery', {
            delivery_id: deliveryId,
            ...r,
            in_batch_duplicates: batch.duplicates,
            rejected: batch.rejected.length,
          });
          return c.json(
            {
              ok: true,
              ...r,
              duplicates: r.duplicates + batch.duplicates,
              rejected: batch.rejected.length,
            },
            200,
          );
        } catch (e) {
          if (isTransientDbError(e)) {
            d.log.error('chain.ingest_failed_transient', { delivery_id: deliveryId, err: e });
            return c.json(
              errorBody('INTERNAL', 'Database unavailable; retry.', true, c.get('requestId'), {
                reason: 'db_unavailable',
              }),
              503,
            );
          }
          // Deterministic: a retry would fail the same way and pause the Stream. Keep the rows.
          d.log.error('chain.ingest_failed_permanent', {
            alert: true,
            delivery_id: deliveryId,
            err: e,
          });
          try {
            const kept = await storeUnprojected(
              d,
              batch.events,
              { deliveryId },
              isTransientDbError,
            );
            if (kept.failed)
              d.log.error('chain.ingest_rows_dropped', {
                alert: true,
                delivery_id: deliveryId,
                failed: kept.failed,
              });
            return c.json({ ok: false, reason: 'projector_failed', ...kept }, 200);
          } catch (e2) {
            d.log.error('chain.ingest_failed_transient', { delivery_id: deliveryId, err: e2 });
            return c.json(
              errorBody('INTERNAL', 'Database unavailable; retry.', true, c.get('requestId'), {
                reason: 'db_unavailable',
              }),
              503,
            );
          }
        }
      });
    },
  };
}

export const chainRoutes: RouteModule = createChainRoutes();
