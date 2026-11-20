// Which database errors a retry can fix. Shared by the webhook route (503 vs 200) and the projector
// (a per-bet savepoint rethrows transient errors so the whole delivery is retried, and contains
// deterministic ones so one bad bet cannot sink the batch).
//
// Spec: docs/planning/API-CONTRACT.md §5.3.

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

/** The SQLSTATE (or driver code) and constraint name of a DB error, for audit rows and logs. */
export function dbErrorSummary(e: unknown): {
  code: string | null;
  constraint: string | null;
  message: string;
} {
  let constraint: string | null = null;
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 4; i++) {
    const c =
      (x as { constraint_name?: unknown; constraint?: unknown }).constraint_name ??
      (x as { constraint?: unknown }).constraint;
    if (typeof c === 'string') {
      constraint = c;
      break;
    }
    x = (x as { cause?: unknown }).cause;
  }
  let message = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) message = cause.message;
  return { code: errorCodes(e)[0] ?? null, constraint, message: message.slice(0, 200) };
}
