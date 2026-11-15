// Named format CHECKs for the logical types of DATA-MODEL §1 (CHECKs, not DOMAINs:
// Drizzle has no domain support). Column names are written raw so the generated SQL is
// exactly `CHECK (col ~ '...')`; NULL passes a CHECK, so nullable columns need no guard.
import { check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const HEX32_RE = '^[0-9a-f]{64}$';
export const PUBKEY_RE = '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
export const TX_SIG_RE = '^[1-9A-HJ-NP-Za-km-z]{64,88}$';

const fmt = (re: string) => (table: string, column: string) =>
  check(`${table}_${column}_fmt`, sql.raw(`${column} ~ '${re}'`));

export const hex32Check = fmt(HEX32_RE);
export const pubkeyCheck = fmt(PUBKEY_RE);
export const txSigCheck = fmt(TX_SIG_RE);
