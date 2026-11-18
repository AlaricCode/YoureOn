// The "demo health" strip along the bottom of the stage (API-CONTRACT §2.17 GET /v1/demo/health):
// fee payer SOL, free durable nonces, RPC and DB latency, the last server tx. Polled every 10 s
// with the stage session's own bearer, which the server accepts under DEMO_MODE (its 'demo'
// scope, apps/server/src/demo/routes.ts), so the projector URL needs no admin key. A demo key
// in the fragment (#demo=<DEMO_ADMIN_TOKEN>) is still sent when given. The parse is tolerant:
// fields the server does not send show as "—" instead of failing the strip.
import { z } from 'zod/v4';

export const DEMO_HEALTH_PATH = '/v1/demo/health';
export const DEMO_KEY_HEADER = 'X-YO-Demo-Key';
export const HEALTH_POLL_MS = 10_000;

const num = z.number().nullable().catch(null);
export const DemoHealth = z.looseObject({
  chain_configured: z.boolean().catch(false),
  lock_signer: z.string().nullable().catch(null).optional(),
  rpc: z.string().nullable().catch(null),
  fee_payer: z.string().nullable().catch(null),
  fee_payer_sol: num,
  nonce_pool: z
    .looseObject({
      size: z.number().catch(0),
      free: z.number().catch(0),
      leased: z.number().catch(0),
      advancing: z.number().catch(0),
      retired: z.number().catch(0),
    })
    .catch({ size: 0, free: 0, leased: 0, advancing: 0, retired: 0 }),
  last_tx: z
    .looseObject({
      kind: z.string(),
      status: z.string(),
      signature: z.string().nullable(),
      err: z.unknown().optional(),
    })
    .nullable()
    .catch(null),
  rpc_ms: num,
  rpc_error: z.string().nullable().catch(null),
  db_ms: num,
});
export type DemoHealth = z.infer<typeof DemoHealth>;

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'idle';
export interface HealthItem {
  key: string;
  label: string;
  value: string;
  level: HealthLevel;
}

/** Thresholds: a lock costs ~0.00001 SOL in fees plus ~0.004 SOL of rent the close returns. */
export const HEALTH_LIMITS = {
  solWarn: 0.5,
  solBad: 0.05,
  noncesWarn: 3,
  rpcWarnMs: 800,
  dbWarnMs: 300,
} as const;

export function healthItems(h: DemoHealth): HealthItem[] {
  const items: HealthItem[] = [];
  const sol = h.fee_payer_sol;
  items.push({
    key: 'sol',
    label: 'Fee payer',
    value: sol === null ? (h.chain_configured ? '—' : 'no chain') : `${sol.toFixed(3)} SOL`,
    level:
      sol === null
        ? h.chain_configured
          ? 'warn'
          : 'bad'
        : sol < HEALTH_LIMITS.solBad
          ? 'bad'
          : sol < HEALTH_LIMITS.solWarn
            ? 'warn'
            : 'ok',
  });
  const free = h.nonce_pool.free;
  items.push({
    key: 'nonces',
    label: 'Nonces',
    value: `${free} free / ${h.nonce_pool.size}`,
    level: free === 0 ? 'bad' : free < HEALTH_LIMITS.noncesWarn ? 'warn' : 'ok',
  });
  items.push({
    key: 'rpc',
    label: 'RPC',
    value: h.rpc_error ? 'error' : h.rpc_ms === null ? '—' : `${h.rpc_ms} ms`,
    level: h.rpc_error
      ? 'bad'
      : h.rpc_ms === null
        ? 'idle'
        : h.rpc_ms > HEALTH_LIMITS.rpcWarnMs
          ? 'warn'
          : 'ok',
  });
  items.push({
    key: 'db',
    label: 'DB',
    value: h.db_ms === null ? '—' : `${h.db_ms} ms`,
    level: h.db_ms === null ? 'idle' : h.db_ms > HEALTH_LIMITS.dbWarnMs ? 'warn' : 'ok',
  });
  if (h.last_tx)
    items.push({
      key: 'last',
      label: 'Last tx',
      value: `${h.last_tx.kind} ${h.last_tx.status}`,
      level: h.last_tx.status === 'failed' ? 'warn' : 'ok',
    });
  return items;
}

export class DemoHealthError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404 ? 'demo health 404 (demo key or DEMO_MODE)' : `demo health HTTP ${status}`,
    );
    this.name = 'DemoHealthError';
  }
}

/**
 * GET /v1/demo/health with the stage bearer (and the admin key when the page has one); 404 means
 * DEMO_MODE is off, or neither credential is accepted.
 */
export async function fetchDemoHealth(
  serverUrl: string,
  auth: { token?: string | null; demoKey?: string | null },
  doFetch: typeof fetch = fetch,
): Promise<DemoHealth> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.demoKey) headers[DEMO_KEY_HEADER] = auth.demoKey;
  const res = await doFetch(new URL(DEMO_HEALTH_PATH, serverUrl).toString(), { headers });
  if (!res.ok) throw new DemoHealthError(res.status);
  return DemoHealth.parse(await res.json());
}
