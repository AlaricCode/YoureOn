import { customType, timestamp } from 'drizzle-orm/pg-core';

/** `bytea` (Drizzle 0.45 has no built-in). postgres.js returns a Buffer, which is a Uint8Array. */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

/** `timestamptz` as a JS Date (DATA-MODEL §1 `ts`). */
export const tstz = () => timestamp({ withTimezone: true, mode: 'date' });
